import { SEV_RANK, type Finding, type Integrators, type IntegratorRole, type SweepData } from './findings'

export function fmtAge(iso: string, now: number = Date.now()): string {
  const s = (now - new Date(iso).getTime()) / 1000
  if (!Number.isFinite(s)) return 'at an unknown time'
  if (s < 90) return `${Math.round(s)}s ago`
  if (s < 5400) return `${Math.round(s / 60)}m ago`
  return `${(s / 3600).toFixed(1)}h ago`
}

export function fmtUsd(n: number): string {
  return `$${Math.round(n).toLocaleString('en-US')}`
}

/** Critical, high and medium lead the page; low and info fold under them. Severity rules are unchanged. */
export function splitBySeverity(findings: Finding[]): { lead: Finding[]; minor: Finding[] } {
  const sorted = [...findings].sort(
    (a, b) => SEV_RANK[a.severity] - SEV_RANK[b.severity] || a.subject.localeCompare(b.subject),
  )
  return {
    lead: sorted.filter((f) => SEV_RANK[f.severity] <= SEV_RANK.medium),
    minor: sorted.filter((f) => SEV_RANK[f.severity] > SEV_RANK.medium),
  }
}

/**
 * Whether a closure is backed by the cohort or only by the clock.
 *
 * The sweep now takes the published 24/5 schedule (Fri 20:00 to Sun 20:00 New York time) as
 * enough on its own, and asks the cohort only on a weekday, where 90% must be stale. So in the
 * first hours of a weekend 3 of 35 stale feeds is a closure, and "the stale feeds corroborate a
 * scheduled closure" would be a claim the numbers on the same banner contradict.
 */
export function closureBasis(cohort: SweepData['cohort']): 'cohort' | 'schedule' {
  const read = cohort.read ?? cohort.size
  return read > 0 && cohort.stale / read >= 0.9 ? 'cohort' : 'schedule'
}

const DEFAULT_MEASURES: Record<string, string> = {
  SHARE_COUNT_MISREAD_RISK:
    'how far a raw balanceOf() read as shares is from the true share count, as a share of the true count',
  CROSS_SURFACE_PRICE_MIX:
    'how far the on-chain token price differs from the off-chain share price, as a share of the share price',
  PENDING_CORPORATE_ACTION: 'how much the share-equivalent count of a fixed balance changes at the effective time',
}

/**
 * One figure per finding, and what it measures.
 *
 * The finding page used to print `basisPoints` and `percent` side by side, and on boards swept
 * before the impact fix they are different quantities: CRWD read "30,000 bps · 75%", where 30,000
 * bps is |m - 1| (the retired "300%" framing) and 75% is the understatement against the true count.
 * `percent` is the one both old and new boards agree on, so it is the figure; basis points are shown
 * only when there is no percent at all.
 */
export function impactView(f: Pick<Finding, 'defectClass' | 'impact'>): { figure: string | null; measures: string | null } {
  const { percent, basisPoints, measures } = f.impact
  const figure =
    percent !== undefined ? `${percent}%` : basisPoints !== undefined ? `${basisPoints.toLocaleString('en-US')} bps` : null
  return { figure, measures: figure ? (measures ?? DEFAULT_MEASURES[f.defectClass] ?? null) : null }
}

const ROLE_LABEL: Record<IntegratorRole, [one: string, many: string]> = {
  AMM_POOL: ['AMM pool', 'AMM pools'],
  AMM_POOL_MANAGER: ['pool manager', 'pool managers'],
  CUSTODY: ['custody or executor wallet', 'custody or executor wallets'],
  DISTRIBUTOR: ['distributor', 'distributors'],
}

