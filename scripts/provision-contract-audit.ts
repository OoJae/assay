import 'dotenv/config'
import * as dotenv from 'dotenv'
import { readFileSync } from 'node:fs'
import { provision, triggers } from '@openserv-labs/client'
import { privateKeyToAccount } from 'viem/accounts'
import { assayAgent } from '../src/agent/assay-agent.js'
import { populatedSecretCount, assertEnvPrivate, ENV_BACKUP_PATH } from '../src/lib/envfile.js'
import { backupOpenServState, OPENSERV_BACKUP_PATH } from '../src/lib/openserv-state.js'

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
 * SECRETS ARE CHECKED BEFORE AND AFTER. provision() has its own line-replacing .env writer,
 * outside the guard in src/lib/envfile.ts. With a userApiKey passed it has no reason to reach it,
 * but the last loss of a signing key happened during exactly this kind of env-handling work, so
 * the check stays as a tripwire, and .openserv.json gets a dated copy on both sides of the call.
 */
dotenv.config({ override: true })
assertEnvPrivate()

const pk = process.env.WALLET_PRIVATE_KEY as `0x${string}` | undefined
if (!pk) throw new Error('WALLET_PRIVATE_KEY missing — run pnpm wallets')
const walletAddress = privateKeyToAccount(pk).address

const st = JSON.parse(readFileSync('.openserv.json', 'utf8')) as { userApiKey?: string }
if (!st.userApiKey) throw new Error('.openserv.json has no userApiKey')

const secretsBefore = populatedSecretCount()
const keysBefore = { w: process.env.WALLET_PRIVATE_KEY, b: process.env.BUYER_PRIVATE_KEY }
const buyerBefore = /^0x[0-9a-fA-F]{64}$/.test(keysBefore.b ?? '')
  ? privateKeyToAccount(keysBefore.b as `0x${string}`).address
  : null
backupOpenServState()

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

const stateBackup = backupOpenServState()
dotenv.config({ override: true })
const secretsAfter = populatedSecretCount()
const keysAfter = { w: process.env.WALLET_PRIVATE_KEY, b: process.env.BUYER_PRIVATE_KEY }

console.log('agent      ', result.agentId)
console.log('workflow   ', result.workflowId)
console.log('trigger    ', result.triggerId)
console.log('endpoint   ', result.apiEndpoint)
console.log('paywall    ', result.paywallUrl)
console.log('payTo      ', walletAddress)
console.log('backup     ', stateBackup)
console.log(`\nsecrets    ${secretsBefore} -> ${secretsAfter}`)
const intact = keysAfter.w === keysBefore.w && keysAfter.b === keysBefore.b
console.log(`keys       ${intact ? 'UNCHANGED' : 'CHANGED'}`)
if (!intact) {
  // Not "restore the backup NOW". The rolling backup once held a test fixture key that anyone can
  // spend from in place of the owner key, and restoring it blind, then running `pnpm payto`, would
  // have sent every payment there. So: the addresses to check a candidate against, and where the
  // dated copies are.
  console.error(
    `\nBefore this run WALLET_PRIVATE_KEY derived to ${walletAddress}` +
      (buyerBefore ? ` and BUYER_PRIVATE_KEY to ${buyerBefore}` : '') +
      `.\nEarlier versions of .env are in the dated copies ${ENV_BACKUP_PATH}.<time>, and of ` +
      `.openserv.json in ${OPENSERV_BACKUP_PATH}.<time>. Never restore one blind: derive the ` +
      `address of each key in it first, and use it only if that address matches the one above.`,
  )
}
if (!intact || secretsAfter < secretsBefore) process.exit(1)
