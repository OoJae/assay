import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { keccak256, toHex } from 'viem'
import type { Adjudication, AdjudicateOptions, Verdict } from '../src/adjudicate/serv.js'
import type { VerifiedFinding } from '../src/verify/index.js'
import type { HeldoutArtifact, HeldoutCase, FixturesFile, Outcome } from '../src/adjudicate/heldout/types.js'

/**
 * Offline tests for the held-out harness (scripts/heldout-trials.ts).
 *
 * Nothing here calls SERV or the chain: `adjudicate` is replaced through vi.mock of serv.js (the
 * rest of serv.js stays real, so the fingerprint is computed from the real request), the OpenAI
 * client throws if it is ever constructed, the sweep throws if it is ever called, and
 * `dotenv/config` is stubbed so importing the script reads no .env. Git, the clock and the file
 * system are injected fakes.
 */

vi.mock('dotenv/config', () => ({}))
vi.mock('openai', () => ({
  default: class {
    constructor() {
      throw new Error('the offline suite never constructs a SERV client')
    }
  },
}))
const sweep = vi.fn(() => {
  throw new Error('the held-out harness must never sweep')
})
vi.mock('../src/sweep/detect.js', () => ({ sweep: () => sweep(), METHODOLOGY_VERSION: 'assay-rh-v0.4.0' }))
const adjudicateMock = vi.fn()
vi.mock('../src/adjudicate/serv.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/adjudicate/serv.js')>()
  return { ...real, adjudicate: (...a: Parameters<typeof real.adjudicate>) => adjudicateMock(...a) }
})

const H = await import('../scripts/heldout-trials.js')
const serv = await import('../src/adjudicate/serv.js')
const { METHODOLOGY_SYSTEM_PROMPT, METHODOLOGY_VERSION } = await import('../src/adjudicate/methodology.js')
const { HELDOUT_CASES, HELDOUT_VERSION } = await import('../src/adjudicate/heldout/cases.js')
const { planRun } = await import('../scripts/hard-trials.js')

/** The pin, written out a second time: moving it takes two deliberate edits, not one. */
const PINNED = '0xbf5c412d881d2a5d9f59cc3d68d3fce8236b833f9d0dad5c59342d5cc265efbc'
const KEY = 'serv_' + 'a'.repeat(40)
const FIXTURES = H.loadFixtures()

function fakeAdjudication(verdict: Verdict, finding: VerifiedFinding, mandate: string, opts: AdjudicateOptions = {}): Adjudication {
  return {
    verdict,
    severity: 'high',
    rationale: `mock rationale: ${verdict}`,
    binding_evidence: [finding.evidence[0]!.claim],
    withheld_reason: null,
    meta: {
      model: opts.dev ? serv.DEV_MODEL : serv.ADJUDICATOR_MODEL,
      methodologyVersion: METHODOLOGY_VERSION,
      braidEnabled: !opts.disableBraid,
      promptGuardTriggered: false,
      finishReason: 'stop',
      adjudicatedAt: '2026-09-24T00:00:00.000Z',
      latencyMs: 7,
      usage: { promptTokens: 1000, completionTokens: 100 },
      inputHash: keccak256(toHex(serv.buildUserMessage(finding, mandate))),
    },
  }
}

function makeDeps(over: Partial<import('../scripts/heldout-trials.js').HeldoutDeps> = {}) {
  const writes: Array<{ path: string; artifact: HeldoutArtifact }> = []
  const deps: import('../scripts/heldout-trials.js').HeldoutDeps = {
    cases: HELDOUT_CASES,
    heldoutVersion: HELDOUT_VERSION,
    fixtures: FIXTURES,
    pinned: H.PINNED_RUBRIC_FINGERPRINT,
    fingerprint: H.rubricFingerprint,
    git: { head: () => 'f'.repeat(40), dirty: () => [] },
    hashFile: (p) => `0xhash:${p}`,
    env: { SERV_API_KEY: KEY },
    isTracked: () => false,
    readPrevious: () => null,
    write: (path, artifact) => writes.push({ path, artifact: structuredClone(artifact) }),
    log: () => {},
    now: () => new Date('2026-09-24T00:00:00.000Z'),
    runId: () => 'test-run',
    ...over,
  }
  return { deps, writes }
}

const agree = (v: Verdict) => ({ writer: v, labellerA: v, labellerB: v })

beforeEach(() => {
  adjudicateMock.mockReset()
  sweep.mockClear()
})

