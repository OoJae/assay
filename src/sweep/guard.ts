import { dirname, join } from 'node:path'
import { redactSnapshot } from '../lib/redact.js'

/**
 * What the sweep publishes, and whether it may publish at all.
 *
 * Kept pure and out of scripts/sweep.ts for two reasons. The guard used to live inside a
 * `try { ... } catch {}` whose catch fell through to PUBLISH, so any bug in it bypassed it
 * silently. And it had no test, so nothing showed that it was comparing the wrong thing.
 */

/** The fields of a previously published board the guard reads. Anything else is ignored. */
export interface PreviousBoard {
  observedAt?: string
  assetsScanned?: number
  findings?: Array<{ defectClass?: string }>
}

/** The fields of this run's board the guard reads. */
export interface CandidateBoard {
  observedAt: string
  assetsScanned: number
  findings: Array<{ defectClass: string }>
  errors: unknown[]
  cohort: { size: number; read: number; quorum: boolean }
}

export interface GuardDecision {
  refuse: boolean
  /** Why, either way. Written to the status sidecar and the log. */
  reason: string
}

/**
 * More unread assets than this and the run is a degraded RPC, not a quieter chain.
 *
 * Every refusal in the production log that was a real failure sat far above it (169, 170, 181, 185
 * and 195 of 195 assets unread); every one of the ~140 published runs had zero.
 */
export const MAX_UNREAD_FRACTION = 0.1

/**
 * The only classes the count check compares.
 *
 * THE LATCH THIS REPLACES. The guard compared the TOTAL finding count against the published file,
 * and a refusal leaves that file untouched, so the baseline never moved. Two things make the total
 * swing with no failure at all:
 *  - ORACLE_STALE_* follows the market. All 35 equity feeds pass their heartbeat over a weekend and
 *    all refresh within 31 seconds of the Sunday reopen, so Monday's first board is ~35 findings
 *    smaller than Sunday's. Against a frozen Sunday baseline a weekday count rarely or never
 *    clears 80%, so the board would have stayed on its weekend state from Monday 2026-09-28, the
 *    last day of judging, with nothing alerting.
 *  - INTEGRATOR_NOT_MULTIPLIER_AWARE follows who traded recently. It ranged 18-43 between
 *    consecutive 8-minute sweeps, and it caused a real refusal with zero errors and a full cohort
 *    (63 -> 48), with nothing wrong with the run.
 * SHARE_COUNT_MISREAD_RISK is one finding per divergent multiplier: 34 on each of 70 runs
 * measured, moving only on a corporate action. A drop there is a read failure, including the one
 * `errors` cannot see: a citation that fails re-verification goes to `rejected`, not `errors`.
 */
export const STABLE_CLASSES: readonly string[] = ['SHARE_COUNT_MISREAD_RISK']
export const STABLE_REGRESSION_LIMIT = 0.8

/**
 * How long the count check may hold the previous board.
 *
 * A held board's citations fall out of the RPC's retention window in about 17 minutes, so past
 * this age it protects nothing. A real drop in the stable class would otherwise latch the board
 * for good, since a refusal never moves the baseline. Read-health refusals are not released: they
 * judge this run alone, so they clear by themselves when the RPC recovers.
 */
export const COUNT_HOLD_MAX_MS = 45 * 60_000

const countStable = (fs: Array<{ defectClass?: string }> = []) =>
  fs.filter((f) => STABLE_CLASSES.includes(String(f.defectClass))).length

/**
 * Refuse only on evidence that this run failed to read the chain.
 *
 * The wall IS the published file. A degraded RPC produces a sweep that legitimately finds almost
 * nothing, and before any guard it wrote `findings: []` over good evidence and exited 0, so the
 * failure looked like a clean run and the board silently emptied. A run that read the chain
 * properly is published whatever it found; the market and the traders move the count, not us.
 */
