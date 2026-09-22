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
  correct: number
}

async function runCase(c: (typeof HARD_CASES)[number], braid: boolean): Promise<CaseResult> {
  const finding = c.findingClass === 'SHARE_COUNT_MISREAD_RISK' ? share! : stale!
  const verdicts: Verdict[] = []
  for (let i = 0; i < n; i++) {
    try {
      const a = await adjudicate(finding, c.mandate, { dev, disableBraid: !braid })
      verdicts.push(a.verdict)
      const mark = a.verdict === c.expected ? '✓' : '✗'
      console.error(`  ${c.id.padEnd(34)} ${braid ? 'on ' : 'off'} ${i + 1}/${n}: ${mark} ${a.verdict}`)
    } catch (e) {
      console.error(`  ${c.id.padEnd(34)} ${braid ? 'on ' : 'off'} ${i + 1}/${n}: ERROR ${(e as Error).message.slice(0, 50)}`)
    }
  }
  return {
    id: c.id,
    expected: c.expected,
    arm: braid ? 'braid-on' : 'braid-off',
    verdicts,
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
if (existsSync('data/hard-trials.json')) {
  try {
    const prev = JSON.parse(readFileSync('data/hard-trials.json', 'utf8')) as {
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
  const trials = rows.reduce((s, x) => s + x.verdicts.length, 0)
  const correct = rows.reduce((s, x) => s + x.correct, 0)
  return { trials, correct, accuracy: trials ? correct / trials : 0 }
}

/**
 * Persist after EVERY case. An earlier run died partway through and lost all of it, because the
 * artifact was only written at the end. Long, expensive, network-bound runs must checkpoint.
 */
function persist(complete: boolean) {
  writeFileSync(
    'data/hard-trials.json',
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

const pct = (x: number) => `${(x * 100).toFixed(0)}%`
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
console.log(`${'(correct/trials)'.padEnd(36)}${''.padEnd(24)}${`${on.correct}/${on.trials}`.padEnd(11)}${off.correct}/${off.trials}`)
console.log('\nsaved to data/hard-trials.json')
