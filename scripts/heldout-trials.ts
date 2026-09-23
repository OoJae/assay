import 'dotenv/config'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { keccak256, toHex } from 'viem'
import {
  adjudicate,
  adjudicationRequest,
  buildUserMessage,
  isPlaceholderKey,
  ADJUDICATOR_MODEL,
  DEV_MODEL,
  VERDICTS,
  type Adjudication,
  type Verdict,
} from '../src/adjudicate/serv.js'
import { METHODOLOGY_VERSION } from '../src/adjudicate/methodology.js'
import { newRunId, provenance, summariseUsage } from '../src/adjudicate/harness.js'
import { HELDOUT_CASES, HELDOUT_VERSION } from '../src/adjudicate/heldout/cases.js'
import {
  FIXTURE_DEFECT_CLASS,
  FIXTURE_KEYS,
  type Arm,
  type ArmSummary,
  type ConfusionMatrix,
  type FixtureKey,
  type FixtureSummary,
  type FixturesFile,
  type HeldoutArtifact,
  type HeldoutCase,
  type HeldoutFixtureRecord,
  type HeldoutInvocation,
  type HeldoutRow,
  type HeldoutTrial,
  type ModalOutcome,
  type Outcome,
  type WilsonInterval,
} from '../src/adjudicate/heldout/types.js'
import type { VerifiedFinding } from '../src/verify/index.js'
import { planRun } from './hard-trials.js'

/**
 * The HELD-OUT SERV evaluation. Pre-registered in src/adjudicate/heldout/PROTOCOL.md.
 *
 * The hard set's 24/24 is a tuning-set number: the v3 rubric's gate-4 text was written against
 * those same mandates. This harness measures the FROZEN rubric on mandates it was not edited
 * against. It never sweeps: every case replays one of the fixed findings in fixtures.json, so the
 * adjudicator's input is byte-identical on every draw and both arms.
 *
 * It refuses to make a single call unless the rubric's fingerprint equals the pinned one, the
 * pre-registration (cases, fixtures, guide, protocol) is committed and unmodified, and a real
 * SERV key is present. The artifact records the commit and the cases-file hash.
 *
 *   npm run heldout [-- --n=4] [--fixtures=SHARE,CROSS] [--dev]     a NEW run, its own run-id file
 *   npm run heldout -- --n=4 --resume=<path>                         continue THAT run
 *   npm run heldout -- --n=4 --resume=<path> --fixtures=SHARE,CROSS,STALE
 *                                                                    extend it with a newly captured fixture
 */

/** The project root. git runs here, and every relative path below resolves against it. */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const HELDOUT_DIR = 'src/adjudicate/heldout'
export const CASES_FILE = `${HELDOUT_DIR}/cases.ts`
export const FIXTURES_FILE = `${HELDOUT_DIR}/fixtures.json`
/** The pre-registration. Committed and unmodified, or the harness refuses. */
export const FROZEN_FILES = [CASES_FILE, FIXTURES_FILE, `${HELDOUT_DIR}/GUIDE.md`, `${HELDOUT_DIR}/PROTOCOL.md`] as const
const HARNESS_FILE = 'scripts/heldout-trials.ts'
export const DEFAULT_N = 4
const ARMS: readonly Arm[] = ['braid-on', 'braid-off']

// ---------------------------------------------------------------------------------------------
// The frozen rubric
// ---------------------------------------------------------------------------------------------

export interface RubricParts {
  methodologyVersion: string
  model: string
  systemPrompt: string
  /** The whole serv_shadow_agent tool entry as sent: its hint and its iteration cap. */
  servShadowAgent: unknown
}

const FINGERPRINT_PROBE = 'held-out rubric fingerprint probe; the user message is never part of the fingerprint'

/**
 * The rubric as it is SENT, read off adjudicationRequest() rather than off the source constants,
 * so an edit anywhere between the constant and the wire moves the fingerprint. The user message is
 * a fixed probe and is excluded; so is the header that switches BRAID off, which is the A/B lever.
 */
export function rubricParts(probe: string = FINGERPRINT_PROBE): RubricParts {
  const { body } = adjudicationRequest(probe)
  const systemPrompt = body.messages.find((m) => m.role === 'system')?.content
  const shadow = body.tools.find((t) => t.function.name === 'serv_shadow_agent')?.function
  if (typeof systemPrompt !== 'string' || !shadow) {
    throw new Error('adjudicationRequest() no longer carries a system prompt and a serv_shadow_agent tool')
  }
  return { methodologyVersion: METHODOLOGY_VERSION, model: body.model, systemPrompt, servShadowAgent: shadow }
}

export function fingerprintOf(p: RubricParts): `0x${string}` {
  // An array, so the order of the four parts is fixed here rather than by object key order.
  return keccak256(toHex(JSON.stringify([p.methodologyVersion, p.model, p.systemPrompt, p.servShadowAgent])))
}

export function rubricFingerprint(): `0x${string}` {
  return fingerprintOf(rubricParts())
}

/**
 * PINNED. The fingerprint of assay-methodology-v3.0.0 as sent to gpt-5.6-luna-serv-kronos-multipath.
 *
 * Do not update this to make the harness run. A different value means the rubric changed, and
 * PROTOCOL.md says a changed rubric is a new version for which this set is no longer held out.
 * test/heldout.test.ts recomputes it offline, so CI fails on the same change.
 */