/** "a", "a and b", "a, b and c". */
export function listJoin(items: string[]): string {
  if (items.length <= 1) return items.join('')
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`
}

export type IntegratorView =
  | {
      shape: 'distinct'
      scanned: number
      contracts: number
      /** Contracts whose logic could be read: everything but unresolved proxies. */
      resolved: number
      aware: number
      proxyUnresolved: number
      notAware: number
      notApplicable: number
      tooSmall: number
      noHolding: number
      /** Classified contracts whose every balance read failed: counted in `contracts`, in no bucket. */
      unreadContracts: number
      usdNotAware: number
      unpricedNotAware: number
      usdNotApplicable: number
      unpricedNotApplicable: number
      roles: Array<{ role: IntegratorRole; label: string; contracts: number; usdHeld: number }>
      sharesUnaccounted: number
      holdingsNotAware: number
      dustNotAware: number
      unreadHoldings: number
      /** Priced value in pools and custody as a fraction of all priced value held; null when unknown. */
      notApplicableShare: number | null
      minDivergencePct: number | null
      assetsScanned: string[]
      assetsBelowCutoff: string[]
      assetsUnread: string[]
    }
  | {
      /**
       * A board from before distinct counting: every count is an (address, token) pair, pools and
       * custody are inside `notAware`, and unpriced holdings were added as $0. Rendered as
       * holdings, with the dollar figure as a floor, rather than as contracts.
       */
      shape: 'pairs'
      scanned: number
      holdings: number
      notAwareHoldings: number
      aware: number
      proxyUnresolved: number
      usdNotAware: number
      sharesUnaccounted: number
    }

export function integratorView(agg: Integrators): IntegratorView {
  if (typeof agg.notApplicable !== 'number') {
    return {
      shape: 'pairs',
      scanned: agg.scanned,
      holdings: agg.contracts,
      notAwareHoldings: agg.notAware,
      aware: agg.aware,
      proxyUnresolved: agg.proxyUnresolved,
      usdNotAware: agg.usdHeldByNotAware,
      sharesUnaccounted: agg.sharesUnaccounted,
    }
  }
  const tooSmall = agg.tooSmall ?? 0
  const noHolding = agg.noHolding ?? 0
  const bucketed = agg.aware + agg.proxyUnresolved + agg.notAware + agg.notApplicable + tooSmall + noHolding
  const usdNotApplicable = agg.usdHeldByNotApplicable ?? 0
  const pricedTotal = usdNotApplicable + agg.usdHeldByNotAware
  const roles = (Object.keys(ROLE_LABEL) as IntegratorRole[])
    .map((role) => {
      const { contracts, usdHeld } = agg.byRole?.[role] ?? { contracts: 0, usdHeld: 0 }
      return { role, label: ROLE_LABEL[role][contracts === 1 ? 0 : 1], contracts, usdHeld }
    })
    .filter((r) => r.contracts > 0)
  return {
    shape: 'distinct',
    scanned: agg.scanned,
    contracts: agg.contracts,
    resolved: agg.contracts - agg.proxyUnresolved,
    aware: agg.aware,
    proxyUnresolved: agg.proxyUnresolved,
    notAware: agg.notAware,
    notApplicable: agg.notApplicable,
    tooSmall,
    noHolding,
    unreadContracts: Math.max(0, agg.contracts - bucketed),
    usdNotAware: agg.usdHeldByNotAware,
    unpricedNotAware: agg.unpricedNotAware ?? 0,
    usdNotApplicable,
    unpricedNotApplicable: agg.unpricedNotApplicable ?? 0,
    roles,
    sharesUnaccounted: agg.sharesUnaccounted,
    holdingsNotAware: agg.holdingsNotAware ?? agg.notAware,
    dustNotAware: agg.dustNotAware ?? 0,
    unreadHoldings: agg.unreadHoldings ?? 0,
    notApplicableShare: pricedTotal > 0 ? usdNotApplicable / pricedTotal : null,
    minDivergencePct: typeof agg.minDivergence === 'number' ? agg.minDivergence * 100 : null,
    assetsScanned: agg.assetsScanned ?? [],
    assetsBelowCutoff: agg.assetsBelowCutoff ?? [],
    assetsUnread: agg.assetsUnread ?? [],
  }
}
