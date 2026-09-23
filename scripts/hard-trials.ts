import 'dotenv/config'
import { writeFileSync, readFileSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { sweep } from '../src/sweep/detect.js'
import { adjudicate, type Verdict } from '../src/adjudicate/serv.js'
import { METHODOLOGY_VERSION } from '../src/adjudicate/methodology.js'
import { artifactPath, newRunId, provenance, summariseUsage, type UsageSummary } from '../src/adjudicate/harness.js'
import type { Adjudication } from '../src/adjudicate/serv.js'
import { HARD_CASES } from '../src/adjudicate/hard-cases.js'
import type { VerifiedFinding } from '../src/verify/index.js'

/**
 * The BRAID A/B on the HARD adjudication set.
 *
 * The clean fixture came back 100%/100%, which measured nothing — it was too easy. This set is
 * built so the gates contend: partial handling, handling documented for the wrong surface,
 * exclusions that moot the defect, a threshold that is documented but numerically insufficient,
 * and adjacent-but-not-affected scope.
 *
 * If BRAID's branching-instruction claim is real, this is where it should show.
 *
 *   pnpm hard [--n=4] [--dev]                 a NEW run, written to its own run-id file
 *   pnpm hard --n=4 --resume=<path>           continue THAT run; never a committed file
 */

/** One adjudication, with the reason text. Rows used to keep verdicts only, so no refusal could be attributed to a gate. */
export interface TrialRecord {
  verdict: Verdict
  severity: string
  rationale: string
  withheld_reason: string | null
  finishReason: string
  inputHash: string
  latencyMs: number
}

export interface CaseResult {
  id: string
  expected: Verdict
  arm: 'braid-on' | 'braid-off'
  /** The finding adjudicated, and the invocation (and so the block) it was swept in. */
  findingId?: string
  invocation?: number
  block?: string
  verdicts: Verdict[]
  trials?: TrialRecord[]
  /** How many calls were ASKED for. Optional so an older artifact still resumes. */
  attempted?: number
  errored?: number
  errors?: string[]
  correct: number
  /** Optional so an artifact written before usage was recorded still resumes. */
  usage?: UsageSummary
  inputHashes?: string[]
}

export interface Invocation {
  at: string
  block: string
  marketClosed: boolean
  cohort: unknown
  /** The base findings as swept, so every row's inputHash can be recomputed from this file. */
  findings?: Record<string, VerifiedFinding>
}

export interface HardTrialsArtifact {
  runId?: string
  generatedAt: string
  updatedAt?: string
  complete: boolean
  methodologyVersion: string
  detectionMethodologyVersion?: string
  trialsPerCase: number
  block: string
  cases: Array<{ id: string; expected: Verdict; rationale: string }>
  skippedCases: string[]
  marketClosed: boolean
  cohort: unknown
  invocations?: Invocation[]
  results: CaseResult[]
}

/** Read-only git: is this path committed? A resumed file must not be. */
export function isGitTracked(path: string): boolean {
  try {
    execFileSync('git', ['ls-files', '--error-unmatch', '--', path], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

/**
 * Where this run writes, and what it continues. Pure but for the two functions passed in.
 *
 * WHY. OUT used to be keyed by rubric and detection version with no run id — exactly the committed
 * file the README's headline row cites. The default was n=2 while that file holds n=4, so a bare
 * `pnpm hard` saw a mismatch, "started fresh", and overwrote it on the first checkpoint. Now a run
 * gets its own file, resume is explicit, a committed path is refused, and a mismatched resume is an
 * error rather than a silent restart.
 */
export function planRun(opts: {
  resume?: string
  n: number
  detectionVersion: string
  runId: string
  isTracked: (path: string) => boolean
  readPrevious: (path: string) => HardTrialsArtifact | null
}): { ok: true; out: string; previous: HardTrialsArtifact | null } | { ok: false; reason: string } {
  if (!opts.resume) {
    const out = artifactPath('hard-trials', opts.detectionVersion, opts.runId)
    if (opts.isTracked(out)) return { ok: false, reason: `${out} is committed` }
    return { ok: true, out, previous: null }
  }
  if (opts.isTracked(opts.resume)) {
    return { ok: false, reason: `${opts.resume} is a committed artifact. It is evidence, not a checkpoint; start a new run.` }
  }
  const previous = opts.readPrevious(opts.resume)
  if (!previous) return { ok: false, reason: `${opts.resume} is missing or unreadable` }
  const mismatch = [
    previous.methodologyVersion !== METHODOLOGY_VERSION && `rubric ${previous.methodologyVersion} != ${METHODOLOGY_VERSION}`,
    (previous.detectionMethodologyVersion ?? '') !== opts.detectionVersion &&
      `detection ${previous.detectionMethodologyVersion} != ${opts.detectionVersion}`,
    previous.trialsPerCase !== opts.n && `n=${previous.trialsPerCase} != n=${opts.n}`,
  ].filter(Boolean)
  if (mismatch.length) return { ok: false, reason: `cannot resume ${opts.resume}: ${mismatch.join(', ')}` }
  return { ok: true, out: opts.resume, previous }
}

/**
 * The case/arm pairs still to run. A row that exists is done, errors and all: re-running an
 * errored pair used to replace its row, which erased the record that the call had failed.
 */
export function pendingPairs(caseIds: string[], results: CaseResult[]): Array<{ id: string; arm: CaseResult['arm'] }> {
  const done = new Set(results.map((x) => `${x.id}:${x.arm}`))
  return caseIds.flatMap((id) =>
    (['braid-on', 'braid-off'] as const).filter((arm) => !done.has(`${id}:${arm}`)).map((arm) => ({ id, arm })),
  )
}

export function summarise(results: CaseResult[], arm: CaseResult['arm']) {
  const rows = results.filter((x) => x.arm === arm)
  const completed = rows.reduce((s, x) => s + x.verdicts.length, 0)
  const attempted = rows.reduce((s, x) => s + (x.attempted ?? x.verdicts.length), 0)
  const errored = rows.reduce((s, x) => s + (x.errored ?? 0), 0)
  const correct = rows.reduce((s, x) => s + x.correct, 0)
  return {
    // Both denominators, always. `trials` used to mean "completed" while the console printed
    // "n per arm", so the committed artifact read 8 on one arm and 6 on the other.
    attempted,
    completed,
    errored,
    allCompleted: errored === 0,
    correct,
    accuracy: completed ? correct / completed : null,
    accuracyOverAttempted: attempted ? correct / attempted : null,
  }
}

async function main() {
  const dev = process.argv.includes('--dev')
  const n = Number(process.argv.find((a) => a.startsWith('--n='))?.split('=')[1] ?? 2)
  const resume = process.argv.find((a) => a.startsWith('--resume='))?.split('=').slice(1).join('=')

  console.error('sweeping for base findings…')
  const r = await sweep({ symbols: ['CRWD', 'NVDA'] })
  const share = r.findings.find((f) => f.defectClass === 'SHARE_COUNT_MISREAD_RISK')
  const stale = r.findings.find((f) => f.defectClass.startsWith('ORACLE_STALE'))
  if (!share) {
    console.error('no SHARE_COUNT_MISREAD_RISK finding available — cannot run the hard set')
    process.exit(1)
  }

  /**
   * The DETECTION methodology is part of the input. The rubric version alone did not identify what
   * a number was measured on — the finding text changed under an unchanged rubric — so a resumed
   * run could silently mix trials from two different inputs.
   */
  const DETECTION_VERSION = share.methodologyVersion
  const newId = newRunId()
  const plan = planRun({
    resume,
    n,
    detectionVersion: DETECTION_VERSION,
    runId: newId,
    isTracked: isGitTracked,
    readPrevious: (p) => {
      try {
        return existsSync(p) ? (JSON.parse(readFileSync(p, 'utf8')) as HardTrialsArtifact) : null
      } catch {
        return null
      }
    },
  })
  if (!plan.ok) {
    console.error(plan.reason)
    process.exit(1)
  }
  const { out: OUT, previous } = plan

  /**
   * A resumed run keeps ITS case list. Stale-feed cases exist only while a feed is past its
   * heartbeat; a run started with the market open skipped them, and appending them on a later,
   * closed-market invocation made a two-day mix read as one run.
   */
  const available = stale ? HARD_CASES : HARD_CASES.filter((c) => c.findingClass === 'SHARE_COUNT_MISREAD_RISK')
  const cases = previous
    ? HARD_CASES.filter((c) => previous.cases.some((p) => p.id === c.id))
    : available
  const skipped = previous
    ? HARD_CASES.filter((c) => previous.skippedCases.includes(c.id))
    : HARD_CASES.filter((c) => !available.includes(c))
  const runnable = new Set(available.map((c) => c.id))
  if (skipped.length && !previous) {
    console.error(
      `NOTE: no stale-feed finding at this block (market ${r.marketClosed ? 'closed' : 'open'}, ` +
        `cohort ${r.cohort.stale}/${r.cohort.size} stale). Skipping ${skipped.length} case(s): ` +
        skipped.map((c) => c.id).join(', '),
    )
  }

  const results: CaseResult[] = previous?.results ?? []
  const invocations: Invocation[] = [
    ...(previous?.invocations ??
      (previous ? [{ at: previous.generatedAt, block: previous.block, marketClosed: previous.marketClosed, cohort: previous.cohort }] : [])),
    {
      at: new Date().toISOString(),
      block: r.blockNumber,
      marketClosed: r.marketClosed,
      cohort: r.cohort,
      findings: { [share.id]: share, ...(stale ? { [stale.id]: stale } : {}) },
    },
  ]
  const invocation = invocations.length - 1
  const first = invocations[0]!
  const runId = previous ? previous.runId : newId
  if (previous) console.error(`resuming ${OUT}: ${results.length} case/arm pairs already recorded\n`)
  console.error(`base findings ready at block ${r.blockNumber}, running ${cases.length} cases → ${OUT}\n`)

  async function runCase(c: (typeof HARD_CASES)[number], braid: boolean): Promise<CaseResult> {
    const finding = c.findingClass === 'SHARE_COUNT_MISREAD_RISK' ? share! : stale!
    const verdicts: Verdict[] = []
    const trials: TrialRecord[] = []
    const errors: string[] = []
    const all: Adjudication[] = []
    for (let i = 0; i < n; i++) {
      try {
        const a = await adjudicate(finding, c.mandate, { dev, disableBraid: !braid })
        verdicts.push(a.verdict)
        trials.push({
          verdict: a.verdict,
          severity: a.severity,
          rationale: a.rationale,
          withheld_reason: a.withheld_reason ?? null,
          finishReason: a.meta.finishReason,
          inputHash: a.meta.inputHash,
          latencyMs: a.meta.latencyMs,
        })
        all.push(a)
        const mark = a.verdict === c.expected ? '✓' : '✗'
        console.error(`  ${c.id.padEnd(34)} ${braid ? 'on ' : 'off'} ${i + 1}/${n}: ${mark} ${a.verdict}`)
      } catch (e) {
        // Recorded, not discarded. Dropping a failed call silently shrinks the denominator, so an
        // arm that mostly errored used to print as a confident accuracy figure. An adjudicator
        // refusal or truncation lands here too, as ADJUDICATOR_ERROR, never as a verdict.
        errors.push((e as Error).message.slice(0, 160))
        console.error(`  ${c.id.padEnd(34)} ${braid ? 'on ' : 'off'} ${i + 1}/${n}: ERROR ${(e as Error).message.slice(0, 50)}`)
      }
    }
    return {
      id: c.id,
      expected: c.expected,
      arm: braid ? 'braid-on' : 'braid-off',
      findingId: finding.id,
      invocation,
      block: r.blockNumber,
      verdicts,
      trials,
      attempted: n,
      errored: errors.length,
      errors,
      correct: verdicts.filter((v) => v === c.expected).length,
      usage: summariseUsage(all),
      inputHashes: [...new Set(all.map((a) => a.meta.inputHash))],
    }
  }

  /**
   * Persist after EVERY case. An earlier run died partway through and lost all of it, because the
   * artifact was only written at the end. Long, expensive, network-bound runs must checkpoint.
   * `block`, `marketClosed` and `cohort` are the FIRST invocation's; later ones are listed.
   */
  function persist(complete: boolean) {
    const artifact: HardTrialsArtifact & Record<string, unknown> = {
      runId,
      generatedAt: first.at,
      updatedAt: new Date().toISOString(),
      complete,
      methodologyVersion: METHODOLOGY_VERSION,
      trialsPerCase: n,
      block: first.block,
      cases: cases.map((c) => ({ id: c.id, expected: c.expected, rationale: c.rationale })),
      skippedCases: skipped.map((c) => c.id),
      marketClosed: first.marketClosed,
      cohort: first.cohort,
      invocations,
      results,
      summary: { braidOn: summarise(results, 'braid-on'), braidOff: summarise(results, 'braid-off') },
      ...provenance(DETECTION_VERSION, results.flatMap((x) => x.inputHashes ?? [])),
      usage: {
        promptTokens: results.reduce((t, x) => t + (x.usage?.promptTokens ?? 0), 0),
        completionTokens: results.reduce((t, x) => t + (x.usage?.completionTokens ?? 0), 0),
        estimatedUsd: Number(results.reduce((t, x) => t + (x.usage?.estimatedUsd ?? 0), 0).toFixed(4)),
        basis: results.find((x) => x.usage)?.usage?.basis ?? '',
      },
    }
    writeFileSync(OUT, JSON.stringify(artifact, null, 2))
  }

  for (const { id, arm } of pendingPairs(cases.map((c) => c.id), results)) {
    const c = cases.find((x) => x.id === id)!
    if (!runnable.has(id)) {
      console.error(`  ${id.padEnd(34)} ${arm}  (no finding of its class at this block — left for a later resume)`)
      continue
    }
    try {
      results.push(await runCase(c, arm === 'braid-on'))
      persist(false)
    } catch (e) {
      console.error(`  ${id} ${arm} aborted: ${(e as Error).message.slice(0, 110)}`)
    }
  }

  const on = summarise(results, 'braid-on')
  const off = summarise(results, 'braid-off')
  const expectedPairs = cases.length * 2
  persist(results.length === expectedPairs)
  if (results.length !== expectedPairs) {
    console.error(`\nINCOMPLETE: ${results.length}/${expectedPairs} case/arm pairs. Resume with --resume=${OUT}`)
  }

  const pct = (x: number | null) => (x === null ? 'n/a' : `${(x * 100).toFixed(1)}%`)
  console.log('\n' + '='.repeat(82))
  console.log(`HARD ADJUDICATION SET — ${cases.length} cases x ${n} trials per arm`)
  console.log('='.repeat(82))
  console.log(`\n${'case'.padEnd(36)}${'expected'.padEnd(24)}${'braid-on'.padEnd(11)}braid-off`)
  for (const c of cases) {
    const o = results.find((x) => x.id === c.id && x.arm === 'braid-on')
    const f = results.find((x) => x.id === c.id && x.arm === 'braid-off')
    const cell = (x: CaseResult | undefined) => (x ? `${x.correct}/${x.verdicts.length}` : '-')
    console.log(`${c.id.padEnd(36)}${c.expected.padEnd(24)}${cell(o).padEnd(11)}${cell(f)}`)
  }
  console.log(`\n${'ACCURACY'.padEnd(36)}${''.padEnd(24)}${pct(on.accuracy).padEnd(11)}${pct(off.accuracy)}`)
  console.log(`${'(correct/completed)'.padEnd(36)}${''.padEnd(24)}${`${on.correct}/${on.completed}`.padEnd(11)}${off.correct}/${off.completed}`)
  if (on.errored || off.errored) {
    console.log(
      `\nWARNING: ${on.errored + off.errored} call(s) errored and are EXCLUDED from the accuracy above.\n` +
        `Over all ATTEMPTED calls: braid-on ${pct(on.accuracyOverAttempted)}, braid-off ${pct(off.accuracyOverAttempted)}.`,
    )
  }
  console.log(`\nsaved to ${OUT}`)
}

if (import.meta.url === `file://${process.argv[1]}`) await main()
