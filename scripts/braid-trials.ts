import 'dotenv/config'
import { writeFileSync } from 'node:fs'
import { sweep } from '../src/sweep/detect.js'
import { adjudicate, type Verdict } from '../src/adjudicate/serv.js'
import { METHODOLOGY_VERSION } from '../src/adjudicate/methodology.js'
import { artifactPath, newRunId, provenance, summariseUsage } from '../src/adjudicate/harness.js'
import type { Adjudication } from '../src/adjudicate/serv.js'

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

/**
 * ERRORED TRIALS COUNT.
 *
 * The previous version pushed nothing on a throw and then divided by `verdicts.length`, so a
 * failed call vanished from the denominator entirely. The committed artifact recorded
 * `trials: 8` on one arm and `trials: 6` on the other under a label announcing "8 per arm", and
 * an arm where EVERY call failed would have reported `complete: true` at 0% accuracy — which
 * reads as a devastating result about the model rather than as a network problem.
 *
 * For a contribution whose entire value is methodological care, silently discarding non-random
 * missing data is the wrong defect to have. Both denominators are now reported: `accuracy` over
 * completed trials, and `accuracyOverAttempted` over everything we asked for.
 */
async function arm(disableBraid: boolean, label: string) {
  const verdicts: Verdict[] = []
  const latencies: number[] = []
  const errors: string[] = []
  const all: Adjudication[] = []
  for (let i = 0; i < n; i++) {
    const t0 = Date.now()
    try {
      const a = await adjudicate(finding!, MANDATE, { dev, disableBraid })
      const ms = Date.now() - t0
      verdicts.push(a.verdict)
      latencies.push(ms)
      all.push(a)
      console.error(`  ${label} ${i + 1}/${n}: ${a.verdict} (${ms}ms)`)
    } catch (e) {
      const msg = (e as Error).message.slice(0, 160)
      errors.push(msg)
      console.error(`  ${label} ${i + 1}/${n}: ERROR ${msg.slice(0, 90)}`)
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
    attempted: n,
    completed: verdicts.length,
    errored: errors.length,
    errors,
    /** True only when every attempted trial produced a verdict. Read the rates against this. */
    complete: errors.length === 0,
    counts,
    correctCount: correct,
    accuracy: verdicts.length ? correct / verdicts.length : null,
    accuracyOverAttempted: correct / n,
    unsafeCount: unsafe,
    unsafeRate: verdicts.length ? unsafe / verdicts.length : null,
    medianLatencyMs: latencies[Math.floor(latencies.length / 2)] ?? null,
    usage: summariseUsage(all),
    inputHashes: [...new Set(all.map((a) => a.meta.inputHash))],
  }
}

console.error(`running ${n} trials per arm…\n`)
const on = await arm(false, 'BRAID ON ')
const off = await arm(true, 'BRAID OFF')

const runId = newRunId()
const artifact = {
  generatedAt: new Date().toISOString(),
  methodologyVersion: METHODOLOGY_VERSION,
  trialsPerArm: n,
  runId,
  block: r.blockNumber,
  findingId: finding.id,
  citations: `${finding.verification.reproduced}/${finding.verification.checked} reproduced byte-for-byte`,
  unsafeVerdict: UNSAFE,
  correctVerdict: CORRECT,
  braidOn: on,
  braidOff: off,
  ...provenance(finding.methodologyVersion, [...on.inputHashes, ...off.inputHashes]),
  usage: {
    promptTokens: on.usage.promptTokens + off.usage.promptTokens,
    completionTokens: on.usage.completionTokens + off.usage.completionTokens,
    estimatedUsd: Number((on.usage.estimatedUsd + off.usage.estimatedUsd).toFixed(4)),
    basis: on.usage.basis,
  },
  note:
    'The mandate states positions are DISPLAYED in shares but never states they are COMPUTED ' +
    'from balanceOf(). MATERIAL_MISSTATEMENT is therefore the unsafe verdict: it asserts a ' +
    'demonstrated defect in a named third party on an operation the evidence does not establish.',
}
/**
 * Keyed by methodology version AND run id.
 *
 * A fixed filename meant that bumping the rubric overwrote the sample measured under the previous
 * one — destroying the only evidence for the claim that specification, not model configuration,
 * was the dominant variable. That claim is the actual contribution here, and it is only
 * supportable if both samples survive.
 */
// Keyed by rubric AND detection version AND run id. The rubric alone does not identify the input:
// the finding text changed under an unchanged rubric. And NO "convenience pointer" over
// data/braid-trials.json — that file is the published v2 sample the README cites.
const keyed = artifactPath('braid-trials', finding.methodologyVersion, runId)
writeFileSync(keyed, JSON.stringify(artifact, null, 2))

const pct = (x: number | null) => (x === null ? 'n/a' : `${(x * 100).toFixed(0)}%`)
console.log('\n' + '='.repeat(72))
console.log(`BRAID A/B over ${n} trials per arm — same model, same evidence, same prompt`)
console.log('='.repeat(72))
console.log(`\n${''.padEnd(20)}${'BRAID ON'.padEnd(28)}BRAID OFF`)
console.log(`${'verdicts'.padEnd(20)}${JSON.stringify(on.counts).padEnd(28)}${JSON.stringify(off.counts)}`)
console.log(`${'completed'.padEnd(20)}${`${on.completed}/${on.attempted}`.padEnd(28)}${off.completed}/${off.attempted}`)
console.log(`${'accuracy'.padEnd(20)}${pct(on.accuracy).padEnd(28)}${pct(off.accuracy)}`)
console.log(`${'unsafe rate'.padEnd(20)}${pct(on.unsafeRate).padEnd(28)}${pct(off.unsafeRate)}`)
console.log(`${'median latency'.padEnd(20)}${(on.medianLatencyMs === null ? 'n/a' : on.medianLatencyMs + 'ms').padEnd(28)}${off.medianLatencyMs === null ? 'n/a' : off.medianLatencyMs + 'ms'}`)
if (on.errored || off.errored) {
  console.log(
    `\nWARNING: ${on.errored + off.errored} trial(s) errored and are EXCLUDED from the rates above. ` +
      `Rates over all attempted: ON ${pct(on.accuracyOverAttempted)}, OFF ${pct(off.accuracyOverAttempted)}.`,
  )
}
console.log(`\ncorrect verdict = ${CORRECT} (gate 3: mandate never states the operation)`)
console.log(`unsafe verdict  = ${UNSAFE} (over-accusation of a named third party)`)
console.log(`saved to ${keyed}`)