export const PINNED_RUBRIC_FINGERPRINT = '0xbf5c412d881d2a5d9f59cc3d68d3fce8236b833f9d0dad5c59342d5cc265efbc'

// ---------------------------------------------------------------------------------------------
// Inputs: cases and fixtures
// ---------------------------------------------------------------------------------------------

const isVerdict = (v: unknown): v is Verdict => (VERDICTS as readonly unknown[]).includes(v)
const isFixtureKey = (k: unknown): k is FixtureKey => (FIXTURE_KEYS as readonly unknown[]).includes(k)

/** The verdicts each gate can produce, from the rubric's verdict definitions ("reachable ONLY through gate N"). */
const GATE_VERDICTS: Record<HeldoutCase['gate'], readonly Verdict[]> = {
  1: ['WITHHELD'],
  2: ['BENIGN'],
  3: ['CONTROL_WEAKNESS'],
  4: ['BENIGN', 'MATERIAL_MISSTATEMENT'],
}

/**
 * Structural problems in the case list. Any one refuses the run: a "scored" case whose labels
 * disagree would put a contested label in the headline.
 */
export function validateCases(cases: readonly HeldoutCase[]): string[] {
  const problems: string[] = []
  const seen = new Set<string>()
  for (const c of cases) {
    const at = `case ${c.id || '(no id)'}`
    if (!c.id?.trim()) problems.push(`${at}: empty id`)
    else if (seen.has(c.id)) problems.push(`${at}: duplicate id`)
    seen.add(c.id)
    if (!isFixtureKey(c.fixture)) problems.push(`${at}: unknown fixture ${String(c.fixture)}`)
    if (!c.mandate?.trim()) problems.push(`${at}: empty mandate`)
    if (!c.rationale?.trim()) problems.push(`${at}: empty rationale`)
    if (!isVerdict(c.label)) problems.push(`${at}: label ${String(c.label)} is not a verdict`)
    if (!(c.gate in GATE_VERDICTS)) problems.push(`${at}: gate ${String(c.gate)} is not 1-4`)
    const labels = [c.labels?.writer, c.labels?.labellerA, c.labels?.labellerB]
    if (!labels.every(isVerdict)) {
      problems.push(`${at}: labels must be three verdicts (writer, labellerA, labellerB)`)
      continue
    }
    const agree = labels[0] === labels[1] && labels[1] === labels[2]
    if (c.status === 'scored') {
      if (!agree || labels[0] !== c.label) problems.push(`${at}: scored, but writer/A/B = ${labels.join('/')} do not all equal ${c.label}`)
      else if (GATE_VERDICTS[c.gate] && !GATE_VERDICTS[c.gate].includes(c.label)) {
        problems.push(`${at}: gate ${c.gate} cannot produce ${c.label}`)
      }
    } else if (c.status === 'contested') {
      if (agree) problems.push(`${at}: contested, but all three labels are ${labels[0]}`)
    } else {
      problems.push(`${at}: status ${String(c.status)} is neither scored nor contested`)
    }
  }
  return problems
}

export function loadFixtures(path: string = FIXTURES_FILE): FixturesFile {
  return JSON.parse(readFileSync(resolve(ROOT, path), 'utf8')) as FixturesFile
}

/** Each present fixture must be a whole VerifiedFinding of the class its key names. */
export function validateFixtures(file: FixturesFile): string[] {
  if (!file || typeof file !== 'object' || !file.fixtures || typeof file.fixtures !== 'object') {
    return ['fixtures.json has no `fixtures` object']
  }
  const problems: string[] = []
  for (const [key, f] of Object.entries(file.fixtures) as Array<[string, VerifiedFinding | undefined]>) {
    if (!isFixtureKey(key)) {
      problems.push(`fixtures.json: unknown fixture key ${key}`)
      continue
    }
    if (!f || typeof f !== 'object') {
      problems.push(`fixture ${key}: not an object`)
      continue
    }
    if (f.defectClass !== FIXTURE_DEFECT_CLASS[key]) {
      problems.push(`fixture ${key}: defectClass ${String(f.defectClass)}, expected ${FIXTURE_DEFECT_CLASS[key]}`)
    }
    if (typeof f.id !== 'string' || !f.id) problems.push(`fixture ${key}: no id`)
    if (typeof f.methodologyVersion !== 'string' || !f.methodologyVersion) problems.push(`fixture ${key}: no methodologyVersion`)
    if (!Array.isArray(f.evidence) || f.evidence.length === 0) problems.push(`fixture ${key}: no evidence`)
    if (!f.verification || typeof f.verification.checked !== 'number') problems.push(`fixture ${key}: no verification record`)
  }
  return problems
}

/** The fixtures present in the file, in canonical order. */
export function presentFixtures(file: FixturesFile): FixtureKey[] {
  return FIXTURE_KEYS.filter((k) => Boolean(file?.fixtures?.[k]))
}

/**
 * The detection methodology the run's inputs were produced under, for the artifact path. Several
 * distinct versions are joined, so a fixture captured under another detector cannot silently
 * extend a run keyed by one.
 */
