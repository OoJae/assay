import 'dotenv/config'
import * as dotenv from 'dotenv'
import { readFileSync } from 'node:fs'
import { provision, triggers } from '@openserv-labs/client'
import { privateKeyToAccount } from 'viem/accounts'
import { assayAgent } from '../src/agent/assay-agent.js'
import { populatedSecretCount } from '../src/lib/envfile.js'

/**
 * Provision the $0.25 named contract audit as its OWN workflow.
 *
 * A separate workflow, deliberately, rather than a second trigger on the existing one. Workflow
 * sync is declarative: syncing a trigger list that omitted the live $0.01 trigger would delete it,
 * and recreating it would mint a new token — breaking the endpoint URL published in the agent card
 * and the README. The two tiers share an agent and nothing else.
 *
 * Authenticates with the user API key from .openserv.json plus an explicit walletAddress, which
 * skips SIWE entirely. Signing in with the new WALLET_PRIVATE_KEY instead would create a different
 * OpenServ account that cannot see anything the original one owns.
 *
 * SECRETS ARE CHECKED BEFORE AND AFTER. provision() writes .env with its own line-replacing
 * writer, outside the guard in src/lib/envfile.ts, and the last loss of a signing key happened
 * during exactly this kind of env-handling work.
 */
dotenv.config({ override: true })

const pk = process.env.WALLET_PRIVATE_KEY as `0x${string}` | undefined
if (!pk) throw new Error('WALLET_PRIVATE_KEY missing — run pnpm wallets')
const walletAddress = privateKeyToAccount(pk).address

const st = JSON.parse(readFileSync('.openserv.json', 'utf8')) as { userApiKey?: string }
if (!st.userApiKey) throw new Error('.openserv.json has no userApiKey')

const secretsBefore = populatedSecretCount()
const keysBefore = { w: process.env.WALLET_PRIVATE_KEY, b: process.env.BUYER_PRIVATE_KEY }

const result = await provision({
  userApiKey: st.userApiKey,
  walletAddress,
  agent: {
    instance: assayAgent,
    name: 'assay',
    description:
      'Independent valuation-integrity audit for agents on Robinhood Chain. Returns the corrected ' +
      'position for ERC-8056 Stock Tokens, audits whether a counterparty contract is ' +
      'multiplier-aware, and refuses explicitly when a reading is unsafe to act on.',
  },
  workflow: {
    name: 'ASSAY Contract Audit',
    goal:
      'Given an address on Robinhood Chain 4663, determine whether the contract deployed there can ' +
      'correctly handle ERC-8056 Stock Tokens. Resolve EIP-1967, beacon and EIP-1167 proxies to ' +
      'their implementation first, then report whether that bytecode references uiMultiplier(), ' +
      'which divergent-multiplier Stock Tokens the address holds, and how many share-equivalents go ' +
      'unaccounted for if those balances are read as share counts. A NOT_AWARE verdict establishes ' +
      'the absence of a call, not the presence of a mistake, and must be reported that way. An ' +
      'unresolvable proxy must be reported as PROXY_UNRESOLVED with no verdict at all.',
    trigger: triggers.x402({
      name: 'check-contract',
      description:
        'Named ERC-8056 integrator audit: is this contract multiplier-aware, and what is it exposed on',
      price: '0.25',
      timeout: 600,
      walletAddress,
      input: {
        address: {
          type: 'string',
          title: 'Contract address',
          description: '0x-prefixed address on Robinhood Chain 4663',
        },
      },
    }),
    task: {
      description:
        'Call check_contract with the supplied address and return its JSON verbatim, leading with ' +
        'the verdict and the interpretation field.',
    },
  },
})

dotenv.config({ override: true })
const secretsAfter = populatedSecretCount()
const keysAfter = { w: process.env.WALLET_PRIVATE_KEY, b: process.env.BUYER_PRIVATE_KEY }

console.log('agent      ', result.agentId)
console.log('workflow   ', result.workflowId)
console.log('trigger    ', result.triggerId)
console.log('endpoint   ', result.apiEndpoint)
console.log('paywall    ', result.paywallUrl)
console.log('payTo      ', walletAddress)
console.log(`\nsecrets    ${secretsBefore} -> ${secretsAfter}`)
const intact = keysAfter.w === keysBefore.w && keysAfter.b === keysBefore.b
console.log(`keys       ${intact ? 'UNCHANGED' : 'CHANGED — restore from ~/.assay/env.backup NOW'}`)
if (!intact || secretsAfter < secretsBefore) process.exit(1)
