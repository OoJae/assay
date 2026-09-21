import 'dotenv/config'
import { readFileSync, writeFileSync } from 'node:fs'
import { mkdirSync } from 'node:fs'
import { sweep } from '../src/sweep/detect.js'
import { METHODOLOGY_VERSION } from '../src/adjudicate/methodology.js'
import { buildEvidenceDocument, hashDocument, scoreFor, type AttestationTag } from '../src/attest/index.js'

/**
 * STEP 1 of 2: build and write the evidence document, print its hash, and STOP.
 *
 * Split deliberately from submission. The previous single script regenerated the document inside
 * the same process that signed, so the bytes on-chain could never match the bytes on disk — and a
 * later --dry run silently overwrote the published artifact, leaving the on-chain hash pointing at
 * bytes that no longer existed anywhere, including in git history.
 *
 * Deploy the file this writes, THEN run attest:submit. Nothing here touches the chain.
 */
const state = JSON.parse(readFileSync('data/erc8004.json', 'utf8')) as { agentId: string }

console.log('sweeping to build evidence…')
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

// Derived from the sweep, not the wall clock, so the document is reproducible.
const issuedAt = r.observedAt

const doc = buildEvidenceDocument(
  state.agentId, tag, rationale, METHODOLOGY_VERSION, r.blockNumber, r.findings, issuedAt,
)
const serialised = JSON.stringify(doc, null, 2)
const responseHash = hashDocument(serialised)

mkdirSync('web/public/attestations', { recursive: true })
const filename = `web/public/attestations/${state.agentId}.json`
writeFileSync(filename, serialised)

writeFileSync(
  'data/attestation-pending.json',
  JSON.stringify({ agentId: state.agentId, tag, score: scoreFor(tag), responseHash, filename, issuedAt }, null, 2),
)

console.log(`\nwrote        ${filename}`)
console.log(`responseHash ${responseHash}`)
console.log(`tag / score  ${tag} / ${scoreFor(tag)}`)
console.log(`\nNEXT: deploy the wall, then run  pnpm attest:submit`)