export function shouldRefuse(prev: PreviousBoard | null, next: CandidateBoard): GuardDecision {
  const unread = next.errors.length
  const health = `${unread}/${next.assetsScanned} assets unread, cohort ${next.cohort.read}/${next.cohort.size} read`

  if (unread > next.assetsScanned * MAX_UNREAD_FRACTION) {
    return {
      refuse: true,
      reason:
        `${unread} of ${next.assetsScanned} assets could not be read, over the ` +
        `${Math.round(MAX_UNREAD_FRACTION * 100)}% a healthy RPC stays under`,
    }
  }
  // An empty cohort was never read, so it is not a read failure: refusing on it would latch.
  if (next.cohort.size > 0 && !next.cohort.quorum) {
    return {
      refuse: true,
      reason: `cohort quorum not met: ${next.cohort.read} of ${next.cohort.size} 24/5 feeds read`,
    }
  }

  /**
   * A narrower scope is not a reading of the chain, so its refusal is never released.
   *
   * This used to be covered only by the stable-class drop, which the count hold releases after 45
   * minutes, and 45 minutes is exactly how old the board is after a stretch of refusals. So
   * `--symbols=CRWD --publish`, `--limit=N --publish` or a registry that returned fewer assets
   * replaced the full board at exit 0 once the board was old enough, the overwrite the scoped-run
   * rule in scripts/sweep.ts exists to stop. --force stays the override for a registry that
   * really did shrink.
   */
  const prevAssets = prev?.assetsScanned ?? 0
  if (prevAssets > 0 && next.assetsScanned < prevAssets * STABLE_REGRESSION_LIMIT) {
    return {
      refuse: true,
      reason:
        `this run covered ${next.assetsScanned} assets where the previous board covered ${prevAssets}; ` +
        `a narrower scope does not replace the full board (--force if the registry really shrank)`,
    }
  }

  const prevCount = prev?.findings?.length ?? 0
  if (prevCount > 0 && next.findings.length === 0) {
    return { refuse: true, reason: `no findings, where the previous board had ${prevCount}` }
  }

  const before = countStable(prev?.findings)
  const now = countStable(next.findings)
  if (before > 0 && now < before * STABLE_REGRESSION_LIMIT) {
    const drop =
      `${STABLE_CLASSES.join('+')} fell from ${before} to ${now}, ` +
      `more than ${Math.round((1 - STABLE_REGRESSION_LIMIT) * 100)}%`
    const ageMs = Date.parse(next.observedAt) - Date.parse(prev?.observedAt ?? '')
    // An unparseable age cannot show the board is still worth holding, so it does not hold it.
    if (Number.isFinite(ageMs) && ageMs <= COUNT_HOLD_MAX_MS) {
      return { refuse: true, reason: `${drop}; ${health}` }
    }
    return {
      refuse: false,
      reason:
        `${drop}, but the previous board is past the ${COUNT_HOLD_MAX_MS / 60_000}-minute hold ` +
        `and this run is healthy (${health})`,
    }
  }

  return { refuse: false, reason: prev ? `healthy: ${health}` : `no previous board; ${health}` }
}

/** What the public board says it left out. Counts only: the rows themselves never leave the host. */
export interface Withheld {
  /** Named-integrator findings removed from `findings`. */
  namedIntegrators: number
  /** Named-integrator rows removed from `rejected`. */
  namedIntegratorsRejected: number
}

/**
 * The board as published: named integrators out of `findings` AND `rejected`, with a count of
 * what was removed so the gap is stated rather than hidden. Idempotent, so re-redacting a board
 * that already carries a count keeps it.
 */
export function publicBoard<
  S extends {
    findings: Array<{ defectClass: string }>
    rejected: Array<{ finding: { defectClass: string } }>
    withheld?: Partial<Withheld>
  },
>(snap: S): S & { withheld: Withheld } {
  const pub = redactSnapshot(snap)
  const rejected = pub.rejected ?? []
  return {
    ...pub,
    withheld: {
      namedIntegrators:
        (snap.withheld?.namedIntegrators ?? 0) + snap.findings.length - pub.findings.length,
      namedIntegratorsRejected:
        (snap.withheld?.namedIntegratorsRejected ?? 0) + snap.rejected.length - rejected.length,
    },
  }
}

/**
 * Where the unredacted snapshot goes: beside the public one, never in its place.
 *
 * `*.private.json` is gitignored. A path without a .json suffix gets one appended rather than
 * silently resolving to the public path itself.
 */
export function privateSnapshotPath(out: string): string {
  return /\.json$/.test(out) ? out.replace(/\.json$/, '.private.json') : `${out}.private.json`
}

/**
 * The outcome of the last sweep, beside the board it describes.
 *
 * A refusal exits 2, which the systemd unit counts as success, and leaves the board untouched, so
 * from outside a refusing sweep and a stopped one looked identical. This file is what makes it
 * visible.
 */
export function sweepStatusPath(out: string): string {
  return join(dirname(out), 'sweep-status.json')
}

export interface SweepStatus {
  /** Wall-clock time the run finished. */
  lastRunAt: string
  outcome: 'published' | 'refused'
  reason: string
  /** Findings on this run's public board; on the live board only when `outcome` is 'published'. */
  published: number
  errors: number
  assetsScanned: number
  /** The block this run read at; null when it failed before reading one. */
  block: string | null
}
