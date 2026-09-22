import 'dotenv/config'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { sweep } from '../src/sweep/detect.js'
import { METHODOLOGY_VERSION } from '../src/sweep/detect.js'
import {
  buildEvidenceDocument,
  hashDocument,
  scoreFor,
  type AttestationTag,
  type SelfAssessmentCriterion,
} from '../src/attest/index.js'

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
const state = JSON.parse(readFileSync('data/erc8004.json', 'utf8')) as {
  agentId: string
  agentURI: string
  owner: string
}

console.log('sweeping to establish that the machine ran…')
const r = await sweep({ symbols: ['CRWD', 'NVDA', 'SPY'] })
console.log(`  ${r.findings.length} verified findings at block ${r.blockNumber}`)

/**
 * The corpus is AGGREGATE ONLY.
 *
 * No symbol, no contract address, no severity, no third-party statement goes into a document that
 * gets hashed on-chain. ASSAY's publication rule is that unsolicited statements about a named
 * party stay off-chain, and this is the only on-chain write it makes. The findings themselves are
 * on the wall, where that rule permits them.
 */
const corpus = {
  sweptAtBlock: r.blockNumber,
  assetsScanned: r.assetsScanned,
  findingsPublished: r.findings.length,
  citationsChecked: r.findings.reduce((n, f) => n + f.verification.checked, 0),
  citationsReproduced: r.findings.reduce((n, f) => n + f.verification.reproduced, 0),
  findingsWithheld: r.rejected.length,
}

/**
 * Each row is a claim about ASSAY's OWN handling, with the file a reader opens to check it.
 * Nothing here is an output of the SERV adjudicator, and `basis` says so in the document.
 */
const assessment: SelfAssessmentCriterion[] = [
  {
    question:
      'Does ASSAY itself ever present a raw ERC-20 balance as a share count — the defect it grades?',
    finding:
      'No. truePosition() returns rawBalance, tokenUnits and shareEquivalents as three separate ' +
      'fields, computes shareEquivalents as tokenUnits * uiMultiplier/1e18, and never labels a raw ' +
      'balance as shares on any surface.',
    source: 'src/lib/position.ts',
  },
  {
    question: 'Does ASSAY ever mix an off-chain share price with an on-chain token quantity?',
    finding:
      'No. positionValueUsd is tokenUnits * the Chainlink TOKEN price, which is already ' +
      'multiplier-adjusted. The off-chain REST quote is used only to quantify the cross-surface ' +
      'gap and is disclosed under offChainSources, outside the byte-verified guarantee.',
    source: 'src/lib/position.ts, src/sweep/detect.ts',
  },
  {
    question: 'Does ASSAY refuse when a check it relies on did not complete?',
    finding:
      'Yes. A failed feed read, a failed decimals() read, a failed oraclePaused() read, a ' +
      'non-positive answer and an incomplete round each set refusalReason and drop confidence ' +
      'below high. A previous version returned confidence "high" with refusalReason null on a ' +
      'failed read; that is fixed and covered by an offline test matrix.',
    source: 'src/lib/position.ts, test/position.test.ts',
  },
  {
    question: 'Is every citation ASSAY publishes actually re-fetched and byte-compared?',
    finding:
      `Yes, and verification is fused into the sweep at each asset's own block because this RPC ` +
      'prunes state within minutes. The corpus below records the counts for this run. Citations ' +
      'that do not reproduce are withheld with a reason, never softened.',
    source: 'src/verify/index.ts, scripts/verify-attestation.ts',
  },
  {
    question: 'Does ASSAY assert a cause it has not established?',
    finding:
      'Not any longer, in the two places it did. Cohort market-closure conclusions now require an ' +
      '80% read quorum and report ORACLE_STALE_INDETERMINATE otherwise, and the cross-surface ' +
      'residual is reported as an observation unless it is small relative to the effect.',
    source: 'src/sweep/detect.ts',
  },
]

const limitations = [
  'SELF-ISSUED. The subject and the validator are the same key. This is a disclosure, not assurance.',
  'The tag is a documented self-assessment, not an output of the SERV adjudicator.',
  'The corpus covers a three-symbol run, not the full 195-asset sweep published on the wall.',
  'Citations are re-fetchable only while this RPC still serves the cited block — roughly 5k to ' +
    '20k blocks at ~100ms each. Past that they are unchecked here, which is not the same as false.',
]

const tag: AttestationTag = 'CLEAN'
// Derived from the sweep, not the wall clock, so the document is reproducible.
const issuedAt = r.observedAt

const doc = buildEvidenceDocument({
  agentId: state.agentId,
  agentName: 'ASSAY Valuation Integrity',
  agentURI: state.agentURI,
  validatorAddress: state.owner,
  tag,
  methodologyVersion: METHODOLOGY_VERSION,
  assessment,
  corpus,
  limitations,
  issuedAt,
})

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
console.log(`corpus       ${corpus.citationsReproduced}/${corpus.citationsChecked} citations at block ${corpus.sweptAtBlock}`)
console.log(`\nNEXT: deploy the wall, then run  pnpm attest:submit`)
