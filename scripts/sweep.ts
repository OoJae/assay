import { sweep } from '../src/sweep/detect.js'
import { writeFileSync, readFileSync, existsSync, renameSync, unlinkSync } from 'node:fs'

const args = process.argv.slice(2)
const limitArg = args.find((a) => a.startsWith('--limit='))
const symArg = args.find((a) => a.startsWith('--symbols='))
const force = args.includes('--force')
const OUT = 'data/findings.json'
// Unique per process. A single fixed temp path meant two overlapping sweeps -- the 8-minute timer
// against a manual run, which is now a realistic overlap -- wrote each other's bytes, and whichever
// renamed second published a file the first had already moved away.
const TMP = `data/findings.tmp.${process.pid}.json`

/**
 * How far the published finding count may fall before this refuses to overwrite.
 *
 * The wall IS this file. A degraded RPC produces a sweep that legitimately finds almost nothing,
 * writes `findings: []` over good evidence, and exits 0 — so the failure looks like a clean run
 * and the board silently empties. A partial-symbol run is exempt, since a narrower scope is
 * expected to find less.
 */
const REGRESSION_LIMIT = 0.8

const result = await sweep({
  onProgress: (d, t, s) => { if (d % 20 === 0 || d === t) process.stderr.write(`  ...${d}/${t} (${s})\n`) },
  limit: limitArg ? Number(limitArg.split('=')[1]) : undefined,
  symbols: symArg ? symArg.split('=')[1]!.split(',') : undefined,
})

/**
 * A SCOPED run does not publish.
 *
 * `--symbols=CRWD` is the debugging shape, and it used to write its 8 findings straight over a
 * 43-finding board — a narrower scope is exempt from the regression guard precisely because it is
 * expected to find less, which is what makes it the more dangerous of the two. Scoped runs now go
 * to their own file unless --publish is passed explicitly.
 */
const scoped = Boolean(symArg || limitArg)
const publishing = !scoped || args.includes('--publish')
const target = publishing ? OUT : 'data/findings.scoped.json'

// Refuse a large regression unless it was asked for, and write atomically so an interrupted
// run cannot leave a truncated board behind.
//
// The guard used to be gated on `!scoped`, so `--symbols=CRWD --publish` overwrote the full board
// with a three-finding one at exit 0 and with no check at all -- the exact failure the guard
// exists to prevent, reachable by the one flag that means "yes, publish this".
if (publishing && !force && existsSync(OUT)) {
  try {
    const prev = JSON.parse(readFileSync(OUT, 'utf8')) as { findings?: unknown[] }
    const prevCount = prev.findings?.length ?? 0
    if (prevCount > 0 && result.findings.length < prevCount * REGRESSION_LIMIT) {
      console.error(
        `\nREFUSING TO OVERWRITE ${OUT}.\n` +
          `  published now:      ${result.findings.length}\n` +
          `  published before:   ${prevCount}\n` +
          `  sweep errors:       ${result.errors.length}\n` +
          `  cohort read:        ${result.cohort.read}/${result.cohort.size}\n\n` +
          `That is a drop of more than ${Math.round((1 - REGRESSION_LIMIT) * 100)}%, which is far more likely to be a\n` +
          `degraded RPC than ${prevCount - result.findings.length} conditions clearing at once. The existing board is\n` +
          `left untouched. Re-run with --force if the drop is real.`,
      )
      process.exit(2)
    }
  } catch {
    // An unreadable previous artifact is not a reason to block a good sweep.
  }
}

writeFileSync(TMP, JSON.stringify(result, null, 2))
renameSync(TMP, target)
if (existsSync(TMP)) unlinkSync(TMP)
if (!publishing) {
  console.error(`\nscoped run — wrote ${target}, left ${OUT} untouched. Pass --publish to overwrite the board.`)
}

console.log(`\nASSAY sweep @ block ${result.blockNumber}  (${result.observedAt})`)
console.log(`assets scanned: ${result.assetsScanned}   robinhood feeds available: ${result.feedsAvailable}`)
console.log(`stats:`, result.stats)
const mismatch = result.rejected.filter((r) => r.reason === 'mismatch').length
const unverifiable = result.rejected.filter((r) => r.reason === 'unverifiable_here').length
const unchecked = result.rejected.filter((r) => r.reason === 'unchecked').length
const noEvidence = result.rejected.filter((r) => r.reason === 'no_evidence').length
console.log(`findings published: ${result.findings.length}`)
console.log(
  `rejected: ${result.rejected.length}  (contradicted by chain state: ${mismatch}, ` +
    `block pruned: ${unverifiable}, RPC failed: ${unchecked}, no citations (our bug): ${noEvidence})`,
)
console.log(`sweep errors: ${result.errors.length}`)
const totalCites = result.findings.reduce((n, f) => n + f.verification.checked, 0)
const okCites = result.findings.reduce((n, f) => n + f.verification.reproduced, 0)
console.log(`citations: ${okCites}/${totalCites} reproduced byte-for-byte at block ${result.blockNumber}\n`)

const bySeverity = { critical: 0, high: 0, medium: 0, low: 0, info: 0 } as Record<string, number>
const byClass: Record<string, number> = {}
for (const f of result.findings) {
  bySeverity[f.severity] = (bySeverity[f.severity] ?? 0) + 1
  byClass[f.defectClass] = (byClass[f.defectClass] ?? 0) + 1
}
console.log('by severity:', bySeverity)
console.log('by class:', byClass)

if (result.chainNotes.length) {
  console.log('\nchain-level notes (verifiable, but no on-chain citation — reported separately):')
  for (const n of result.chainNotes) console.log(`  [${n.severity.toUpperCase()}] ${n.title}`)
}
console.log(
  `\nmarket: ${result.cohort.quorum ? (result.marketClosed ? 'CLOSED' : 'open') : 'INDETERMINATE (cohort quorum not met)'}` +
    `  (cohort ${result.cohort.stale}/${result.cohort.read} stale of ${result.cohort.size} feeds, ` +
    `${result.cohort.failed} unread, clockHint=${result.cohort.clockHint})`,
)

console.log('\ntop findings:')
const order = { critical: 0, high: 1, medium: 2, low: 3, info: 4 } as Record<string, number>
for (const f of [...result.findings].sort((a, b) => order[a.severity]! - order[b.severity]!).slice(0, 12)) {
  console.log(`  [${f.severity.toUpperCase().padEnd(8)}] ${f.defectClass.padEnd(28)} ${f.title}`)
}