describe('rubric fingerprint', () => {
  it('equals the pinned value, so a changed rubric fails CI before it can reach a held-out run', () => {
    expect(H.rubricFingerprint()).toBe(H.PINNED_RUBRIC_FINGERPRINT)
    expect(H.PINNED_RUBRIC_FINGERPRINT).toBe(PINNED)
  })

  it('is read off the request adjudicate() sends', () => {
    const p = H.rubricParts()
    expect(p.systemPrompt).toBe(METHODOLOGY_SYSTEM_PROMPT)
    expect(p.model).toBe(serv.ADJUDICATOR_MODEL)
    expect(p.methodologyVersion).toBe(METHODOLOGY_VERSION)
    const shadow = p.servShadowAgent as { name: string; parameters: { properties: { hint: { default: string } } } }
    expect(shadow.name).toBe('serv_shadow_agent')
    expect(shadow.parameters.properties.hint.default).toMatch(/MATERIAL_MISSTATEMENT is reachable ONLY through gate 4/)
    const { body } = serv.adjudicationRequest('x')
    expect(body.tools.find((t) => t.function.name === 'serv_shadow_agent')?.function).toEqual(p.servShadowAgent)
  })

  it('excludes the user message', () => {
    expect(H.fingerprintOf(H.rubricParts('one mandate'))).toBe(H.fingerprintOf(H.rubricParts('a different mandate')))
  })

  it('moves when any frozen part moves', () => {
    const base = H.rubricParts()
    const shadow = structuredClone(base.servShadowAgent) as { parameters: { properties: { hint: { default: string } } } }
    shadow.parameters.properties.hint.default += ' '
    for (const changed of [
      { ...base, methodologyVersion: 'assay-methodology-v3.0.1' },
      { ...base, model: serv.DEV_MODEL },
      { ...base, systemPrompt: base.systemPrompt.replace('GATE 4', 'GATE FOUR') },
      { ...base, servShadowAgent: shadow },
    ]) {
      expect(H.fingerprintOf(changed)).not.toBe(PINNED)
    }
  })
})

describe('the held-out harness never sweeps', () => {
  it('imports nothing from the sweep', () => {
    const src = readFileSync('scripts/heldout-trials.ts', 'utf8')
    const specifiers = [...src.matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)].map((m) => m[1]!)
    expect(specifiers.length).toBeGreaterThan(5)
    expect(specifiers.filter((s) => /sweep/.test(s))).toEqual([])
    expect(src).not.toMatch(/import\s*{[^}]*\bsweep\b[^}]*}/)
    expect(src).not.toMatch(/\bsweep\s*\(/)
  })
})

describe('fixtures', () => {
  it('loads the committed SHARE and CROSS fixtures, each of its own class', () => {
    expect(H.validateFixtures(FIXTURES)).toEqual([])
    const present = H.presentFixtures(FIXTURES)
    expect(present).toEqual(expect.arrayContaining(['SHARE', 'CROSS']))
    expect(FIXTURES.fixtures.SHARE!.id).toBe('CRWD-share-count')
    expect(FIXTURES.fixtures.CROSS!.id).toBe('SGOV-cross-surface')
    expect(H.detectionVersionOf([FIXTURES.fixtures.SHARE!, FIXTURES.fixtures.CROSS!])).toBe('assay-rh-v0.4.0')
  })

  it('refuses a fixture filed under the wrong key, an unknown key, or no fixtures at all', () => {
    const wrongKey = { fixtures: { CROSS: FIXTURES.fixtures.SHARE } } as FixturesFile
    expect(H.validateFixtures(wrongKey).join()).toMatch(/fixture CROSS: defectClass SHARE_COUNT_MISREAD_RISK, expected CROSS_SURFACE_PRICE_MIX/)
    expect(H.validateFixtures({ fixtures: { OTHER: FIXTURES.fixtures.SHARE } } as unknown as FixturesFile).join()).toMatch(/unknown fixture key OTHER/)
    expect(H.validateFixtures({} as FixturesFile)).toEqual(['fixtures.json has no `fixtures` object'])
    const noEvidence = { fixtures: { SHARE: { ...FIXTURES.fixtures.SHARE!, evidence: [] } } } as FixturesFile
    expect(H.validateFixtures(noEvidence).join()).toMatch(/no evidence/)
  })

  it('joins distinct detection versions, so a fixture from another detector cannot silently extend a run', () => {
    const f = (v: string) => ({ methodologyVersion: v }) as VerifiedFinding
    expect(H.detectionVersionOf([f('assay-rh-v0.4.0'), f('assay-rh-v0.4.0')])).toBe('assay-rh-v0.4.0')
    expect(H.detectionVersionOf([f('assay-rh-v0.5.0'), f('assay-rh-v0.4.0')])).toBe('assay-rh-v0.4.0+assay-rh-v0.5.0')
  })

  it('hashes a fixture by content', () => {
    const share = FIXTURES.fixtures.SHARE!
    expect(H.fixtureHash(structuredClone(share))).toBe(H.fixtureHash(share))
    expect(H.fixtureHash({ ...share, statement: share.statement + ' ' })).not.toBe(H.fixtureHash(share))
  })
})

