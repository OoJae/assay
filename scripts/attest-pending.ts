import 'dotenv/config'
import { validatorRequests } from '../src/attest/index.js'

/**
 * Inbound validation requests, and which are still unanswered.
 *
 * `pendingRequests()` previously had ZERO callers, which is how its answered-detection bug —
 * keying off `lastUpdate`, which the registry stamps at REQUEST time — survived: nothing ever ran
 * it. ASSAY only ever writes a verdict a subject asked for, so this is the front door of the
 * solicited-attestation flow, and it needs to be a command someone actually runs.
 */
const validator = (process.argv[2] ?? '0x0C3A19bEa92480A978f2A358E8E1e87b9DAD14B5') as `0x${string}`

const all = await validatorRequests(validator)
const pending = all.filter((r) => !r.answered)

console.log(`validator ${validator}`)
console.log(`requests: ${all.length}   pending: ${pending.length}\n`)

for (const r of all) {
  console.log(`${r.answered ? '[ANSWERED]' : '[ PENDING ]'} agent ${r.agentId}  ${r.requestHash}`)
  if (r.answered) console.log(`            tag=${r.tag} score=${r.response} responseHash=${r.responseHash}`)
}

if (!all.length) {
  console.log('nothing inbound. ASSAY never initiates a verdict about a named party;')
  console.log('a subject calls validationRequest() naming this address as validator first.')
}