export function detectionVersionOf(findings: readonly VerifiedFinding[]): string {
  return [...new Set(findings.map((f) => f.methodologyVersion))].sort().join('+')
}

export function fixtureHash(f: VerifiedFinding): `0x${string}` {
  return keccak256(toHex(JSON.stringify(f)))
}

// ---------------------------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------------------------

/**
 * The modal outcome of a case's draws, or SPLIT when no outcome is uniquely most frequent. An
 * ERROR is an outcome like any other, so errors stay in the denominator: two errors and two correct
 * verdicts is a split, and a split is scored incorrect.
 */
export function modalOutcome(outcomes: readonly Outcome[]): ModalOutcome {
  const counts = new Map<Outcome, number>()
  for (const o of outcomes) counts.set(o, (counts.get(o) ?? 0) + 1)
  let best: Outcome | null = null
  let top = 0
  let tied = false
  for (const [o, n] of counts) {
    if (n > top) {
      best = o
      top = n
      tied = false
    } else if (n === top) {
      tied = true
    }
  }
  return best === null || tied ? 'SPLIT' : best
}

const Z95 = 1.959963984540054

/** Wilson score interval, 95%. Null when there is nothing to estimate. */
export function wilson95(k: number, n: number): WilsonInterval | null {
  if (n <= 0) return null
  const p = k / n
  const z2 = Z95 * Z95
  const denom = 1 + z2 / n
  const centre = (p + z2 / (2 * n)) / denom
  const half = (Z95 * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom
  return { lower: Math.max(0, centre - half), upper: Math.min(1, centre + half) }
}

const ratio = (k: number, n: number) => (n ? k / n : null)
const sum = <T>(xs: readonly T[], f: (x: T) => number) => xs.reduce((t, x) => t + f(x), 0)

const DRAW_COLUMNS: readonly Outcome[] = [...VERDICTS, 'ERROR']
const MODAL_COLUMNS: readonly ModalOutcome[] = [...VERDICTS, 'ERROR', 'SPLIT']

function emptyMatrix(columns: readonly string[]): ConfusionMatrix {
  return Object.fromEntries(VERDICTS.map((label) => [label, Object.fromEntries(columns.map((c) => [c, 0]))]))
}

/** One arm. The headline and every accuracy figure are over SCORED cases; contested ones are listed. */
export function summariseArm(rows: readonly HeldoutRow[], arm: Arm): ArmSummary {
  const inArm = rows.filter((r) => r.arm === arm)
  const scored = inArm.filter((r) => r.status === 'scored')
  const contested = inArm.filter((r) => r.status === 'contested')
  // Recomputed from the draws, never read back from a stored field.
  const modal = (r: HeldoutRow) => modalOutcome(r.outcomes)
  const caseCorrect = (r: HeldoutRow) => modal(r) === r.label
  const drawsCorrect = (r: HeldoutRow) => r.outcomes.filter((o) => o === r.label).length
  const errors = (r: HeldoutRow) => r.outcomes.filter((o) => o === 'ERROR').length

  const correct = scored.filter(caseCorrect).length
  const attempted = sum(scored, (r) => r.outcomes.length)
  const errored = sum(scored, errors)
  const drawCorrect = sum(scored, drawsCorrect)

  const draws = emptyMatrix(DRAW_COLUMNS)
  const modalMatrix = emptyMatrix(MODAL_COLUMNS)
  for (const r of scored) {
    for (const o of r.outcomes) draws[r.label]![o] = (draws[r.label]![o] ?? 0) + 1
    const m = modal(r)
    modalMatrix[r.label]![m] = (modalMatrix[r.label]![m] ?? 0) + 1
  }

  const perFixture: Partial<Record<FixtureKey, FixtureSummary>> = {}
  for (const k of FIXTURE_KEYS) {
    const fx = scored.filter((r) => r.fixture === k)
    if (!fx.length) continue
    const c = fx.filter(caseCorrect).length
    const a = sum(fx, (r) => r.outcomes.length)
    const d = sum(fx, drawsCorrect)
    perFixture[k] = {
      cases: fx.length,
      correct: c,
      accuracy: ratio(c, fx.length),
      wilson95: wilson95(c, fx.length),
      drawsAttempted: a,
      drawsCorrect: d,
      drawAccuracy: ratio(d, a),
    }
  }

  const wrongly = (v: Verdict) => {
    const eligible = scored.filter((r) => r.label !== v)
    const cases = eligible.filter((r) => modal(r) === v)
    return {
      draws: sum(eligible, (r) => r.outcomes.filter((o) => o === v).length),
      cases: cases.length,
      caseIds: cases.map((r) => r.id),
    }
  }

  const all = inArm.flatMap((r) =>
    r.trials
      .filter((t) => t.verdict !== null)
      .map((t) => ({ meta: { usage: t.usage, latencyMs: t.latencyMs } }) as unknown as Adjudication),
  )

  return {
    arm,
    headline: { cases: scored.length, correct, accuracy: ratio(correct, scored.length), wilson95: wilson95(correct, scored.length) },
    perDraw: {
      attempted,
      completed: attempted - errored,
      errored,
      correct: drawCorrect,
      accuracy: ratio(drawCorrect, attempted),
      accuracyOverCompleted: ratio(drawCorrect, attempted - errored),
    },
    confusion: { draws, modal: modalMatrix },
    perFixture,
    overAccusations: wrongly('MATERIAL_MISSTATEMENT'),
    missedDefects: wrongly('BENIGN'),
    errored: {
      scored: errored,
      contested: sum(contested, errors),
      total: sum(inArm, errors),
      pairsWithErrors: inArm.filter((r) => errors(r) > 0).length,
    },
    usage: summariseUsage(all),
    contested: contested.map((r) => ({ id: r.id, fixture: r.fixture, labels: r.labels, modal: modal(r), outcomes: r.outcomes })),
  }
}

// ---------------------------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------------------------

export interface RunArgs {
  n: number
  /** Explicit --fixtures. Absent: every fixture present for a new run, the run's own set on resume. */
  fixtures?: FixtureKey[]
  resume?: string
  dev: boolean
}

export function parseArgs(argv: readonly string[]): { ok: true; args: RunArgs } | { ok: false; reason: string } {
  const args: RunArgs = { n: DEFAULT_N, dev: false }
  for (const a of argv) {
    if (a === '--dev') args.dev = true
    else if (a.startsWith('--n=')) {
      const v = a.slice('--n='.length)
      if (!/^[1-9]\d*$/.test(v)) return { ok: false, reason: `--n must be a positive integer, got ${v || '(empty)'}` }
      args.n = Number(v)
    } else if (a.startsWith('--fixtures=')) {
      const keys = a
        .slice('--fixtures='.length)
        .split(',')
        .map((s) => s.trim().toUpperCase())
        .filter(Boolean)
      const bad = keys.filter((k) => !isFixtureKey(k))
      if (!keys.length || bad.length) {
        return { ok: false, reason: `--fixtures takes a comma list of ${FIXTURE_KEYS.join(', ')}; got ${bad.join(', ') || '(empty)'}` }
      }
      args.fixtures = FIXTURE_KEYS.filter((k) => keys.includes(k))
    } else if (a.startsWith('--resume=')) {
      args.resume = a.slice('--resume='.length)
      if (!args.resume) return { ok: false, reason: '--resume needs a path' }
    } else {
      // A mistyped flag used to be ignored, which here would mean running a set nobody asked for.
      return { ok: false, reason: `unknown argument ${a}` }
    }
  }
  return { ok: true, args }
}

/** Read-only git. Every call runs in the project root. */
export interface GitProbe {
  head(): string | null
  /** The paths that are not committed at HEAD, or differ from it (working tree or index). */
  dirty(paths: readonly string[]): Array<{ path: string; why: 'not committed' | 'modified' }>
}

export function gitProbe(root: string = ROOT): GitProbe {
  const succeeds = (args: string[]) => {
    try {
      execFileSync('git', args, { cwd: root, stdio: 'ignore' })
      return true
    } catch {
      return false
    }
  }
  return {
    head: () => {
      try {
        return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() || null
      } catch {
        return null
      }
    },
    dirty: (paths) =>
      paths.flatMap((path): Array<{ path: string; why: 'not committed' | 'modified' }> =>
        // `git diff` is silent about an untracked file, so "committed" is checked on its own.
        !succeeds(['cat-file', '-e', `HEAD:./${path}`])
          ? [{ path, why: 'not committed' }]
          : !succeeds(['diff', '--quiet', 'HEAD', '--', path])
            ? [{ path, why: 'modified' }]
            : [],
      ),
  }
}

export interface HeldoutDeps {
  cases: readonly HeldoutCase[]
  heldoutVersion: string
  fixtures: FixturesFile
  pinned: string
  fingerprint: () => string
  git: GitProbe
  /** keccak256 of a file's bytes. */
  hashFile: (path: string) => string
  env: Record<string, string | undefined>
  isTracked: (path: string) => boolean
  readPrevious: (path: string) => HeldoutArtifact | null
  write: (path: string, artifact: HeldoutArtifact) => void
  log: (line: string) => void
  now: () => Date
  runId: () => string
}

export function defaultDeps(): HeldoutDeps {
  const git = gitProbe(ROOT)
  return {
    cases: HELDOUT_CASES,
    heldoutVersion: HELDOUT_VERSION,
    fixtures: loadFixtures(),
    pinned: PINNED_RUBRIC_FINGERPRINT,
    fingerprint: rubricFingerprint,
    git,
    hashFile: (p) => keccak256(readFileSync(resolve(ROOT, p))),
    env: process.env,
    isTracked: (p) => {
      try {
        execFileSync('git', ['ls-files', '--error-unmatch', '--', p], { cwd: ROOT, stdio: 'ignore' })
        return true
      } catch {
        return false
      }
    },
    readPrevious: (p) => {
      try {
        const abs = resolve(ROOT, p)
        return existsSync(abs) ? (JSON.parse(readFileSync(abs, 'utf8')) as HeldoutArtifact) : null
      } catch {
        return null
      }
    },
    write: (p, a) => writeFileSync(resolve(ROOT, p), JSON.stringify(a, null, 2)),
    log: (line) => console.error(line),
    now: () => new Date(),
    runId: newRunId,
  }
}

/**
 * Everything that must hold before a single call. All of it is checked and all failures are
 * reported together, so one refusal does not hide the next.
 */
export function preflight(deps: HeldoutDeps): string[] {
  const reasons: string[] = []
  const fp = deps.fingerprint()
  if (fp !== deps.pinned) {
    reasons.push(
      `rubric fingerprint ${fp} != pinned ${deps.pinned}: the system prompt, the serv_shadow_agent hint, the model or ` +
        'the rubric version changed. Under PROTOCOL.md that is a new rubric, and this set is not held out for it.',
    )
  }
  if (!deps.heldoutVersion?.trim()) reasons.push('HELDOUT_VERSION is empty')
  if (!deps.cases.length) reasons.push('HELDOUT_CASES is empty')
  reasons.push(...validateCases(deps.cases))
  reasons.push(...validateFixtures(deps.fixtures))
  if (!deps.git.head()) reasons.push('cannot read git HEAD: the run must record the commit that pre-registered it')
  for (const d of deps.git.dirty(FROZEN_FILES)) {
    reasons.push(`${d.path} is ${d.why}: the pre-registration must be committed and unmodified before any SERV call`)
  }
  if (isPlaceholderKey(deps.env.SERV_API_KEY)) reasons.push('SERV_API_KEY is missing or still the .env.example placeholder')
  return reasons
}

/** A resumed run must replay exactly what it started on. */
export function resumeProblems(
  prev: HeldoutArtifact,
  cur: {
    heldoutVersion: string
    casesFileHash: string
    rubricFingerprint: string
    dev: boolean
    fixtureKeys: readonly FixtureKey[]
    fixtureHashes: Partial<Record<FixtureKey, string>>
  },
): string[] {
  const p: string[] = []
  if (prev.kind !== 'heldout-trials') return [`not a held-out artifact (kind ${String(prev.kind)})`]
  if (prev.heldoutVersion !== cur.heldoutVersion) p.push(`held-out set ${prev.heldoutVersion} != ${cur.heldoutVersion}`)
  if (prev.casesFileHash !== cur.casesFileHash) p.push(`${CASES_FILE} changed since this run started (${prev.casesFileHash} != ${cur.casesFileHash})`)
  if (prev.rubricFingerprint !== cur.rubricFingerprint) p.push(`rubric fingerprint ${prev.rubricFingerprint} != ${cur.rubricFingerprint}`)
  if (prev.dev !== cur.dev) p.push(`the run was started with${prev.dev ? '' : 'out'} --dev`)
  for (const k of prev.fixtureKeys ?? []) {
    if (!cur.fixtureKeys.includes(k)) p.push(`--fixtures drops ${k}, which this run already includes`)
    else if (prev.fixtures?.[k]?.hash !== cur.fixtureHashes[k]) p.push(`fixture ${k} is not the one this run replayed`)
  }
  return p
}

/** The case/arm pairs still to run. A row that exists is done, errors and all (as in hard-trials). */
export function pendingPairs(caseIds: readonly string[], rows: readonly Pick<HeldoutRow, 'id' | 'arm'>[]) {
  const done = new Set(rows.map((r) => `${r.id}:${r.arm}`))
  return caseIds.flatMap((id) => ARMS.filter((arm) => !done.has(`${id}:${arm}`)).map((arm) => ({ id, arm })))
}

/** HTTP statuses that mean the call never reached the adjudicator: a bad key, or no credit. */
const ABORT_STATUSES = new Set([401, 402, 403])

class RunAborted extends Error {
  constructor(
    message: string,
    readonly pair: { id: string; arm: Arm; trials: HeldoutTrial[] },
  ) {
    super(message)
  }
}

export type RunResult =
  | { ok: false; reasons: string[] }
  | { ok: true; out: string; artifact: HeldoutArtifact; aborted?: string }

export async function runHeldout(args: RunArgs, deps: HeldoutDeps): Promise<RunResult> {
  const refuse = (reasons: string[]): RunResult => ({ ok: false, reasons })
  if (!Number.isInteger(args.n) || args.n < 1) return refuse([`n must be a positive integer, got ${args.n}`])

  const reasons = preflight(deps)
  const present = presentFixtures(deps.fixtures)
  const selected: FixtureKey[] =
    args.fixtures ?? (args.resume ? (deps.readPrevious(args.resume)?.fixtureKeys ?? present) : present)
  for (const k of selected) if (!present.includes(k)) reasons.push(`fixture ${k} is not in ${FIXTURES_FILE}`)
  const runCases = deps.cases.filter((c) => selected.includes(c.fixture))
  if (!runCases.length && deps.cases.length) reasons.push(`no case uses the selected fixtures (${selected.join(', ')})`)
  if (reasons.length) return refuse(reasons)

  const fixtures = Object.fromEntries(selected.map((k) => [k, deps.fixtures.fixtures[k]!])) as Partial<Record<FixtureKey, VerifiedFinding>>
  const fixtureRecords: Partial<Record<FixtureKey, HeldoutFixtureRecord>> = Object.fromEntries(
    selected.map((k) => {
      const f = fixtures[k]!
      return [k, { id: f.id, defectClass: f.defectClass, methodologyVersion: f.methodologyVersion, hash: fixtureHash(f), finding: f }]
    }),
  )
  const detectionVersion = detectionVersionOf(selected.map((k) => fixtures[k]!))
  const fingerprint = deps.fingerprint()
  const casesFileHash = deps.hashFile(CASES_FILE)

  const newId = deps.runId()
  const plan = planRun<HeldoutArtifact>({
    resume: args.resume,
    n: args.n,
    detectionVersion,
    runId: newId,
    // A --dev run is not the pre-registered evaluation, so it never shares its file family.
    name: args.dev ? 'heldout-trials-dev' : 'heldout-trials',
    isTracked: deps.isTracked,
    readPrevious: deps.readPrevious,
  })
  if (!plan.ok) return refuse([plan.reason])
  const { out, previous } = plan
  if (previous) {
    const problems = resumeProblems(previous, {
      heldoutVersion: deps.heldoutVersion,
      casesFileHash,
      rubricFingerprint: fingerprint,
      dev: args.dev,
      fixtureKeys: selected,
      fixtureHashes: Object.fromEntries(selected.map((k) => [k, fixtureRecords[k]!.hash])),
    })
    if (problems.length) return refuse(problems.map((x) => `cannot resume ${args.resume}: ${x}`))
  }

  const model = args.dev ? DEV_MODEL : ADJUDICATOR_MODEL
  const notRun = deps.cases
    .filter((c) => !selected.includes(c.fixture))
    .map((c) => ({
      id: c.id,
      fixture: c.fixture,
      reason: present.includes(c.fixture) ? 'fixture not selected for this run' : `${c.fixture} fixture not captured`,
    }))
  const results: HeldoutRow[] = [...(previous?.results ?? [])]
  const invocations: HeldoutInvocation[] = [
    ...(previous?.invocations ?? []),
    {
      at: deps.now().toISOString(),
      gitHead: deps.git.head()!,
      casesFileHash,
      fixturesFileHash: deps.hashFile(FIXTURES_FILE),
      harnessUncommitted: deps.git.dirty([HARNESS_FILE]).length > 0,
      fixtureKeys: selected,
    },
  ]
  const invocationIndex = invocations.length - 1
  const invocation = invocations[invocationIndex]!
  const runId = previous?.runId ?? newId
  const generatedAt = previous?.generatedAt ?? invocation.at

  if (previous) deps.log(`resuming ${out}: ${results.length} case/arm pairs already recorded`)
  deps.log(
    `held-out ${deps.heldoutVersion}: ${runCases.length} cases (${selected.join(', ')}) x ${args.n} draws x 2 arms on ${model} -> ${out}` +
      (args.dev ? '\nDEV MODEL: this is NOT the pre-registered evaluation.' : ''),
  )

  function artifact(complete: boolean): HeldoutArtifact {
    const prov = provenance(detectionVersion, results.map((r) => r.inputHash))
    return {
      kind: 'heldout-trials',
      runId,
      generatedAt,
      updatedAt: deps.now().toISOString(),
      complete,
      dev: args.dev,
      model,
      heldoutVersion: deps.heldoutVersion,
      methodologyVersion: METHODOLOGY_VERSION,
      detectionMethodologyVersion: detectionVersion,
      rubricFingerprint: fingerprint,
      casesFileHash,
      trialsPerCase: args.n,
      fixtureKeys: selected,
      fixtures: fixtureRecords,
      cases: [...deps.cases],
      notRun,
      invocations,
      results,
      summary: { braidOn: summariseArm(results, 'braid-on'), braidOff: summariseArm(results, 'braid-off') },
      rubricVersion: prov.rubricVersion,
      inputHashes: prov.inputHashes,
      usage: {
        promptTokens: sum(results, (r) => r.usage.promptTokens),
        completionTokens: sum(results, (r) => r.usage.completionTokens),
        estimatedUsd: Number(sum(results, (r) => r.usage.estimatedUsd).toFixed(4)),
        basis: summariseUsage([]).basis,
      },
    }
  }

  async function runPair(c: HeldoutCase, arm: Arm): Promise<HeldoutRow> {
    const finding = fixtures[c.fixture]!
    const inputHash = keccak256(toHex(buildUserMessage(finding, c.mandate)))
    const trials: HeldoutTrial[] = []
    const done: Adjudication[] = []
    for (let i = 0; i < args.n; i++) {
      const started = Date.now()
      const tag = `  ${c.id.padEnd(40)} ${arm.padEnd(9)} ${i + 1}/${args.n}:`
      try {
        const a = await adjudicate(finding, c.mandate, { dev: args.dev, disableBraid: arm === 'braid-off', apiKey: deps.env.SERV_API_KEY })
        done.push(a)
        trials.push({
          draw: i + 1,
          verdict: a.verdict,
          severity: a.severity,
          rationale: a.rationale,
          bindingEvidence: a.binding_evidence,
          withheldReason: a.withheld_reason ?? null,
          finishReason: a.meta.finishReason,
          latencyMs: a.meta.latencyMs,
          usage: a.meta.usage,
          inputHash: a.meta.inputHash,
          error: null,
        })
        const mark = c.status === 'contested' ? '~' : a.verdict === c.label ? '✓' : '✗'
        deps.log(`${tag} ${mark} ${a.verdict}`)
      } catch (e) {
        const message = (e as Error)?.message ?? String(e)
        const trial: HeldoutTrial = {
          draw: i + 1,
          verdict: null,
          severity: null,
          rationale: null,
          bindingEvidence: null,
          withheldReason: null,
          finishReason: null,
          latencyMs: Date.now() - started,
          usage: null,
          inputHash,
          error: message.slice(0, 500),
        }
        trials.push(trial)
        const status = (e as { status?: unknown })?.status
        if (typeof status === 'number' && ABORT_STATUSES.has(status)) {
          throw new RunAborted(`HTTP ${status} on ${c.id} ${arm}: ${message.slice(0, 200)}`, { id: c.id, arm, trials })
        }
        // Recorded, never dropped: a failed call stays in every denominator.
        deps.log(`${tag} ERROR ${message.slice(0, 80)}`)
      }
    }
    const outcomes: Outcome[] = trials.map((t) => t.verdict ?? 'ERROR')
    const modal = modalOutcome(outcomes)
    const verdicts = trials.flatMap((t) => (t.verdict ? [t.verdict] : []))
    return {
      id: c.id,
      fixture: c.fixture,
      findingId: finding.id,
      arm,
      label: c.label,
      status: c.status,
      labels: c.labels,
      invocation: invocationIndex,
      model,
      inputHash,
      attempted: args.n,
      completed: verdicts.length,
      errored: args.n - verdicts.length,
      verdicts,
      outcomes,
      correct: verdicts.filter((v) => v === c.label).length,
      modal,
      modalCorrect: modal === c.label,
      trials,
      usage: summariseUsage(done),
    }
  }

  // Sequential by construction: one call in flight, one pair at a time, persisted after each.
  let aborted: string | undefined
  for (const { id, arm } of pendingPairs(runCases.map((c) => c.id), results)) {
    const c = runCases.find((x) => x.id === id)!
    try {
      results.push(await runPair(c, arm))
    } catch (e) {
      if (!(e instanceof RunAborted)) throw e
      aborted = e.message
      invocation.aborted = e.message
      invocation.abortedPair = e.pair
      deps.log(`ABORTED: ${e.message}. Nothing from this pair is scored; it runs again on resume.`)
      break
    }
    deps.write(out, artifact(false))
  }

  const final = artifact(results.length === runCases.length * ARMS.length)
  deps.write(out, final)
  return { ok: true, out, artifact: final, aborted }
}

// ---------------------------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------------------------

const SHORT: Record<ModalOutcome, string> = {
  MATERIAL_MISSTATEMENT: 'MATERIAL',
  CONTROL_WEAKNESS: 'CONTROL',
  BENIGN: 'BENIGN',
  WITHHELD: 'WITHHELD',
  ERROR: 'ERROR',
  SPLIT: 'SPLIT',
}

export function renderReport(a: HeldoutArtifact): string {
  const pct = (x: number | null) => (x === null ? 'n/a' : `${(x * 100).toFixed(1)}%`)
  const ci = (w: WilsonInterval | null) => (w ? `[${pct(w.lower)}, ${pct(w.upper)}]` : '[n/a]')
  const frac = (k: number, n: number) => `${k}/${n}`
  const { braidOn: on, braidOff: off } = a.summary
  const W = 110
  const L: string[] = []
  const run = a.cases.filter((c) => a.fixtureKeys.includes(c.fixture))

  L.push('='.repeat(W))
  L.push(`HELD-OUT SET ${a.heldoutVersion}: ${run.length} cases x ${a.trialsPerCase} draws per arm${a.dev ? '   [DEV MODEL: NOT THE PRE-REGISTERED RUN]' : ''}`)
  L.push(`rubric ${a.methodologyVersion}  fingerprint ${a.rubricFingerprint}`)
  L.push(`model ${a.model}  detection ${a.detectionMethodologyVersion}  commit ${a.invocations.at(-1)?.gitHead ?? '?'}`)
  L.push('='.repeat(W))

  const cell = (r: HeldoutRow | undefined) => {
    if (!r) return '-'
    const m = modalOutcome(r.outcomes)
    const mark = r.status === 'contested' ? '~' : m === r.label ? '✓' : '✗'
    return `${mark} ${SHORT[m]} ${frac(r.correct, r.attempted)}${r.errored ? ` err${r.errored}` : ''}`
  }
  L.push(`\n${'case'.padEnd(34)}${'fixture'.padEnd(8)}${'gate'.padEnd(5)}${'status'.padEnd(11)}${'label'.padEnd(12)}${'braid-on'.padEnd(22)}braid-off`)
  for (const c of run) {
    const row = (arm: Arm) => a.results.find((r) => r.id === c.id && r.arm === arm)
    L.push(
      `${c.id.padEnd(34)}${c.fixture.padEnd(8)}${String(c.gate).padEnd(5)}${c.status.padEnd(11)}${SHORT[c.label].padEnd(12)}` +
        `${cell(row('braid-on')).padEnd(22)}${cell(row('braid-off'))}`,
    )
  }
  L.push('  (cell: modal verdict, then draws equal to the label / attempted; ~ = contested, not scored)')

  const arms: Array<[string, ArmSummary]> = [
    ['braid-on ', on],
    ['braid-off', off],
  ]
  L.push('\nHEADLINE: scored cases, modal verdict per arm (a 2-2 split is incorrect), Wilson 95%')
  for (const [name, s] of arms) {
    L.push(`  ${name}  ${frac(s.headline.correct, s.headline.cases).padEnd(7)} ${pct(s.headline.accuracy).padEnd(7)} ${ci(s.headline.wilson95)}`)
  }
  L.push('\nper-draw accuracy, scored cases, errored calls in the denominator')
  for (const [name, s] of arms) {
    const d = s.perDraw
    L.push(`  ${name}  ${frac(d.correct, d.attempted).padEnd(7)} ${pct(d.accuracy).padEnd(7)} errored ${d.errored}; over completed ${frac(d.correct, d.completed)} ${pct(d.accuracyOverCompleted)}`)
  }
  L.push('\nover-accusations (MATERIAL_MISSTATEMENT where the label is not) / missed defects (BENIGN where the label is not)')
  for (const [name, s] of arms) {
    const ids = (x: string[]) => (x.length ? ` (${x.join(', ')})` : '')
    L.push(
      `  ${name}  over: ${s.overAccusations.cases} case(s), ${s.overAccusations.draws} draw(s)${ids(s.overAccusations.caseIds)}` +
        `   missed: ${s.missedDefects.cases} case(s), ${s.missedDefects.draws} draw(s)${ids(s.missedDefects.caseIds)}`,
    )
  }
  L.push('\nper fixture (scored cases, modal)')
  for (const k of FIXTURE_KEYS) {
    const o = on.perFixture[k]
    const f = off.perFixture[k]
    if (!o && !f) continue
    const fx = (s: FixtureSummary | undefined) => (s ? `${frac(s.correct, s.cases)} ${pct(s.accuracy)} ${ci(s.wilson95)}` : '-')
    L.push(`  ${k.padEnd(6)} braid-on ${fx(o).padEnd(30)} braid-off ${fx(f)}`)
  }
  L.push('\nconfusion (scored cases, modal; rows = label)')
  for (const [name, s] of arms) {
    L.push(`  ${name.trim()}`)
    L.push(`    ${'label'.padEnd(10)}${MODAL_COLUMNS.map((c) => SHORT[c].padEnd(10)).join('')}`.trimEnd())
    for (const label of VERDICTS) {
      L.push(`    ${SHORT[label].padEnd(10)}${MODAL_COLUMNS.map((c) => String(s.confusion.modal[label]?.[c] ?? 0).padEnd(10)).join('')}`.trimEnd())
    }
  }
  L.push(`\nerrored calls: braid-on ${on.errored.total} (scored ${on.errored.scored}), braid-off ${off.errored.total} (scored ${off.errored.scored})`)

  if (on.contested.length || off.contested.length) {
    L.push('\ncontested (run and reported, NOT in the headline): writer / labellerA / labellerB')
    for (const c of run.filter((x) => x.status === 'contested')) {
      const o = on.contested.find((x) => x.id === c.id)
      const f = off.contested.find((x) => x.id === c.id)
      const d = (x: typeof o) => (x ? `${SHORT[x.modal]} [${x.outcomes.map((v) => SHORT[v]).join(' ')}]` : '-')
      L.push(`  ${c.id.padEnd(34)}${[c.labels.writer, c.labels.labellerA, c.labels.labellerB].map((v) => SHORT[v]).join(' / ').padEnd(30)}on ${d(o)}   off ${d(f)}`)
    }
  }
  if (a.notRun.length) {
    L.push('\nnot run')
    for (const x of a.notRun) L.push(`  ${x.id.padEnd(34)}${x.reason}`)
  }
  L.push(
    `\nusage (a lower bound; the console bill is authoritative): braid-on $${on.usage.estimatedUsd}, ` +
      `braid-off $${off.usage.estimatedUsd}; median latency ${on.usage.medianLatencyMs ?? '-'} / ${off.usage.medianLatencyMs ?? '-'} ms`,
  )
  L.push('every rationale is in the artifact, per trial.')
  return L.join('\n')
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2))
  if (!parsed.ok) {
    console.error(parsed.reason)
    process.exit(1)
  }
  let deps: HeldoutDeps
  try {
    deps = defaultDeps()
  } catch (e) {
    console.error(`cannot load the held-out inputs: ${(e as Error).message}`)
    process.exit(1)
  }
  const r = await runHeldout(parsed.args, deps)
  if (!r.ok) {
    console.error('REFUSED. Nothing was sent to SERV.\n' + r.reasons.map((x) => `  - ${x}`).join('\n'))
    process.exit(1)
  }
  console.log(renderReport(r.artifact))
  if (!r.artifact.complete) {
    const expected = r.artifact.cases.filter((c) => r.artifact.fixtureKeys.includes(c.fixture)).length * ARMS.length
    console.error(
      `\nINCOMPLETE: ${r.artifact.results.length}/${expected} case/arm pairs.` +
        `${r.aborted ? ` Aborted: ${r.aborted}.` : ''} Resume with: npm run heldout -- --n=${parsed.args.n}` +
        `${parsed.args.dev ? ' --dev' : ''} --resume=${r.out}`,
    )
    process.exitCode = 2
  }
  console.log(`\nsaved to ${r.out}`)
}

if (import.meta.url === `file://${process.argv[1]}`) await main()