describe('cases', () => {
  it('the committed case file is internally consistent', () => {
    expect(HELDOUT_VERSION).toBe('heldout-v1')
    expect(HELDOUT_CASES.length).toBeGreaterThan(0)
    expect(H.validateCases(HELDOUT_CASES)).toEqual([])
  })

  it('refuses a scored case with disagreeing labels, a contested case without, and an impossible gate', () => {
    const ok: HeldoutCase = { id: 'x', fixture: 'SHARE', mandate: 'm', label: 'BENIGN', gate: 2, status: 'scored', labels: agree('BENIGN'), rationale: 'r' }
    expect(H.validateCases([ok])).toEqual([])
    expect(H.validateCases([{ ...ok, labels: { ...agree('BENIGN'), labellerB: 'CONTROL_WEAKNESS' } }]).join()).toMatch(/scored, but/)
    expect(H.validateCases([{ ...ok, status: 'contested' }]).join()).toMatch(/contested, but all three labels are BENIGN/)
    expect(H.validateCases([{ ...ok, gate: 3 }]).join()).toMatch(/gate 3 cannot produce BENIGN/)
    expect(H.validateCases([{ ...ok, gate: 1, label: 'MATERIAL_MISSTATEMENT', labels: agree('MATERIAL_MISSTATEMENT') }]).join()).toMatch(/gate 1 cannot/)
    expect(H.validateCases([ok, ok]).join()).toMatch(/duplicate id/)
    expect(H.validateCases([{ ...ok, fixture: 'OTHER' as never }]).join()).toMatch(/unknown fixture/)
    expect(H.validateCases([{ ...ok, mandate: '  ' }]).join()).toMatch(/empty mandate/)
  })
})

describe('scoring math', () => {
  const CW = 'CONTROL_WEAKNESS' as const
  const MM = 'MATERIAL_MISSTATEMENT' as const
  const BN = 'BENIGN' as const
  const WH = 'WITHHELD' as const

  it('takes the unique mode, and calls any tie a SPLIT', () => {
    expect(H.modalOutcome([CW, CW, CW, MM])).toBe(CW)
    expect(H.modalOutcome([CW, CW, BN, MM])).toBe(CW)
    expect(H.modalOutcome([CW, CW, MM, MM])).toBe('SPLIT')
    expect(H.modalOutcome([CW, MM, BN, WH])).toBe('SPLIT')
    expect(H.modalOutcome([])).toBe('SPLIT')
  })

  it('counts an error as an outcome, so errors stay in the denominator', () => {
    expect(H.modalOutcome([CW, CW, 'ERROR', 'ERROR'])).toBe('SPLIT')
    expect(H.modalOutcome([CW, 'ERROR', 'ERROR', 'ERROR'])).toBe('ERROR')
    expect(H.modalOutcome([CW, CW, CW, 'ERROR'])).toBe(CW)
  })

  it('computes the Wilson 95% interval', () => {
    expect(H.wilson95(0, 0)).toBeNull()
    const near = (w: { lower: number; upper: number } | null, lo: number, hi: number) => {
      expect(w!.lower).toBeCloseTo(lo, 5)
      expect(w!.upper).toBeCloseTo(hi, 5)
    }
    near(H.wilson95(10, 10), 0.722467, 1)
    near(H.wilson95(0, 10), 0, 0.277533)
    near(H.wilson95(5, 10), 0.236593, 0.763407)
    near(H.wilson95(7, 10), 0.396778, 0.892209)
    near(H.wilson95(14, 16), 0.639772, 0.965023)
    near(H.wilson95(1, 2), 0.094531, 0.905469)
    // Symmetric in successes and failures, and never outside [0, 1].
    const a = H.wilson95(3, 11)!
    const b = H.wilson95(8, 11)!
    expect(a.lower).toBeCloseTo(1 - b.upper, 12)
    expect(H.wilson95(16, 16)!.upper).toBeLessThanOrEqual(1)
    expect(H.wilson95(0, 16)!.lower).toBeGreaterThanOrEqual(0)
  })
})

