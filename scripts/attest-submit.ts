import 'dotenv/config'
import * as dotenv from 'dotenv'
import { readFileSync, writeFileSync } from 'node:fs'
import { privateKeyToAccount } from 'viem/accounts'
import { VALIDATION_REGISTRY, validationRegistryAbi } from '../src/attest/registry.js'
import {
  confirmServed,
  hashBytes,
  publicBase,
  requestReuse,
  requestStatus,
  walletFor,
} from '../src/attest/index.js'

/**
 * STEP 2 of 2: submit the attestation for the document ALREADY on disk and ALREADY published.
 *
 * This never regenerates the document. It hashes the exact bytes on disk, requires that the live
 * responseURI serves byte-identical content, and only then signs. That ordering is the whole
 * guarantee: responseHash is worthless unless the bytes it commits to are the bytes a third party
 * can fetch.
 *
 * The same holds for the REQUEST. requestHash is keccak256 of the request document attest:build
 * wrote, re-derived here from the bytes on disk and checked against the live requestURI.
 */
dotenv.config({ override: true })

const pk = process.env.WALLET_PRIVATE_KEY as `0x${string}` | undefined
if (!pk) throw new Error('WALLET_PRIVATE_KEY missing')
const account = privateKeyToAccount(pk)

const st = JSON.parse(readFileSync('data/erc8004.json', 'utf8')) as { agentId: string }
const pending = JSON.parse(readFileSync('data/attestation-pending.json', 'utf8')) as {
  agentId: string
  tag: string
  score: number
  requestHash?: `0x${string}`
  requestFile?: string
  requestURI?: string
  responseHash: `0x${string}`
  filename: string
  responseURI?: string
}

function refuse(...lines: string[]): never {
  for (const l of lines) console.error(l)
  process.exit(1)
}

if (!pending.requestHash || !pending.requestFile || !pending.requestURI || !pending.responseURI) {
  // The 95265 build predates per-request hashes, and it was submitted: data/attestation-self.json.
  refuse('data/attestation-pending.json predates per-request hashes (it is the already-submitted 95265 build).', 'Run attest:build first.')
}
if (pending.agentId !== st.agentId) {
  refuse(`the pending build is for agent ${pending.agentId}, but the canonical identity is ${st.agentId}. Run attest:build again.`)
}
const agentId = BigInt(st.agentId)

// Hash the bytes on disk — never a freshly built object, and never decoded text.
const responseHash = hashBytes(new Uint8Array(readFileSync(pending.filename)))
if (responseHash !== pending.responseHash) {
  refuse(`the file changed since attest:build\n  built ${pending.responseHash}\n  disk  ${responseHash}`)
}
const requestHash = hashBytes(new Uint8Array(readFileSync(pending.requestFile)))
if (requestHash !== pending.requestHash) {
  refuse(`the request changed since attest:build\n  built ${pending.requestHash}\n  disk  ${requestHash}`)
}
const { requestURI, responseURI } = pending

console.log(`agentId      8453:${st.agentId}`)
console.log(`requestURI   ${requestURI}`)
console.log(`requestHash  ${requestHash}`)
console.log(`responseURI  ${responseURI}`)
console.log(`responseHash ${responseHash}`)

// HARD PRECONDITION: the published bytes must match, or the attestation proves nothing.
for (const [label, uri, hash, file] of [
  ['request', requestURI, requestHash, pending.requestFile],
  ['response', responseURI, responseHash, pending.filename],
] as const) {
  const served = await confirmServed(uri, hash)
  if (!served.ok) {
    refuse(
      served.servedHash
        ? `\n${label} MISMATCH — refusing to attest.\n  served ${served.servedHash}\n  disk   ${hash}`
        : `\n${label}URI is not reachable (HTTP ${served.status}). Deploy first.`,
      `Deploy ${file}, then re-run.`,
    )
  }
}
console.log('published bytes match — proceeding\n')

const pub = publicBase()
const wallet = walletFor(pk)

/**
 * Reuse a request only when it is OURS: same validator, same agentId. A request under the same
 * hash that belongs to anyone else is a collision, and signing against it would revert — or worse,
 * attach this response to another identity's request.
 */
const existing = await requestStatus(requestHash)
const reuse = requestReuse(existing, account.address, agentId)
if (reuse === 'collision') {
  refuse(`requestHash ${requestHash} already belongs to validator ${existing!.validator}, agent ${existing!.agentId}.`, 'Run attest:build again for a fresh request.')
}
if (reuse === 'new') {
  console.log('submitting validationRequest…')
  const t = await wallet.writeContract({
    address: VALIDATION_REGISTRY, abi: validationRegistryAbi,
    functionName: 'validationRequest', args: [account.address, agentId, requestURI, requestHash],
  })
  console.log(`  ${(await pub.waitForTransactionReceipt({ hash: t })).status} https://basescan.org/tx/${t}`)
} else {
  console.log('validationRequest already on-chain for this validator and agent — reusing it')
}

// validationResponse has no already-answered guard: the same validator may overwrite
// response/responseHash/tag/lastUpdate. Confirmed in ValidationRegistryUpgradeable.sol.
console.log('submitting validationResponse…')
const tx = await wallet.writeContract({
  address: VALIDATION_REGISTRY, abi: validationRegistryAbi,
  functionName: 'validationResponse',
  args: [requestHash, pending.score, responseURI, responseHash, pending.tag],
})
const rc = await pub.waitForTransactionReceipt({ hash: tx })
console.log(`  ${rc.status} https://basescan.org/tx/${tx}`)

const check = (await pub.readContract({
  address: VALIDATION_REGISTRY, abi: validationRegistryAbi,
  functionName: 'getValidationStatus', args: [requestHash],
})) as readonly [`0x${string}`, bigint, number, `0x${string}`, string, bigint]
console.log(`\non-chain responseHash ${check[3]}`)
console.log(`matches published     ${check[3] === responseHash ? 'YES' : 'NO'}`)

// Keyed by requestHash: data/attestation-self.json is the record of the 95265 attestation and stays.
const record = `data/attestation-self-${requestHash}.json`
writeFileSync(record, JSON.stringify(
  { agentId: st.agentId, tag: pending.tag, score: pending.score, requestHash, requestURI, responseURI, responseHash, responseTx: tx },
  null, 2))
console.log(`recorded in ${record}`)
