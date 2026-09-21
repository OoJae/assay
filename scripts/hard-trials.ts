import 'dotenv/config'
import { writeFileSync } from 'node:fs'
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
const share = r.findings.find((f) => f.defectClass === 'SHARE_COUNT_MISREPORT')
const stale = r.findings.find((f) => f.defectClass.startsWith('ORACLE_STALE'))
if (!share) {
  console.error('no SHARE_COUNT_MISREPORT finding available — cannot run the hard set')
  process.exit(1)
}

// Stale-feed findings only exist while a feed is actually past its heartbeat. Equity feeds are
// 24/5, so outside a closure window there is nothing to adjudicate — and fabricating one would
// break the rule that every citation must reproduce against chain state. Skip, and say so.
const skipped = stale ? [] : HARD_CASES.filter((c) => c.findingClass !== 'SHARE_COUNT_MISREPORT')
const cases = stale ? HARD_CASES : HARD_CASES.filter((c) => c.findingClass === 'SHARE_COUNT_MISREPORT')
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
  const finding = c.findingClass === 'SHARE_COUNT_MISREPORT' ? share! : stale!
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

const results: CaseResult[] = []
for (const c of cases) {
  results.push(await runCase(c, true))
  results.push(await runCase(c, false))
}

function summarise(arm: CaseResult['arm']) {
  const rows = results.filter((x) => x.arm === arm)
  const trials = rows.reduce((s, x) => s + x.verdicts.length, 0)
  const correct = rows.reduce((s, x) => s + x.correct, 0)
  return { trials, correct, accuracy: trials ? correct / trials : 0 }
}

const on = summarise('braid-on')
const off = summarise('braid-off')

writeFileSync(
  'data/hard-trials.json',
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      methodologyVersion: METHODOLOGY_VERSION,
      trialsPerCase: n,
      block: r.blockNumber,
      cases: cases.map((c) => ({ id: c.id, expected: c.expected, rationale: c.rationale })),
      skippedCases: skipped.map((c) => c.id),
      marketClosed: r.marketClosed,
      cohort: r.cohort,
      results,
      summary: { braidOn: on, braidOff: off },
    },
    null,
    2,
  ),
)

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