describe('arguments', () => {
  it('defaults to n=4, every fixture present, a new run', () => {
    expect(H.parseArgs([])).toEqual({ ok: true, args: { n: 4, dev: false } })
  })

  it('reads every flag', () => {
    expect(H.parseArgs(['--n=2', '--fixtures=cross,SHARE', '--resume=data/x.json', '--dev'])).toEqual({
      ok: true,
      args: { n: 2, fixtures: ['SHARE', 'CROSS'], resume: 'data/x.json', dev: true },
    })
  })

  it('refuses a bad count, an unknown fixture and an unknown flag rather than guessing', () => {
    expect(H.parseArgs(['--n=0']).ok).toBe(false)
    expect(H.parseArgs(['--n=two']).ok).toBe(false)
    expect(H.parseArgs(['--fixtures=SHARE,FOO']).ok).toBe(false)
    expect(H.parseArgs(['--fixture=SHARE']).ok).toBe(false)
  })
})

describe('planRun, parameterised by artifact name', () => {
  it('writes a held-out run under its own family and keeps hard-trials as the default', () => {
    const base = { n: 4, detectionVersion: 'assay-rh-v0.4.0', runId: 'r1', isTracked: () => false, readPrevious: () => null }
    const held = planRun({ ...base, name: 'heldout-trials' })
    expect(held.ok && held.out).toBe('data/heldout-trials-assay-methodology-v3.0.0-assay-rh-v0.4.0-r1.json')
    const hard = planRun(base)
    expect(hard.ok && hard.out).toBe('data/hard-trials-assay-methodology-v3.0.0-assay-rh-v0.4.0-r1.json')
  })
})

describe('refusals: nothing is sent unless the pre-registration holds', () => {
  const args = { n: 4, dev: false }

  it('refuses when the rubric fingerprint differs from the pin', async () => {
    const { deps, writes } = makeDeps({ pinned: '0x' + '0'.repeat(64) })
    const r = await H.runHeldout(args, deps)
    expect(r.ok).toBe(false)
    expect(!r.ok && r.reasons.join('\n')).toMatch(/rubric fingerprint 0xbf5c.* != pinned 0x0+/)
    expect(adjudicateMock).not.toHaveBeenCalled()
    expect(writes).toEqual([])
  })

  it('refuses when the rubric itself moved', async () => {
    const { deps } = makeDeps({ fingerprint: () => H.fingerprintOf({ ...H.rubricParts(), model: serv.DEV_MODEL }) })
    const r = await H.runHeldout(args, deps)
    expect(!r.ok && r.reasons.join()).toMatch(/fingerprint/)
    expect(adjudicateMock).not.toHaveBeenCalled()
  })

  it('refuses when the pre-registration is uncommitted or modified, or HEAD is unreadable', async () => {
    const { deps, writes } = makeDeps({
      git: {
        head: () => null,
        dirty: (paths) => paths.filter((p) => p.endsWith('cases.ts') || p.endsWith('fixtures.json')).map((path) => ({ path, why: path.endsWith('cases.ts') ? ('not committed' as const) : ('modified' as const) })),
      },
    })
    const r = await H.runHeldout(args, deps)
    const all = !r.ok ? r.reasons.join('\n') : ''
    expect(all).toMatch(/src\/adjudicate\/heldout\/cases\.ts is not committed/)
    expect(all).toMatch(/src\/adjudicate\/heldout\/fixtures\.json is modified/)
    expect(all).toMatch(/cannot read git HEAD/)
    expect(adjudicateMock).not.toHaveBeenCalled()
    expect(writes).toEqual([])
  })

  it('checks exactly the four pre-registration files', async () => {
    const seen: string[][] = []
    const { deps } = makeDeps({ git: { head: () => 'f'.repeat(40), dirty: (p) => (seen.push([...p]), []) } })
    adjudicateMock.mockImplementation(async (f: VerifiedFinding, m: string, o: AdjudicateOptions) => fakeAdjudication('BENIGN', f, m, o))
    await H.runHeldout({ n: 1, dev: false }, deps)
    expect(seen[0]).toEqual([
      'src/adjudicate/heldout/cases.ts',
      'src/adjudicate/heldout/fixtures.json',
      'src/adjudicate/heldout/GUIDE.md',
      'src/adjudicate/heldout/PROTOCOL.md',
    ])
  })

  it('refuses without a real SERV key, and never echoes one', async () => {
    for (const env of [{}, { SERV_API_KEY: 'serv_...' }]) {
      const { deps } = makeDeps({ env })
      const r = await H.runHeldout(args, deps)
      expect(!r.ok && r.reasons.join()).toMatch(/SERV_API_KEY is missing/)
    }
    expect(adjudicateMock).not.toHaveBeenCalled()
  })

  it('refuses a fixture that is not in fixtures.json', async () => {
    const onlyShare = { ...FIXTURES, fixtures: { SHARE: FIXTURES.fixtures.SHARE } }
    const { deps } = makeDeps({ fixtures: onlyShare })
    const r = await H.runHeldout({ ...args, fixtures: ['CROSS'] }, deps)
    expect(!r.ok && r.reasons.join()).toMatch(/fixture CROSS is not in/)
  })

  it('refuses an inconsistent case file', async () => {
    const bad: HeldoutCase = { id: 'x', fixture: 'SHARE', mandate: 'm', label: 'BENIGN', gate: 2, status: 'scored', labels: { ...agree('BENIGN'), labellerA: 'WITHHELD' }, rationale: 'r' }
    const { deps } = makeDeps({ cases: [bad] })
    const r = await H.runHeldout(args, deps)
    expect(!r.ok && r.reasons.join()).toMatch(/scored, but/)
  })
})

