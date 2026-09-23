import 'dotenv/config'
import { privateKeyToAccount } from 'viem/accounts'
import { validatorRequests } from '../src/attest/index.js'

/**
 * Inbound validation requests, and which are still unanswered.
 *
 * `pendingRequests()` previously had ZERO callers, which is how its answered-detection bug —
 * keying off `lastUpdate`, which the registry stamps at REQUEST time — survived: nothing ever ran
 * it. ASSAY only ever writes a verdict a subject asked for, so this is the front door of the
 * solicited-attestation flow, and it needs to be a command someone actually runs.
 */
/**
 * Defaults to the address of the CURRENT WALLET_PRIVATE_KEY, not a hardcoded one. The hardcoded
 * default was the wallet whose key was lost, so after the replacement this silently listed requests
 * for a validator that can no longer answer anything.
 */
const fromKey = process.env.WALLET_PRIVATE_KEY
  ? privateKeyToAccount(process.env.WALLET_PRIVATE_KEY as `0x${string}`).address
  : undefined
const validator = (process.argv.slice(2).find((a) => !a.startsWith('--')) ?? fromKey) as `0x${string}` | undefined
if (!validator) {
  console.error('no validator address: pass one, or set WALLET_PRIVATE_KEY (pnpm wallets)')
  process.exit(1)
}

/**
 * Bounded. Anyone who mints an agent can name this address as validator, so the inbound list can
 * be grown for free; only the newest --limit requests are read, in one multicall.
 */
const limit = Number(process.argv.find((a) => a.startsWith('--limit='))?.split('=')[1] ?? 50)
const { total, statuses: all } = await validatorRequests(validator, { limit })
const pending = all.filter((r) => !r.answered)

console.log(`validator ${validator}`)
console.log(`requests: ${total}   shown: ${all.length} newest   pending among them: ${pending.length}\n`)

for (const r of all) {
  console.log(`${r.answered ? '[ANSWERED]' : '[ PENDING ]'} agent ${r.agentId}  ${r.requestHash}`)
  if (r.answered) console.log(`            tag=${r.tag} score=${r.response} responseHash=${r.responseHash}`)
}
if (total > all.length) console.log(`\n${total - all.length} older request(s) not read. Pass --limit=N to read more.`)

if (!total) {
  console.log('nothing inbound. ASSAY never initiates a verdict about a named party;')
  console.log('a subject calls validationRequest() naming this address as validator first.')
}
