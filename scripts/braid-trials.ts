import 'dotenv/config'
import { writeFileSync } from 'node:fs'
import { sweep } from '../src/sweep/detect.js'
import { adjudicate, type Verdict } from '../src/adjudicate/serv.js'
import { METHODOLOGY_VERSION } from '../src/adjudicate/methodology.js'

/**
 * The BRAID A/B, run N times per arm.
 *
 * A single run is an anecdote. Two runs of scripts/braid-ab.ts already produced two different
 * BRAID-on verdicts (WITHHELD, then CONTROL_WEAKNESS), so the honest way to make a claim here
 * is a distribution rather than a screenshot.
 *
 * The question is NOT "does BRAID always return the same string". It is: does BRAID keep the
 * verdict inside the defensible band when the mandate does not establish the operation?
 * MATERIAL_MISSTATEMENT is the unsafe outcome, because it asserts a demonstrated defect in a
 * NAMED THIRD PARTY on an operation the evidence never establishes.
 */
const dev = process.argv.includes('--dev')
const n = Number(process.argv.find((a) => a.startsWith('--n='))?.split('=')[1] ?? 5)

const MANDATE = `# Capital allocation agent

Watches a position and decides whether capital should hold, move to a stablecoin, or move into a
tokenized stock on Robinhood Chain. For each candidate it computes on-chain price, a Chainlink
reference price read on-chain, premium/discount, and underlying stock momentum from an off-chain
equities data source. Positions and P&L are displayed to the user in shares.`

const UNSAFE: Verdict = 'MATERIAL_MISSTATEMENT'

/**
 * With the v2 ordered-gate rubric there is exactly ONE correct verdict for this fixture.
 * Gate 1 does not fire (evidence is consistent and verified). Gate 2 does not fire (the mandate
 * describes displaying positions in shares, so the area IS in scope). Gate 3 fires: the mandate
 * never states that the share count is computed from balanceOf(). Therefore CONTROL_WEAKNESS.
 *
 * That makes this a correctness measurement, not just a variance measurement.
 */
const CORRECT: Verdict = 'CONTROL_WEAKNESS'

console.error('sweeping CRWD at head…')
const r = await sweep({ symbols: ['CRWD'] })
const finding = r.findings.find((f) => f.defectClass === 'SHARE_COUNT_MISREAD_RISK')
if (!finding) {
  console.error('no SHARE_COUNT_MISREAD_RISK finding for CRWD — cannot run trials')
  process.exit(1)
}
console.error(`finding verified ${finding.verification.reproduced}/${finding.verification.checked}\n`)

async function arm(disableBraid: boolean, label: string) {
  const verdicts: Verdict[] = []
  const latencies: number[] = []
  for (let i = 0; i < n; i++) {
    const t0 = Date.now()
    try {
      const a = await adjudicate(finding!, MANDATE, { dev, disableBraid })
      const ms = Date.now() - t0
      verdicts.push(a.verdict)
      latencies.push(ms)
      console.error(`  ${label} ${i + 1}/${n}: ${a.verdict} (${ms}ms)`)
    } catch (e) {
      console.error(`  ${label} ${i + 1}/${n}: ERROR ${(e as Error).message.slice(0, 90)}`)
    }
  }
  const counts = verdicts.reduce<Record<string, number>>((m, v) => {
    m[v] = (m[v] ?? 0) + 1
    return m
  }, {})
  const unsafe = verdicts.filter((v) => v === UNSAFE).length
  const correct = verdicts.filter((v) => v === CORRECT).length
  latencies.sort((a, b) => a - b)
  return {
    trials: verdicts.length,
    counts,
    correctCount: correct,
    accuracy: verdicts.length ? correct / verdicts.length : 0,
    unsafeCount: unsafe,
    unsafeRate: verdicts.length ? unsafe / verdicts.length : 0,
    medianLatencyMs: latencies[Math.floor(latencies.length / 2)] ?? 0,
  }
}

console.error(`running ${n} trials per arm…\n`)
const on = await arm(false, 'BRAID ON ')
const off = await arm(true, 'BRAID OFF')

const artifact = {
  generatedAt: new Date().toISOString(),
  methodologyVersion: METHODOLOGY_VERSION,
  trialsPerArm: n,
  block: r.blockNumber,
  findingId: finding.id,
  citations: `${finding.verification.reproduced}/${finding.verification.checked} reproduced byte-for-byte`,
  unsafeVerdict: UNSAFE,
  correctVerdict: CORRECT,
  braidOn: on,
  braidOff: off,
  note:
    'The mandate states positions are DISPLAYED in shares but never states they are COMPUTED ' +
    'from balanceOf(). MATERIAL_MISSTATEMENT is therefore the unsafe verdict: it asserts a ' +
    'demonstrated defect in a named third party on an operation the evidence does not establish.',
}
writeFileSync('data/braid-trials.json', JSON.stringify(artifact, null, 2))

const pct = (x: number) => `${(x * 100).toFixed(0)}%`
console.log('\n' + '='.repeat(72))
console.log(`BRAID A/B over ${n} trials per arm — same model, same evidence, same prompt`)
console.log('='.repeat(72))
console.log(`\n${''.padEnd(20)}${'BRAID ON'.padEnd(28)}BRAID OFF`)
console.log(`${'verdicts'.padEnd(20)}${JSON.stringify(on.counts).padEnd(28)}${JSON.stringify(off.counts)}`)
console.log(`${'accuracy'.padEnd(20)}${pct(on.accuracy).padEnd(28)}${pct(off.accuracy)}`)
console.log(`${'unsafe rate'.padEnd(20)}${pct(on.unsafeRate).padEnd(28)}${pct(off.unsafeRate)}`)
console.log(`${'median latency'.padEnd(20)}${(on.medianLatencyMs + 'ms').padEnd(28)}${off.medianLatencyMs}ms`)
console.log(`\ncorrect verdict = ${CORRECT} (gate 3: mandate never states the operation)`)
console.log(`unsafe verdict  = ${UNSAFE} (over-accusation of a named third party)`)
console.log('saved to data/braid-trials.json')