describe('a run over the stub cases, with a mocked adjudicator', () => {
  it('runs every case on both arms, one call at a time, and keeps contested cases out of the headline', async () => {
    const byMandate = new Map(HELDOUT_CASES.map((c) => [c.mandate, c]))
    let inFlight = 0
    let maxInFlight = 0
    adjudicateMock.mockImplementation(async (finding: VerifiedFinding, mandate: string, opts: AdjudicateOptions) => {
      inFlight++
      maxInFlight = Math.max(maxInFlight, inFlight)
      await new Promise((r) => setTimeout(r, 1))
      inFlight--
      return fakeAdjudication(byMandate.get(mandate)!.label, finding, mandate, opts)
    })
    const { deps, writes } = makeDeps()
    const r = await H.runHeldout({ n: 4, dev: false }, deps)
    if (!r.ok) throw new Error(r.reasons.join('\n'))
    const a = r.artifact

    const present = H.presentFixtures(FIXTURES)
    const runnable = HELDOUT_CASES.filter((c) => present.includes(c.fixture))
    const scored = runnable.filter((c) => c.status === 'scored')
    const contested = runnable.filter((c) => c.status === 'contested')

    expect(maxInFlight).toBe(1)
    expect(sweep).not.toHaveBeenCalled()
    expect(adjudicateMock).toHaveBeenCalledTimes(runnable.length * 2 * 4)
    for (const [, , opts] of adjudicateMock.mock.calls as Array<[VerifiedFinding, string, AdjudicateOptions]>) {
      expect(opts.apiKey).toBe(KEY)
      expect(opts.dev).toBe(false)
    }
    expect((adjudicateMock.mock.calls as Array<[unknown, unknown, AdjudicateOptions]>).filter((c) => c[2].disableBraid).length).toBe(runnable.length * 4)

    expect(r.out).toBe(`data/heldout-trials-assay-methodology-v3.0.0-${a.detectionMethodologyVersion}-test-run.json`)
    expect(a).toMatchObject({
      kind: 'heldout-trials',
      complete: true,
      dev: false,
      model: serv.ADJUDICATOR_MODEL,
      heldoutVersion: HELDOUT_VERSION,
      methodologyVersion: METHODOLOGY_VERSION,
      rubricFingerprint: PINNED,
      casesFileHash: '0xhash:src/adjudicate/heldout/cases.ts',
      trialsPerCase: 4,
    })
    expect(a.invocations).toHaveLength(1)
    expect(a.invocations[0]).toMatchObject({ gitHead: 'f'.repeat(40), casesFileHash: '0xhash:src/adjudicate/heldout/cases.ts', harnessUncommitted: false })
    expect(a.results).toHaveLength(runnable.length * 2)
    expect(a.notRun.map((x) => x.id).sort()).toEqual(HELDOUT_CASES.filter((c) => !present.includes(c.fixture)).map((c) => c.id).sort())

    // Every trial carries the fields the protocol reports.
    for (const row of a.results) {
      expect(row.trials).toHaveLength(4)
      const mandate = HELDOUT_CASES.find((c) => c.id === row.id)!.mandate
      expect(row.inputHash).toBe(keccak256(toHex(serv.buildUserMessage(FIXTURES.fixtures[row.fixture]!, mandate))))
      for (const t of row.trials) {
        expect(Object.keys(t).sort()).toEqual(
          ['bindingEvidence', 'draw', 'error', 'finishReason', 'inputHash', 'latencyMs', 'rationale', 'severity', 'usage', 'verdict', 'withheldReason'],
        )
        expect(t.inputHash).toBe(row.inputHash)
        expect(t.rationale).toMatch(/mock rationale/)
      }
    }

    for (const s of [a.summary.braidOn, a.summary.braidOff]) {
      expect(s.headline.cases).toBe(scored.length)
      expect(s.headline.correct).toBe(scored.length)
      expect(s.headline.accuracy).toBe(scored.length ? 1 : null)
      expect(s.contested.map((c) => c.id)).toEqual(contested.map((c) => c.id))
      expect(s.perDraw).toEqual({ attempted: scored.length * 4, completed: scored.length * 4, errored: 0, correct: scored.length * 4, accuracy: scored.length ? 1 : null, accuracyOverCompleted: scored.length ? 1 : null })
      expect(s.usage.calls).toBe(runnable.length * 4)
    }

    // Persisted after every pair, then once more at the end.
    expect(writes).toHaveLength(runnable.length * 2 + 1)
    expect(writes[0]!.artifact.results).toHaveLength(1)
    expect(writes.every((w) => w.path === r.out)).toBe(true)
    expect(H.renderReport(a)).toMatch(/HEADLINE/)
  })
})

