import 'dotenv/config'
import * as dotenv from 'dotenv'
import { readFileSync, writeFileSync } from 'node:fs'
import { privateKeyToAccount } from 'viem/accounts'
import { VALIDATION_REGISTRY, validationRegistryAbi } from '../src/attest/registry.js'
import { hashDocument, publicBase, walletFor } from '../src/attest/index.js'

/**
 * STEP 2 of 2: submit the attestation for the document ALREADY on disk and ALREADY published.
 *
 * This never regenerates the document. It hashes the exact bytes on disk, requires that the live
 * responseURI serves byte-identical content, and only then signs. That ordering is the whole
 * guarantee: responseHash is worthless unless the bytes it commits to are the bytes a third party
 * can fetch.
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
  responseHash: `0x${string}`
  filename: string
}
const agentId = BigInt(st.agentId)

// Hash the bytes on disk — never a freshly built object.
const onDisk = readFileSync(pending.filename, 'utf8')
const responseHash = hashDocument(onDisk)
if (responseHash !== pending.responseHash) {
  console.error(`the file changed since attest:build\n  built ${pending.responseHash}\n  disk  ${responseHash}`)
  process.exit(1)
}

const responseURI = `https://assay-steel.vercel.app/attestations/${st.agentId}.json`
const requestURI = 'https://github.com/OoJae/assay#publication-ethics'
const requestHash = hashDocument(requestURI)

console.log(`agentId      8453:${st.agentId}`)
console.log(`responseURI  ${responseURI}`)
console.log(`responseHash ${responseHash}`)

// HARD PRECONDITION: the published bytes must match, or the attestation proves nothing.
const servedRes = await fetch(responseURI, { cache: 'no-store' })
if (!servedRes.ok) {
  console.error(`\nresponseURI is not reachable (HTTP ${servedRes.status}). Deploy first.`)
  process.exit(1)
}
const servedHash = hashDocument(await servedRes.text())
if (servedHash !== responseHash) {
  console.error(`\nMISMATCH — refusing to attest.\n  served ${servedHash}\n  disk   ${responseHash}`)
  console.error(`Deploy ${pending.filename}, then re-run.`)
  process.exit(1)
}
console.log('published bytes match — proceeding\n')

const pub = publicBase()
const wallet = walletFor(pk)

let alreadyRequested = false
try {
  const ex = (await pub.readContract({
    address: VALIDATION_REGISTRY, abi: validationRegistryAbi,
    functionName: 'getValidationStatus', args: [requestHash],
  })) as readonly [`0x${string}`, bigint, number, `0x${string}`, string, bigint]
  alreadyRequested = ex[0] !== '0x0000000000000000000000000000000000000000'
} catch {
  // getValidationStatus reverts on an unknown hash rather than returning zeroes.
  alreadyRequested = false
}

if (!alreadyRequested) {
  console.log('submitting validationRequest…')
  const t = await wallet.writeContract({
    address: VALIDATION_REGISTRY, abi: validationRegistryAbi,
    functionName: 'validationRequest', args: [account.address, agentId, requestURI, requestHash],
  })
  console.log(`  ${(await pub.waitForTransactionReceipt({ hash: t })).status} https://basescan.org/tx/${t}`)
} else {
  console.log('validationRequest already on-chain — reusing it')
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

writeFileSync('data/attestation-self.json', JSON.stringify(
  { agentId: st.agentId, tag: pending.tag, score: pending.score, requestHash, responseURI, responseHash, responseTx: tx },
  null, 2))
