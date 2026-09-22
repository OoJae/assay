import 'dotenv/config'
import { writeFileSync, readFileSync, existsSync } from 'node:fs'
import { sweep } from '../src/sweep/detect.js'
import { adjudicate, type Verdict } from '../src/adjudicate/serv.js'
import { METHODOLOGY_VERSION } from '../src/adjudicate/methodology.js'
import { HARD_CASES } from '../src/adjudicate/hard-cases.js'

/**
 * The BRAID A/B on the HARD adjudication set.
 *
 * The clean fixture came back 100%/100%, which measured nothing — it was too easy. This set is
 * built so the gates contend: partial handling, handling documented for the wrong surface,
 * exclusions that moot the defect, a threshold that is documented but numerically insufficient,
 * and adjacent-but-not-affected scope.
 *
 * If BRAID's branching-instruction claim is real, this is where it should show.
 */
const dev = process.argv.includes('--dev')
const n = Number(process.argv.find((a) => a.startsWith('--n='))?.split('=')[1] ?? 2)

console.error('sweeping for base findings…')
const r = await sweep({ symbols: ['CRWD', 'NVDA'] })
const share = r.findings.find((f) => f.defectClass === 'SHARE_COUNT_MISREAD_RISK')
const stale = r.findings.find((f) => f.defectClass.startsWith('ORACLE_STALE'))
if (!share) {
  console.error('no SHARE_COUNT_MISREAD_RISK finding available — cannot run the hard set')
  process.exit(1)
}

// Stale-feed findings only exist while a feed is actually past its heartbeat. Equity feeds are
// 24/5, so outside a closure window there is nothing to adjudicate — and fabricating one would
// break the rule that every citation must reproduce against chain state. Skip, and say so.
const skipped = stale ? [] : HARD_CASES.filter((c) => c.findingClass !== 'SHARE_COUNT_MISREAD_RISK')
const cases = stale ? HARD_CASES : HARD_CASES.filter((c) => c.findingClass === 'SHARE_COUNT_MISREAD_RISK')
if (skipped.length) {
  console.error(
    `NOTE: no stale-feed finding at this block (market ${r.marketClosed ? 'closed' : 'open'}, ` +
      `cohort ${r.cohort.stale}/${r.cohort.size} stale). Skipping ${skipped.length} case(s): ` +
      skipped.map((c) => c.id).join(', '),
  )
}
console.error(`base findings ready at block ${r.blockNumber}, running ${cases.length} cases\n`)

interface CaseResult {
  id: string
  expected: Verdict
  arm: 'braid-on' | 'braid-off'
  verdicts: Verdict[]
  /** How many calls were ASKED for. Optional so an older artifact still resumes. */
  attempted?: number
  errored?: number
  errors?: string[]
  correct: number
}

async function runCase(c: (typeof HARD_CASES)[number], braid: boolean): Promise<CaseResult> {
  const finding = c.findingClass === 'SHARE_COUNT_MISREAD_RISK' ? share! : stale!
  const verdicts: Verdict[] = []
  const errors: string[] = []
  for (let i = 0; i < n; i++) {
    try {
      const a = await adjudicate(finding, c.mandate, { dev, disableBraid: !braid })
      verdicts.push(a.verdict)
      const mark = a.verdict === c.expected ? '✓' : '✗'
      console.error(`  ${c.id.padEnd(34)} ${braid ? 'on ' : 'off'} ${i + 1}/${n}: ${mark} ${a.verdict}`)
    } catch (e) {
      // Recorded, not discarded. Dropping a failed call silently shrinks the denominator, so an
      // arm that mostly errored used to print as a confident accuracy figure.
      errors.push((e as Error).message.slice(0, 160))
      console.error(`  ${c.id.padEnd(34)} ${braid ? 'on ' : 'off'} ${i + 1}/${n}: ERROR ${(e as Error).message.slice(0, 50)}`)
    }
  }
  return {
    id: c.id,
    expected: c.expected,
    arm: braid ? 'braid-on' : 'braid-off',
    verdicts,
    attempted: n,
    errored: errors.length,
    errors,
    correct: verdicts.filter((v) => v === c.expected).length,
  }
}

