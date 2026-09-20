import 'dotenv/config'
import * as dotenv from 'dotenv'
import { provision, triggers } from '@openserv-labs/client'
import { privateKeyToAccount } from 'viem/accounts'
import { assayAgent } from '../src/agent/assay-agent.js'

/**
 * Creates the ASSAY agent + workflow + x402 paywall on OpenServ.
 *
 * provision() is idempotent — safe to re-run. On the first run it mints a wallet and writes
 * WALLET_PRIVATE_KEY into .env, which is why we reload env with override afterwards.
 */
const result = await provision({
  agent: {
    instance: assayAgent,
    name: 'assay',
    description:
      'Independent valuation-integrity audit for agents on Robinhood Chain. Returns the ' +
      'corrected position for ERC-8056 Stock Tokens, with oracle-hygiene flags and an ' +
      'explicit refusal when a reading is unsafe to act on.',
  },
  workflow: {
    name: 'ASSAY Valuation Integrity',
    goal:
      'Given a Robinhood Chain Stock Token ticker and a holder address, return the corrected ' +
      'position for that holder: the raw ERC-20 balance, the ERC-8056 uiMultiplier, the ' +
      'share-equivalent count, the multiplier-adjusted Chainlink token price, the derived ' +
      'underlying share price, and the correct position value in USD. Always include the ' +
      'oracle-hygiene flags — Chainlink feed age against its published heartbeat, whether the ' +
      'feed exists at all, and oraclePaused() — and always surface an explicit refusalReason ' +
      'when the reading is not safe to act on, such as a missing price feed or a feed past its ' +
      'heartbeat. The caller is an autonomous agent about to value, liquidate or collateralise ' +
      'a tokenized equity position, so correctness and an honest refusal matter more than ' +
      'always producing a number.',
    trigger: triggers.x402({
      name: 'true-position',
      description: 'Corrected ERC-8056 position plus oracle hygiene for a Robinhood Chain Stock Token',
      price: '0.01',
      timeout: 600,
      input: {
        symbol: {
          type: 'string',
          title: 'Ticker',
          description: 'Robinhood Chain Stock Token symbol, e.g. NVDA, SPY, CRWD',
        },
        holder: {
          type: 'string',
          title: 'Holder address',
          description: '0x-prefixed address holding the token on Robinhood Chain',
        },
      },
    }),
    task: {
      description:
        'Call true_position with the supplied symbol and holder, and return its JSON verbatim, ' +
        'leading with refusalReason when one is present.',
    },
  },
})

dotenv.config({ override: true })

const pk = process.env.WALLET_PRIVATE_KEY
const addr = pk ? privateKeyToAccount(pk as `0x${string}`).address : '(none)'

console.log('\n=== PROVISIONED ===')
console.log('agentId      ', result.agentId)
console.log('workflowId   ', result.workflowId)
console.log('triggerId    ', result.triggerId)
console.log('paywallUrl   ', result.paywallUrl)
console.log('apiEndpoint  ', result.apiEndpoint)
console.log('\n=== WALLET A (service owner) — fund with ~0.001 ETH on Base 8453 ===')
console.log(addr)
console.log('\nERC-8004 mint costs well under $0.01; 0.001 ETH is ~100x headroom.')
