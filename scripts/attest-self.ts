import 'dotenv/config'
import * as dotenv from 'dotenv'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { privateKeyToAccount } from 'viem/accounts'
import { sweep } from '../src/sweep/detect.js'
import { METHODOLOGY_VERSION } from '../src/adjudicate/methodology.js'
import {
  VALIDATION_REGISTRY,
  validationRegistryAbi,
} from '../src/attest/registry.js'
import {
  buildEvidenceDocument,
  hashDocument,
  publicBase,
  walletFor,
  scoreFor,
  type AttestationTag,
} from '../src/attest/index.js'

/**
 * ASSAY rates itself first.
 *
 * The publication ethics say we publish our own grade before grading anyone else, so this is the
 * flow's first real use: agent 95265 requests validation from ASSAY, and ASSAY answers on-chain.
 *
 * Both legs are signed by the same key here because subject and validator are the same party —
 * that is the point of self-rating, and it is stated plainly rather than dressed up as independent.
 *
 * Run with --dry to print everything and write the evidence document without sending transactions.
 */
dotenv.config({ override: true })
const dry = process.argv.includes('--dry')

const pk = process.env.WALLET_PRIVATE_KEY as `0x${string}` | undefined
if (!pk) throw new Error('WALLET_PRIVATE_KEY missing')
const account = privateKeyToAccount(pk)

const state = JSON.parse(readFileSync('data/erc8004.json', 'utf8')) as { agentId: string }
const agentId = BigInt(state.agentId)

// ---- 1. Run the real pipeline against ourselves -----------------------------------------------
// ASSAY's own product surface is the wall and the MCP tools. The honest question is: does ASSAY
// itself commit the defects it grades others for? It reads uiMultiplier and converts explicitly in
// src/lib/position.ts, and it refuses when a feed is missing or stale — so on its own rubric the
// operation IS stated and handling IS documented and arithmetically sound. That is gate 4 -> CLEAN.
// The withheld/critical findings below are about the CHAIN, not about ASSAY's handling of it.
console.log('sweeping to build our own evidence…')
const r = await sweep({ symbols: ['CRWD', 'NVDA', 'SPY'] })
console.log(`  ${r.findings.length} verified findings at block ${r.blockNumber}`)

const tag: AttestationTag = 'CLEAN'
const rationale =
  'ASSAY converts share-equivalents explicitly as balance * uiMultiplier() / 1e36 in ' +
  'src/lib/position.ts, never mixes an off-chain share price with an on-chain token quantity, and ' +
  'returns a non-null refusalReason when a Chainlink feed is absent, paused, or past its published ' +
  'heartbeat. Under gate 4 the operation is explicitly stated and the handling is same-surface, ' +
  'same-defect-class and arithmetically sound. Self-issued: the subject and the validator are the ' +
  'same key, which is disclosed rather than presented as independent assurance.'

const doc = buildEvidenceDocument(
  state.agentId,
  tag,
  rationale,
  METHODOLOGY_VERSION,
  r.blockNumber,
  r.findings,
)
const serialised = JSON.stringify(doc, null, 2)
const responseHash = hashDocument(serialised)

mkdirSync('web/public/attestations', { recursive: true })
const filename = `web/public/attestations/${state.agentId}.json`
writeFileSync(filename, serialised)
const responseURI = `https://assay-steel.vercel.app/attestations/${state.agentId}.json`
const requestURI = 'https://github.com/OoJae/assay#publication-ethics'

console.log(`\nevidence document  ${filename}`)
console.log(`responseURI        ${responseURI}`)
console.log(`responseHash       ${responseHash}`)
console.log(`tag / score        ${tag} / ${scoreFor(tag)}`)

if (dry) {
  console.log('\n--dry: no transactions sent')
  process.exit(0)
}

const pub = publicBase()
const wallet = walletFor(pk)

// ---- 2. The subject requests validation -------------------------------------------------------
// requestHash binds the request to what is being asked about; we use the hash of the requestURI.
const requestHash = hashDocument(requestURI)
console.log(`\nrequestHash        ${requestHash}`)

/**
 * getValidationStatus REVERTS for an unknown requestHash rather than returning zeroes, so it
 * cannot be used as a plain existence check — a revert here means "no request yet", not an error.
 */
let alreadyRequested = false
try {
  const existing = (await pub.readContract({
    address: VALIDATION_REGISTRY,
    abi: validationRegistryAbi,
    functionName: 'getValidationStatus',
    args: [requestHash],
  })) as readonly [`0x${string}`, bigint, number, `0x${string}`, string, bigint]
  alreadyRequested = existing[0] !== '0x0000000000000000000000000000000000000000'
} catch {
  alreadyRequested = false
}

if (!alreadyRequested) {
  console.log('\nsubmitting validationRequest…')
  const reqTx = await wallet.writeContract({
    address: VALIDATION_REGISTRY,
    abi: validationRegistryAbi,
    functionName: 'validationRequest',
    args: [account.address, agentId, requestURI, requestHash],
  })
  const rc = await pub.waitForTransactionReceipt({ hash: reqTx })
  console.log(`  ${rc.status} https://basescan.org/tx/${reqTx}`)
} else {
  console.log('\nvalidationRequest already on-chain — skipping')
}

// ---- 3. GUARD: the URI must already serve bytes that hash to responseHash -----------------------
//
// The whole point of responseHash is that a third party can fetch responseURI, hash it, and confirm
// the attestation refers to the evidence we actually published. Writing the hash BEFORE deploying
// the document silently breaks that — which is exactly what happened on the first run: the chain
// carried the hash of a freshly generated document while the URI still served the previous one.
//
// So this is now a hard precondition, not a convention.
console.log('\nverifying the published document matches responseHash…')
const servedRes = await fetch(responseURI, { cache: 'no-store' })
if (!servedRes.ok) {
  console.error(`  responseURI is not reachable (HTTP ${servedRes.status}). Deploy the document first.`)
  process.exit(1)
}
const servedHash = hashDocument(await servedRes.text())
if (servedHash !== responseHash) {
  console.error(`  MISMATCH — refusing to attest.`)
  console.error(`    served   ${servedHash}`)
  console.error(`    computed ${responseHash}`)
  console.error(`  Deploy ${filename} to ${responseURI}, then re-run.`)
  process.exit(1)
}
console.log('  match — the attestation will be verifiable')

// ---- 4. ASSAY answers -------------------------------------------------------------------------
console.log('submitting validationResponse…')
const resTx = await wallet.writeContract({
  address: VALIDATION_REGISTRY,
  abi: validationRegistryAbi,
  functionName: 'validationResponse',
  args: [requestHash, scoreFor(tag), responseURI, responseHash, tag],
})
const rc2 = await pub.waitForTransactionReceipt({ hash: resTx })
console.log(`  ${rc2.status} https://basescan.org/tx/${resTx}`)

const validations = (await pub.readContract({
  address: VALIDATION_REGISTRY,
  abi: validationRegistryAbi,
  functionName: 'getAgentValidations',
  args: [agentId],
})) as readonly `0x${string}`[]
console.log(`\ngetAgentValidations(${agentId}) -> ${validations.length} entr${validations.length === 1 ? 'y' : 'ies'}`)

writeFileSync(
  'data/attestation-self.json',
  JSON.stringify(
    { agentId: state.agentId, tag, score: scoreFor(tag), requestHash, responseURI, responseHash, responseTx: resTx },
    null,
    2,
  ),
)
console.log('recorded in data/attestation-self.json')
