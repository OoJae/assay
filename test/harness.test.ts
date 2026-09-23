import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { artifactPath, provenance, summariseUsage } from '../src/adjudicate/harness.js'
import type { Adjudication } from '../src/adjudicate/serv.js'

/**
 * The measurement harness must never overwrite the history it extends.
 *
 * Three harnesses used to write "convenience pointers" over committed artifacts — including
 * data/braid-ab.json, the single run that looked decisive and was retracted, which is the evidence
 * FOR that retraction. They were also keyed by the rubric version alone, which did not change when
 * the finding text did, so a new run was indistinguishable from the one it replaced.
 */
const COMMITTED = [
  'data/braid-ab.json',
  'data/braid-trials.json',
  'data/braid-trials-v1-rubric.json',
  'data/injection-trials.json',
  'data/hard-trials.json',
  'data/hard-trials-run1.json',
  'data/hard-trials-v2-run2.json',
]

describe('artifactPath', () => {
  it('never returns a committed path', () => {
    for (const name of ['braid-ab', 'braid-trials', 'injection-trials', 'hard-trials', 'heldout-trials', 'heldout-trials-dev']) {
      expect(COMMITTED).not.toContain(artifactPath(name, 'assay-rh-v0.3.0', 'run1'))
    }
  })

  it('carries both the rubric and the detection version, so the input is identifiable', () => {
    const p = artifactPath('braid-trials', 'assay-rh-v0.3.0', 'r1')
    expect(p).toMatch(/assay-methodology-v3\.0\.0/)
    expect(p).toMatch(/assay-rh-v0\.3\.0/)
  })

  it('distinguishes the same rubric on different finding text', () => {
    expect(artifactPath('hard-trials', 'assay-rh-v0.2.0', 'r')).not.toBe(
      artifactPath('hard-trials', 'assay-rh-v0.3.0', 'r'),
    )
  })
})

describe('no harness writes to a fixed committed path', () => {
  it('each harness writeFileSync target is computed, not a committed literal', () => {
    // Static check on the source: a literal committed path inside writeFileSync is the regression.
    for (const f of readdirSync('scripts').filter((x) => /^(braid-ab|braid-trials|hard-trials|heldout-trials|injection-trials)\.ts$/.test(x))) {
      const src = readFileSync(`scripts/${f}`, 'utf8')
      for (const c of COMMITTED) {
        expect(src.includes(`writeFileSync('${c}'`), `${f} writes ${c}`).toBe(false)
      }
    }
  })
})

const adj = (p: number, c: number, ms: number, h: string): Adjudication =>
  ({
    verdict: 'CONTROL_WEAKNESS',
    severity: 'high',
    rationale: '',
    binding_evidence: [],
    meta: {
      model: 'm', methodologyVersion: 'v', braidEnabled: true, promptGuardTriggered: false,
      shadowAgentExhausted: false, adjudicatedAt: '', latencyMs: ms,
      usage: { promptTokens: p, completionTokens: c }, inputHash: h as `0x${string}`,
    },
  }) as Adjudication

describe('summariseUsage', () => {
  it('sums tokens and prices them at the luna list rate', () => {
    const u = summariseUsage([adj(1_000_000, 0, 10, '0x1'), adj(0, 1_000_000, 20, '0x1')])
    expect(u.promptTokens).toBe(1_000_000)
    expect(u.completionTokens).toBe(1_000_000)
    expect(u.estimatedUsd).toBeCloseTo(0.25 + 1.5, 4)
    expect(u.basis).toMatch(/lower bound/i)
  })
  it('handles an arm where every call errored', () => {
    const u = summariseUsage([])
    expect(u.calls).toBe(0)
    expect(u.medianLatencyMs).toBeNull()
  })
})

describe('provenance', () => {
  it('records the detection version and de-duplicates input hashes', () => {
    const p = provenance('assay-rh-v0.3.0', ['0xa', '0xa', '0xb'])
    expect(p.detectionMethodologyVersion).toBe('assay-rh-v0.3.0')
    expect(p.inputHashes).toEqual(['0xa', '0xb'])
  })
})
