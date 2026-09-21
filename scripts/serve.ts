import 'dotenv/config'
import * as dotenv from 'dotenv'
import { run } from '@openserv-labs/sdk'
import { provision, triggers } from '@openserv-labs/client'
import { assayAgent } from '../src/agent/assay-agent.js'

/**
 * Start the ASSAY agent so the platform can actually execute paid work.
 *
 * This matters more than it looks: the x402 trigger takes payment and then dispatches a task to
 * the agent. If no agent is listening, the buyer is charged and the workflow times out with no
 * result — a paid call that returns nothing. So the agent must be up BEFORE any payment is made.
 *
 * run() opens a WebSocket tunnel to OpenServ, so no public URL or ngrok is needed locally. For
 * always-on operation this belongs on a VPS.
 *
 * provision() is idempotent, so re-running is safe and reuses the existing agent, workflow,
 * trigger and wallet from .openserv.json / .env.
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
      description:
        'Corrected ERC-8056 position plus oracle hygiene for a Robinhood Chain Stock Token',
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

console.log('agent      ', result.agentId)
console.log('workflow   ', result.workflowId)
console.log('paywall    ', result.paywallUrl)
console.log('endpoint   ', result.apiEndpoint)
console.log('\nstarting agent — leave this running, then pay from another shell\n')

await run(assayAgent)
