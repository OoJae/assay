import { describe, it, expect } from 'vitest'
import {
  buildEvidenceDocument,
  hashDocument,
  scoreFor,
  isAnswered,
  type SelfAttestationInput,
} from '../src/attest/index.js'

/**
 * Offline tests for the attestation primitives.
 *
 * `src/attest/` had ZERO tests while holding the only code in the project that signs an on-chain
 * transaction, and two of its defects — a non-deterministic document, and an answered-detection
 * check keyed off a field the registry stamps at request time — were exactly the kind a cheap
 * unit test catches.
 */

const INPUT: SelfAttestationInput = {
  agentId: '95265',
  agentName: 'ASSAY Valuation Integrity',
  agentURI: 'https://assay-steel.vercel.app/agent-card.json',
  validatorAddress: '0x0C3A19bEa92480A978f2A358E8E1e87b9DAD14B5',
  tag: 'CLEAN',
  methodologyVersion: 'assay-rh-v0.3.0',
  assessment: [{ question: 'q', finding: 'f', source: 'src/lib/position.ts' }],
  corpus: {
    sweptAtBlock: '69217227',
    assetsScanned: 3,
    findingsPublished: 5,
    citationsChecked: 10,
    citationsReproduced: 10,
    findingsWithheld: 0,
  },
  limitations: ['SELF-ISSUED.'],
  issuedAt: '2026-09-22T00:00:00.000Z',
}

describe('buildEvidenceDocument', () => {
  it('is deterministic — the same input hashes to the same bytes', () => {
    // The regression: issuedAt was stamped from the clock and the corpus was re-swept inside the
    // builder, so the on-chain responseHash could never match the bytes served at responseURI.
    const a = JSON.stringify(buildEvidenceDocument(INPUT), null, 2)
    const b = JSON.stringify(buildEvidenceDocument(INPUT), null, 2)
    expect(a).toBe(b)
    expect(hashDocument(a)).toBe(hashDocument(b))
  })

  it('names NO third party anywhere in the document', () => {
    // The on-chain artifact used to embed whole third-party findings by symbol, contract address,
    // severity and accusatory statement — in the one place ASSAY's own rule forbids it.
    const doc = buildEvidenceDocument(INPUT)
    const text = JSON.stringify(doc)
    for (const leak of ['CRWD', 'NVDA', 'SPY', 'SHARE_COUNT', 'critical', '0xea72Ecca']) {
      expect(text).not.toContain(leak)
    }
    expect(Object.keys(doc)).not.toContain('findings')
  })

  it('states on its face that it is self-issued and not machine-adjudicated', () => {
    const doc = buildEvidenceDocument(INPUT)
    expect(doc.selfIssued).toBe(true)
    expect(doc.basis).toBe('documented-self-assessment')
    expect(doc.independence).toMatch(/NONE/)
    expect(doc.limitations.join(' ')).toMatch(/SELF-ISSUED/)
  })

  it('carries aggregate corpus counts as the evidence the machine ran', () => {
    const doc = buildEvidenceDocument(INPUT)
    expect(doc.corpus.citationsReproduced).toBe(10)
    expect(doc.corpus.sweptAtBlock).toBe('69217227')
  })
})

describe('scoreFor', () => {
  it('maps the vocabulary onto the registry 0..100 scale', () => {
    expect(scoreFor('CLEAN')).toBe(100)
    expect(scoreFor('CONTROL_WEAKNESS')).toBe(60)
    expect(scoreFor('MATERIAL_MISSTATEMENT')).toBe(20)
  })
  it('scores WITHHELD mid-scale, since withholding is not a grade', () => {
    expect(scoreFor('WITHHELD')).toBe(50)
  })
})

describe('isAnswered', () => {
  it('treats the zero word as UNANSWERED', () => {
    // The bug: `lastUpdate > 0` was used instead, and the registry stamps lastUpdate when the
    // REQUEST is created — verified on-chain. Every inbound request read as already handled, so
    // a validator polling for work would have found none, forever.
    expect(isAnswered(`0x${'0'.repeat(64)}`)).toBe(false)
  })
  it('treats a real response hash as answered, case-insensitively', () => {
    const h = '0x2828295aaf59c07a919d2e25d9faecd952dcc7d3a00b8afa454b1a1c82bf6ebd' as const
    expect(isAnswered(h)).toBe(true)
    expect(isAnswered(h.toUpperCase().replace('0X', '0x') as `0x${string}`)).toBe(true)
  })
})
