import { sweep, type SweepResult } from '../src/sweep/detect.js'
import {
  privateSnapshotPath,
  publicBoard,
  shouldRefuse,
  sweepStatusPath,
  type GuardDecision,
  type PreviousBoard,
  type SweepStatus,
} from '../src/sweep/guard.js'
import { writeFileSync, readFileSync, existsSync, renameSync, unlinkSync } from 'node:fs'

const args = process.argv.slice(2)
const limitArg = args.find((a) => a.startsWith('--limit='))
const symArg = args.find((a) => a.startsWith('--symbols='))
const force = args.includes('--force')
// Overridable so the production host can write outside the git working tree — see
// src/lib/surface.ts for why `git update-index --skip-worktree` is not sufficient.
const OUT = process.env.ASSAY_FINDINGS_PATH || 'data/findings.json'
const STATUS = sweepStatusPath(OUT)

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
const target = publishing ? OUT : `${OUT.replace(/\.json$/, '')}.scoped.json`

/**
 * Write through a temp file unique to this process, then rename.
 *
 * Unique per process: a single fixed temp path meant two overlapping sweeps -- the 8-minute timer
 * against a manual run, which is now a realistic overlap -- wrote each other's bytes, and
 * whichever renamed second published a file the first had already moved away. The rename means an
 * interrupted run cannot leave a truncated board behind.
 */
function writeAtomic(path: string, body: string): void {
  const tmp = `${path}.tmp.${process.pid}`
  writeFileSync(tmp, body)
  renameSync(tmp, path)
  if (existsSync(tmp)) unlinkSync(tmp)
}

/**
 * Record what this run did to the board. A scoped run that does not publish leaves the board, and
 * so its status, alone. A failure to write the status is logged and does not fail the sweep.
 */
function recordStatus(s: Omit<SweepStatus, 'lastRunAt'>): void {
  if (!publishing) return
  const status: SweepStatus = { lastRunAt: new Date().toISOString(), ...s }
  try {
    writeAtomic(STATUS, JSON.stringify(status, null, 2))
  } catch (err) {
    console.error(`could not write ${STATUS}: ${(err as Error).message}`)
  }
}

let result: SweepResult
try {
  result = await sweep({
    onProgress: (d, t, s) => { if (d % 20 === 0 || d === t) process.stderr.write(`  ...${d}/${t} (${s})\n`) },
    limit: limitArg ? Number(limitArg.split('=')[1]) : undefined,
    symbols: symArg ? symArg.split('=')[1]!.split(',') : undefined,
  })
} catch (err) {
  recordStatus({
    outcome: 'refused',
    reason: `sweep failed before producing a board: ${(err as Error).message}`,
    published: 0,
    errors: 0,
    assetsScanned: 0,
    block: null,
  })
  throw err
}

/**
 * Named integrators never reach the published file.
 *
 * The committed data/findings.json carried 25 of them over 17 full addresses while the wall
 * withheld the class, so one raw.githubusercontent.com request undid the withholding. The public
 * board is redacted here, at the source, with a count of what was removed; the full snapshot goes
 * to a gitignored `*.private.json` beside it for the operator.
 */
const board = publicBoard(result)

// The guard judges the board that would be published against the one that is. It used to apply
// only without --symbols, so `--symbols=CRWD --publish` overwrote the full board with a
// three-finding one at exit 0 -- the exact failure the guard exists to prevent, reachable by the
// one flag that means "yes, publish this".
let decision: GuardDecision = {
  refuse: false,
  reason: force ? 'forced (--force): guard skipped' : 'scoped run: not published',
}
if (publishing && !force) {
  let prev: PreviousBoard | null = null
  if (existsSync(OUT)) {
    try {
      prev = JSON.parse(readFileSync(OUT, 'utf8')) as PreviousBoard
    } catch {
      // An unreadable previous artifact is not a reason to block a good sweep. Only the parse is
      // in here: the guard itself must never fail open.
    }
  }
  decision = shouldRefuse(prev, board)
  if (decision.refuse) {
    console.error(
      `\nREFUSING TO OVERWRITE ${OUT}.\n` +
        `  reason:             ${decision.reason}\n` +
        `  published now:      ${board.findings.length}\n` +
        `  published before:   ${prev?.findings?.length ?? 0}\n` +
        `  sweep errors:       ${result.errors.length}\n` +
        `  cohort read:        ${result.cohort.read}/${result.cohort.size}\n\n` +
        `The existing board is left untouched and ${STATUS} records why.\n` +
        `Re-run with --force if this board is right.`,
    )
    recordStatus({
      outcome: 'refused',
      reason: decision.reason,
      published: board.findings.length,
      errors: result.errors.length,
      assetsScanned: result.assetsScanned,
      block: result.blockNumber,
    })
    process.exit(2)
  }
}

// Private first, so the public board is never newer than the snapshot it was redacted from.
const privateTarget = privateSnapshotPath(target)
writeAtomic(privateTarget, JSON.stringify(result, null, 2))
writeAtomic(target, JSON.stringify(board, null, 2))
recordStatus({
  outcome: 'published',
  reason: decision.reason,
  published: board.findings.length,
  errors: result.errors.length,
  assetsScanned: result.assetsScanned,
  block: result.blockNumber,
})
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
console.log(
  `findings published: ${board.findings.length}  (named integrators withheld: ` +
    `${board.withheld.namedIntegrators} findings, ${board.withheld.namedIntegratorsRejected} rejected; ` +
    `full snapshot in ${privateTarget})`,
)
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
const ig = result.integrators
console.log(
  `\nintegrators: scanned ${ig.scanned} addresses -> ${ig.contracts} contracts ` +
    `(${ig.aware} multiplier-aware, ${ig.notAware} NOT aware, ${ig.proxyUnresolved} proxies withheld)`,
)
if (ig.notAware) {
  console.log(
    `  exposure: $${ig.usdHeldByNotAware.toLocaleString(undefined, { maximumFractionDigits: 0 })} held, ` +
      `${ig.sharesUnaccounted.toFixed(4)} share-equivalents unaccounted if those balances are read as share counts`,
  )
}
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