describe('the summary, on a known pattern of draws', () => {
  const CASES: HeldoutCase[] = [
    { id: 'a', fixture: 'SHARE', mandate: 'mandate a', label: 'CONTROL_WEAKNESS', gate: 3, status: 'scored', labels: agree('CONTROL_WEAKNESS'), rationale: 'r' },
    { id: 'b', fixture: 'CROSS', mandate: 'mandate b', label: 'BENIGN', gate: 2, status: 'scored', labels: agree('BENIGN'), rationale: 'r' },
    {
      id: 'c',
      fixture: 'SHARE',
      mandate: 'mandate c',
      label: 'BENIGN',
      gate: 4,
      status: 'contested',
      labels: { writer: 'BENIGN', labellerA: 'MATERIAL_MISSTATEMENT', labellerB: 'BENIGN' },
      rationale: 'r',
    },
  ]
  // SHARE and CROSS only, so a later STALE capture cannot change what these tests run.
  const SC: FixturesFile = { ...FIXTURES, fixtures: { SHARE: FIXTURES.fixtures.SHARE, CROSS: FIXTURES.fixtures.CROSS } }
  const synth = (over: Partial<import('../scripts/heldout-trials.js').HeldoutDeps> = {}) => makeDeps({ cases: CASES, fixtures: SC, ...over })
  const CW = 'CONTROL_WEAKNESS' as const
  const MM = 'MATERIAL_MISSTATEMENT' as const
  const BN = 'BENIGN' as const
  const SCRIPT: Record<string, Outcome[]> = {
    'mandate a|braid-on': [CW, CW, BN, MM], // modal CW (2-1-1): correct
    'mandate a|braid-off': [CW, MM, CW, MM], // 2-2 split: incorrect
    'mandate b|braid-on': [BN, BN, BN, BN],
    'mandate b|braid-off': ['ERROR', BN, BN, BN], // modal BENIGN, one error in the denominator
    'mandate c|braid-on': [MM, MM, MM, MM], // contested: never an over-accusation, never in the headline
    'mandate c|braid-off': [BN, BN, BN, BN],
  }

  function script() {
    const queues = new Map(Object.entries(SCRIPT).map(([k, v]) => [k, [...v]]))
    adjudicateMock.mockImplementation(async (finding: VerifiedFinding, mandate: string, opts: AdjudicateOptions) => {
      const next = queues.get(`${mandate}|${opts.disableBraid ? 'braid-off' : 'braid-on'}`)!.shift()!
      if (next === 'ERROR') throw new serv.AdjudicatorError('refusal', 'stop', 'refused in the mock')
      return fakeAdjudication(next, finding, mandate, opts)
    })
  }

  it('scores the modal verdict per arm, with splits and errors counted against', async () => {
    script()
    const { deps } = synth()
    const r = await H.runHeldout({ n: 4, dev: false }, deps)
    if (!r.ok) throw new Error(r.reasons.join('\n'))
    const { braidOn: on, braidOff: off } = r.artifact.summary

    expect(on.headline.cases).toBe(2)
    expect(on.headline.correct).toBe(2)
    expect(on.headline.wilson95!.lower).toBeCloseTo(0.34238, 5)
    expect(on.headline.wilson95!.upper).toBe(1)
    expect(on.perDraw).toEqual({ attempted: 8, completed: 8, errored: 0, correct: 6, accuracy: 0.75, accuracyOverCompleted: 0.75 })
    expect(on.overAccusations).toEqual({ draws: 1, cases: 0, caseIds: [] })
    expect(on.missedDefects).toEqual({ draws: 1, cases: 0, caseIds: [] })
    expect(on.confusion.draws.CONTROL_WEAKNESS).toEqual({ MATERIAL_MISSTATEMENT: 1, CONTROL_WEAKNESS: 2, BENIGN: 1, WITHHELD: 0, ERROR: 0 })
    expect(on.confusion.modal.CONTROL_WEAKNESS!.CONTROL_WEAKNESS).toBe(1)
    expect(on.confusion.modal.BENIGN!.BENIGN).toBe(1)
    expect(on.perFixture.SHARE).toMatchObject({ cases: 1, correct: 1, drawsAttempted: 4, drawsCorrect: 2, drawAccuracy: 0.5 })
    expect(on.perFixture.CROSS).toMatchObject({ cases: 1, correct: 1, drawsAttempted: 4, drawsCorrect: 4 })
    expect(on.contested).toEqual([{ id: 'c', fixture: 'SHARE', labels: CASES[2]!.labels, modal: MM, outcomes: [MM, MM, MM, MM] }])
    expect(on.usage.calls).toBe(12)

    expect(off.headline).toMatchObject({ cases: 2, correct: 1, accuracy: 0.5 })
    expect(off.headline.wilson95!.lower).toBeCloseTo(0.094531, 5)
    expect(off.headline.wilson95!.upper).toBeCloseTo(0.905469, 5)
    expect(off.perDraw).toEqual({ attempted: 8, completed: 7, errored: 1, correct: 5, accuracy: 5 / 8, accuracyOverCompleted: 5 / 7 })
    expect(off.overAccusations).toEqual({ draws: 2, cases: 0, caseIds: [] })
    expect(off.missedDefects).toEqual({ draws: 0, cases: 0, caseIds: [] })
    expect(off.confusion.modal.CONTROL_WEAKNESS!.SPLIT).toBe(1)
    expect(off.confusion.draws.BENIGN!.ERROR).toBe(1)
    expect(off.perFixture.SHARE).toMatchObject({ cases: 1, correct: 0, accuracy: 0 })
    expect(off.errored).toEqual({ scored: 1, contested: 0, total: 1, pairsWithErrors: 1 })
    expect(off.usage.calls).toBe(11)

    const erroredRow = r.artifact.results.find((x) => x.id === 'b' && x.arm === 'braid-off')!
    expect(erroredRow).toMatchObject({ attempted: 4, completed: 3, errored: 1, modal: BN, modalCorrect: true, outcomes: ['ERROR', BN, BN, BN] })
    expect(erroredRow.trials[0]).toMatchObject({ verdict: null, rationale: null, usage: null, inputHash: erroredRow.inputHash })
    expect(erroredRow.trials[0]!.error).toMatch(/^ADJUDICATOR_ERROR refusal/)
    const split = r.artifact.results.find((x) => x.id === 'a' && x.arm === 'braid-off')!
    expect(split).toMatchObject({ modal: 'SPLIT', modalCorrect: false, correct: 2 })

    const report = H.renderReport(r.artifact)
    expect(report).toMatch(/braid-on\s+2\/2/)
    expect(report).toMatch(/braid-off\s+1\/2/)
    expect(report).toMatch(/contested \(run and reported, NOT in the headline\)/)
  })

  it('persists after every pair, stops on a billing failure without scoring it, and resumes where it stopped', async () => {
    let calls = 0
    adjudicateMock.mockImplementation(async (finding: VerifiedFinding, mandate: string, opts: AdjudicateOptions) => {
      calls++
      if (calls === 9) throw Object.assign(new Error('402 Payment Required'), { status: 402 })
      return fakeAdjudication(CASES.find((c) => c.mandate === mandate)!.label, finding, mandate, opts)
    })
    const first = synth()
    const r1 = await H.runHeldout({ n: 4, dev: false }, first.deps)
    if (!r1.ok) throw new Error(r1.reasons.join('\n'))
    expect(r1.aborted).toMatch(/HTTP 402 on b braid-on/)
    expect(r1.artifact.complete).toBe(false)
    expect(r1.artifact.results.map((x) => `${x.id}:${x.arm}`)).toEqual(['a:braid-on', 'a:braid-off'])
    expect(r1.artifact.invocations[0]!.abortedPair).toMatchObject({ id: 'b', arm: 'braid-on' })
    expect(r1.artifact.invocations[0]!.abortedPair!.trials).toHaveLength(1)
    expect(first.writes.map((w) => w.artifact.results.length)).toEqual([1, 2, 2])

    const saved = first.writes.at(-1)!.artifact
    const resumed = synth({ readPrevious: (p) => (p === r1.out ? structuredClone(saved) : null), runId: () => 'another-run' })
    calls = 100
    const r2 = await H.runHeldout({ n: 4, dev: false, resume: r1.out }, resumed.deps)
    if (!r2.ok) throw new Error(r2.reasons.join('\n'))
    expect(r2.out).toBe(r1.out)
    expect(r2.artifact.complete).toBe(true)
    expect(r2.artifact.runId).toBe('test-run')
    expect(r2.artifact.invocations).toHaveLength(2)
    expect(r2.artifact.results.map((x) => x.invocation)).toEqual([0, 0, 1, 1, 1, 1])
    expect(calls - 100).toBe(4 * 4)
  })

  it('refuses a resume whose cases file, count, fixtures or --dev differ', async () => {
    adjudicateMock.mockImplementation(async (f: VerifiedFinding, m: string, o: AdjudicateOptions) => fakeAdjudication(CASES.find((c) => c.mandate === m)!.label, f, m, o))
    const first = synth()
    const r1 = await H.runHeldout({ n: 1, dev: false }, first.deps)
    if (!r1.ok) throw new Error(r1.reasons.join('\n'))
    const saved = r1.artifact
    const resumeWith = async (prev: HeldoutArtifact, args: Partial<import('../scripts/heldout-trials.js').RunArgs> = {}) => {
      const { deps } = synth({ readPrevious: () => structuredClone(prev) })
      return H.runHeldout({ n: 1, dev: false, resume: 'data/x.json', ...args }, deps)
    }
    const reasons = async (p: ReturnType<typeof resumeWith>) => {
      const r = await p
      return r.ok ? '' : r.reasons.join('\n')
    }
    expect(await reasons(resumeWith({ ...saved, casesFileHash: '0xother' }))).toMatch(/cases\.ts changed since this run started/)
    expect(await reasons(resumeWith(saved, { n: 4 }))).toMatch(/n=1 != n=4/)
    expect(await reasons(resumeWith(saved, { fixtures: ['SHARE'] }))).toMatch(/--fixtures drops CROSS/)
    expect(await reasons(resumeWith({ ...saved, fixtures: { ...saved.fixtures, SHARE: { ...saved.fixtures.SHARE!, hash: '0xother' } } }))).toMatch(/fixture SHARE is not the one this run replayed/)
    expect(await reasons(resumeWith({ ...saved, rubricFingerprint: '0xold' }))).toMatch(/rubric fingerprint 0xold/)
    expect(await reasons(resumeWith({ ...saved, heldoutVersion: 'heldout-v0' }))).toMatch(/held-out set heldout-v0/)
    expect(await reasons(resumeWith(saved, { dev: true }))).toMatch(/started without --dev/)
    // A committed artifact is evidence, not a checkpoint.
    const { deps } = synth({ isTracked: () => true, readPrevious: () => saved })
    const committed = await H.runHeldout({ n: 1, dev: false, resume: 'data/x.json' }, deps)
    expect(!committed.ok && committed.reasons.join()).toMatch(/committed artifact/)
  })

  it('writes a --dev run under its own name, on the dev model', async () => {
    adjudicateMock.mockImplementation(async (f: VerifiedFinding, m: string, o: AdjudicateOptions) => fakeAdjudication('BENIGN', f, m, o))
    const { deps } = synth()
    const r = await H.runHeldout({ n: 1, dev: true }, deps)
    if (!r.ok) throw new Error(r.reasons.join('\n'))
    expect(r.out).toMatch(/^data\/heldout-trials-dev-/)
    expect(r.artifact.model).toBe(serv.DEV_MODEL)
    expect((adjudicateMock.mock.calls as Array<[unknown, unknown, AdjudicateOptions]>).every((c) => c[2].dev === true)).toBe(true)
  })
})