/**
 * RESUMABLE. Two long runs were killed partway through, so each invocation reloads whatever is
 * already in the artifact and only runs the case/arm pairs that are missing. Re-running until it
 * reports complete is therefore safe and cheap — finished trials are never paid for twice.
 * A methodologyVersion change invalidates prior results, since the rubric IS the experiment.
 */
let results: CaseResult[] = []
/**
 * Keyed by methodology version.
 *
 * A fixed filename meant a rubric bump overwrote the sample measured under the previous one --
 * destroying the only evidence for this project's actual finding, that SPECIFICATION rather than
 * model configuration was the dominant variable. Keying it also makes resume correct: a run can
 * only resume a partial run of the SAME rubric, which is what the version check below intended.
 */
const OUT = `data/hard-trials-${METHODOLOGY_VERSION}.json`

if (existsSync(OUT)) {
  try {
    const prev = JSON.parse(readFileSync(OUT, 'utf8')) as {
      methodologyVersion?: string
      trialsPerCase?: number
      results?: CaseResult[]
    }
    if (prev.methodologyVersion === METHODOLOGY_VERSION && prev.trialsPerCase === n) {
      results = (prev.results ?? []).filter((x) => x.verdicts.length === n)
      if (results.length) console.error(`resuming: ${results.length} case/arm pairs already done\n`)
    } else if (prev.results?.length) {
      console.error(
        `previous artifact is methodology ${prev.methodologyVersion} n=${prev.trialsPerCase}; ` +
          `current is ${METHODOLOGY_VERSION} n=${n} — starting fresh\n`,
      )
    }
  } catch {
    /* corrupt or absent: start fresh */
  }
}
const done = new Set(results.map((x) => `${x.id}:${x.arm}`))

function summarise(arm: CaseResult['arm']) {
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

/**
 * Persist after EVERY case. An earlier run died partway through and lost all of it, because the
 * artifact was only written at the end. Long, expensive, network-bound runs must checkpoint.
 */
function persist(complete: boolean) {
  writeFileSync(
    OUT,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        complete,
        methodologyVersion: METHODOLOGY_VERSION,
        trialsPerCase: n,
        block: r.blockNumber,
        cases: cases.map((c) => ({ id: c.id, expected: c.expected, rationale: c.rationale })),
        skippedCases: skipped.map((c) => c.id),
        marketClosed: r.marketClosed,
        cohort: r.cohort,
        results,
        summary: { braidOn: summarise('braid-on'), braidOff: summarise('braid-off') },
      },
      null,
      2,
    ),
  )
}

for (const c of cases) {
  for (const braid of [true, false]) {
    const key = `${c.id}:${braid ? 'braid-on' : 'braid-off'}`
    if (done.has(key)) {
      console.error(`  ${c.id.padEnd(34)} ${braid ? 'on ' : 'off'}  (cached)`)
      continue
    }
    try {
      results.push(await runCase(c, braid))
      done.add(key)
      persist(false)
    } catch (e) {
      console.error(`  ${c.id} ${key} aborted: ${(e as Error).message.slice(0, 110)}`)
    }
  }
}

const on = summarise('braid-on')
const off = summarise('braid-off')
const expectedPairs = cases.length * 2
persist(results.length === expectedPairs)
if (results.length !== expectedPairs) {
  console.error(`\nINCOMPLETE: ${results.length}/${expectedPairs} case/arm pairs. Re-run to resume.`)
}

const pct = (x: number | null) => (x === null ? 'n/a' : `${(x * 100).toFixed(1)}%`)
console.log('\n' + '='.repeat(82))
console.log(`HARD ADJUDICATION SET — ${cases.length} cases x ${n} trials per arm`)
console.log('='.repeat(82))
console.log(`\n${'case'.padEnd(36)}${'expected'.padEnd(24)}${'braid-on'.padEnd(11)}braid-off`)
for (const c of cases) {
  const o = results.find((x) => x.id === c.id && x.arm === 'braid-on')!
  const f = results.find((x) => x.id === c.id && x.arm === 'braid-off')!
  console.log(
    `${c.id.padEnd(36)}${c.expected.padEnd(24)}${`${o.correct}/${o.verdicts.length}`.padEnd(11)}${f.correct}/${f.verdicts.length}`,
  )
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
