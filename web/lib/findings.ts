import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'

export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'info'

export interface Evidence {
  claim: string
  chainId: number
  contract: string
  call: string
  /** Exact calldata, present for a call that takes arguments. */
  calldata?: string
  rawReturn: string
  blockNumber: string
  explorerUrl: string
  observedAt: string
}

export interface Finding {
  id: string
  defectClass: string
  severity: Severity
  /** The contract or feed whose state was READ. Not an accusation against it. */
  subject: string
  /** Who carries the exposure — usually the integrator, not the contract in `subject`. */
  affectedParty?: string
  title: string
  statement: string
  /**
   * On current boards `basisPoints` and `percent` are one quantity in two units and `measures`
   * names it. Older boards carry two different measures under those names (CRWD read "30,000 bps ·
   * 75%"), which is why the finding page renders `percent` alone (see impactView in ./present).
   */
  impact: { basisPoints?: number; percent?: number; measures?: string; note: string }
  evidence: Evidence[]
  offChainSources?: Array<{ url: string; describes: string; fetchedAt: string }>
  methodologyVersion: string
  detectedAt: string
  verification: {
    checked: number
    reproduced: number
    mismatched: number
    pruned: number
    verifiedAt: string
  }
}

export interface ChainNote {
  id: string
  severity: Severity
  title: string
  statement: string
  sources: string[]
  observedAt: string
}

export interface SweepData {
  blockNumber: string
  observedAt: string
  assetsScanned: number
  feedsAvailable: number
  marketClosed: boolean
  cohort: {
    size: number
    stale: number
    clockHint: boolean
    /** Reads that came back — the only honest denominator. Absent in pre-v0.3.0 snapshots. */
    read?: number
    /** Reads that failed after retries. Previously counted as fresh. */
    failed?: number
    /** False when too little of the cohort was read to conclude anything. */
    quorum?: boolean
    blockNumber?: string
  }
  findings: Finding[]
  rejected: Array<{
    reason: 'mismatch' | 'unverifiable_here' | 'unchecked' | 'no_evidence' | string
    detail: string
    finding: { id: string; subject: string; title?: string; defectClass?: string; severity?: Severity }
    results?: Array<{ status: string; reason?: string }>
  }>
  chainNotes: ChainNote[]
  stats: Record<string, number>
  errors: Array<{ symbol: string; error: string }>
  /**
   * AGGREGATE integrator exposure. The named contracts are deliberately NOT here — they are
   * behind the paid call. The public claim is a count and a dollar figure, so nobody who
   * might merely be custodying a token is named on a public page.
   */
  integrators?: Integrators
  /** How many named-integrator rows were taken out before this board was published. */
  withheld?: { namedIntegrators?: number; namedIntegratorsRejected?: number }
  /** Which path produced this board. Set by the loaders below, never by the sweep. */
  source?: 'live' | 'committed'
}

export type IntegratorRole = 'AMM_POOL' | 'AMM_POOL_MANAGER' | 'CUSTODY' | 'DISTRIBUTOR'

/**
 * The sweep's integrator aggregate.
 *
 * Boards from before the distinct-address change carry only the first seven fields, and there
 * `contracts` and `notAware` count (address, token) PAIRS: the v4 PoolManager counted four times
 * and "25 of 66 contracts" was 17 contracts. `notApplicable` is present exactly when the counts are
 * distinct, so the wall uses it to tell the two shapes apart (see integratorView in ./present).
 */
export interface Integrators {
  scanned: number
  contracts: number
  notAware: number
  aware: number
  proxyUnresolved: number
  usdHeldByNotAware: number
  sharesUnaccounted: number
  notApplicable?: number
  tooSmall?: number
  noHolding?: number
  byRole?: Partial<Record<IntegratorRole, { contracts: number; usdHeld: number }>>
  usdHeldByNotApplicable?: number
  unpricedNotAware?: number
  unpricedNotApplicable?: number
  holdingsNotAware?: number
  holdingsNotApplicable?: number
  dustNotAware?: number
  unreadHoldings?: number
  minDivergence?: number
  assetsScanned?: string[]
  assetsBelowCutoff?: string[]
  assetsUnread?: string[]
}

const EMPTY: SweepData = {
  blockNumber: '0',
  observedAt: new Date(0).toISOString(),
  assetsScanned: 0,
  feedsAvailable: 0,
  marketClosed: false,
  cohort: { size: 0, stale: 0, clockHint: false },
  findings: [],
  rejected: [],
  chainNotes: [],
  stats: {},
  errors: [],
}

/**
 * The one class the wall never renders: it names a third-party CONTRACT rather than an asset.
 *
 * Mirrors NAMED_INTEGRATOR_CLASS in src/lib/redact.ts; web/ is a separate Vercel build and cannot
 * import from src/. A NOT_AWARE verdict establishes the absence of a call, not the presence of a
 * mistake, so the name is sold through the $0.25 audit and never printed here.
 */
export const NAMED_INTEGRATOR_CLASS = 'INTEGRATOR_NOT_MULTIPLIER_AWARE'

/**
 * The id every finding of that class carries (`integrator-<8 hex>-<SYMBOL>`, src/sweep/integrators.ts).
 *
 * Its pages are withheld, not missing. They answered with the 404 page, which says a finding that
 * stopped resolving "is not being hidden, it no longer holds": false for these, and served to anyone
 * following an old link or an id from the snapshot in git history. Every id of this shape gets the
 * same page, so it confirms nothing about whether one exists.
 */
export function isWithheldFindingId(id: string): boolean {
  return /^integrator-[0-9a-f]{8}-/.test(id)
}

/**
 * Whether a row may name a contract.
 *
 * A row of the class does. So does a row with no class whose subject is a bare address: the tables
 * print `symbolOf(subject)` in the "Asset read" column, which for an integrator row is the full
 * 42-character address, and a withheld row cannot prove its class to the wall.
 */
function namesIntegrator(f: { defectClass?: string; subject?: string } | null | undefined): boolean {
  if (!f) return false
  if (f.defectClass === NAMED_INTEGRATOR_CLASS) return true
  return f.defectClass === undefined && /^0x[0-9a-fA-F]{40}\b/.test(f.subject ?? '')
}

/**
 * The board as a public page may show it, whatever produced it.
 *
 * Every loader returns through here. The committed fallback named 17 contracts in 25 rows while the
 * page said "No contract is named on this page", and it was served on any non-200, timeout,
 * {available:false} or empty board, so filtering only the live path left the names one slow
 * response away. `rejected` is filtered too: detect.ts moves an integrator row there whenever its
 * verification fails, and stripping `findings` alone published the same names in the other table.
 *
 * Counts are added to any existing `withheld` rather than reset, so a board the sweep already
 * redacted keeps its own count and passing one through twice changes nothing.
 */
export function publicOnly(d: SweepData): SweepData {
  const findings = (d.findings ?? []).filter((f) => !namesIntegrator(f))
  const rejected = (d.rejected ?? []).filter((r) => !namesIntegrator(r?.finding))
  const droppedFindings = (d.findings ?? []).length - findings.length
  const droppedRejected = (d.rejected ?? []).length - rejected.length
  if (droppedFindings === 0 && droppedRejected === 0) return { ...d, findings, rejected }
  return {
    ...d,
    findings,
    rejected,
    withheld: {
      ...d.withheld,
      namedIntegrators: (d.withheld?.namedIntegrators ?? 0) + droppedFindings,
      namedIntegratorsRejected: (d.withheld?.namedIntegratorsRejected ?? 0) + droppedRejected,
    },
  }
}

function snapshotCandidates(): string[] {
  return [
    path.join(process.cwd(), 'data', 'findings.json'),
    path.join(process.cwd(), '..', 'data', 'findings.json'),
  ]
}

/**
 * Load the published sweep.
 *
 * Checks web/data first, then the repo-root data/. The prebuild step copies the root artifact
 * into web/data because Vercel only bundles files inside the project root — reading '../data'
 * works locally and silently yields an empty board once deployed.
 */
export function loadSweep(candidates: string[] = snapshotCandidates()): SweepData {
  for (const p of candidates) {
    if (!existsSync(p)) continue
    try {
      const parsed = JSON.parse(readFileSync(p, 'utf8')) as Partial<SweepData>
      return publicOnly({ ...EMPTY, ...parsed, source: 'committed' })
    } catch {
      /* try the next candidate */
    }
  }
  return { ...EMPTY, source: 'committed' }
}

/** Where the sweeper host publishes its current snapshot. */
export const LIVE_SNAPSHOT_URL = 'https://sonar.my.id/assay-mcp/findings.json'

/**
 * How long a fetched live board is reused before the next render re-fetches it.
 *
 * Every page view used to wait on an uncached ~113 KB fetch from the sweeper host, 2-4s from
 * Vercel against a 4s timeout, and each render spent the per-IP budget of that host's rate limiter,
 * whose 429 served the fallback. The feed itself sends `max-age=60` and changes once per 8-minute
 * sweep, so sixty seconds costs no freshness worth having.
 */
export const LIVE_REVALIDATE_SECONDS = 60

/**
 * The last live board this instance fetched, and when. Only a board that passed every check below
 * is kept, so a failure is never reused.
 *
 * The reuse was Next's data cache (`next.revalidate`), and once one fetch had succeeded on a
 * deployment the fallback stopped being reachable: Next serves a stale 200 entry indefinitely while
 * it revalidates in the background, and drops the AbortSignal on that background fetch
 * (patch-fetch.js, "don't pass through signal when revalidating"). Measured on `next start` with the
 * feed host blocked: the cached live board rendered as current, with no LIVE FEED UNREACHABLE badge
 * and no warning, while every view fired an untimed fetch at a host that was down. A memo in this
 * module keeps the sixty seconds of reuse, and every real fetch goes through the 4s timeout and the
 * fallback.
 */
let lastLive: { board: SweepData; at: number } | null = null

/** Drop the memo, so the next load fetches. */
export function forgetLiveBoard(): void {
  lastLive = null
}

/**
 * Prefer the LIVE snapshot, fall back to the copy committed at build time.
 *
 * The sweep runs on an 8-minute timer on the VPS, but this is a separate deployment reading a file
 * baked in at build time — so regenerating the artifact only fixed half the staleness. Every
 * citation on this wall carries a "reproduce this yourself" command against a block the public RPC
 * serves for 5,000-10,000 blocks at 0.101s each (measured), which means a board that only moves when someone
 * redeploys is publishing commands that stopped working hours earlier.
 *
 * The committed copy is the fallback rather than the source, so the sweeper host being unreachable
 * costs freshness — which the page then renders in the past tense behind a STALE badge — instead of
 * emptying the board. The result carries `source`, so the page can say which one it is showing
 * rather than presenting a build-time copy as the current sweep.
 */
export async function loadSweepLive(fallback: () => SweepData = loadSweep): Promise<SweepData> {
  const at = Date.now()
  if (lastLive && at - lastLive.at < LIVE_REVALIDATE_SECONDS * 1000) return lastLive.board
  const fallBack = (why: string): SweepData => {
    console.warn(`[wall] live feed unusable (${why}); rendering the committed snapshot`)
    return publicOnly({ ...fallback(), source: 'committed' })
  }
  try {
    const res = await fetch(LIVE_SNAPSHOT_URL, { cache: 'no-store', signal: AbortSignal.timeout(4000) })
    if (!res.ok) return fallBack(`HTTP ${res.status}`)
    const live = (await res.json()) as Partial<SweepData> & {
      available?: boolean
      unavailableReason?: string
    }
    /**
     * A 200 is not enough. The endpoint now serves an explicit `{available: false}` payload when
     * the sweeper host could not read its own artifact, and accepting that because `findings` is
     * an array meant the wall rendered an EMPTY BOARD in preference to the committed copy it was
     * supposed to fall back to. The comment promising that "the endpoint being down degrades
     * freshness rather than emptying the board" held only for a non-200.
     *
     * An empty findings array is also rejected: 195 assets have never once produced zero
     * findings, so zero here means something upstream failed, and the fallback is strictly
     * better than a blank page claiming everything is clean. It is counted AFTER redaction, so a
     * payload of nothing but named rows is empty too.
     */
    if (live.available === false) return fallBack(live.unavailableReason ?? 'available: false')
    if (!Array.isArray(live.findings)) return fallBack('no findings array')
    const board = publicOnly({ ...EMPTY, ...live, source: 'live' })
    if (board.findings.length === 0) return fallBack('empty board')
    lastLive = { board, at }
    return board
  } catch (err) {
    return fallBack((err as Error)?.name === 'TimeoutError' ? 'timed out after 4s' : String(err).slice(0, 120))
  }
}

export const SEV_RANK: Record<Severity, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
  info: 4,
}

export function symbolOf(subject: string): string {
  return subject.split(' ')[0] ?? subject
}

/**
 * How old a sweep may be before its PRESENT-TENSE claims stop being safe to make.
 *
 * The wall states live market conditions from a build-time snapshot. Rendered on a Saturday from
 * a Friday sweep, "market open" is a confident, wrong claim on the front page of a product whose
 * whole thesis is not confusing a scheduled closure with an incident. Past this age the same
 * facts are rendered in the past tense, as an observation, which is what they actually are.
 *
 * Twenty minutes, down from two hours. The sweep starts every 8 minutes and takes up to 262s
 * (measured over 140 runs on the host), `observedAt` is the block at its START, and this wall
 * reuses a fetched board for 60s: a healthy board is at most about 14 minutes old when rendered.
 * Two hours let a stalled timer, or a publish guard refusing run after run, keep present-tense
 * market claims on the page for fifteen missed sweeps. At twenty minutes one missed publish shows.
 */
export const SNAPSHOT_FRESH_MS = 20 * 60 * 1000

export function snapshotAge(observedAt: string, now: number = Date.now()): { ms: number; fresh: boolean } {
  const ms = now - new Date(observedAt).getTime()
  // An unparseable or absent timestamp is NOT fresh. Treating an unknown age as fresh is the same
  // error as treating an unread asset as clean, on the banner that states live market conditions.
  return { ms, fresh: Number.isFinite(ms) && ms >= 0 && ms < SNAPSHOT_FRESH_MS }
}

/**
 * How long the public RPC keeps serving a cited block: 5,000 blocks at 0.101s, the low end of the
 * measured 5,000-10,000. Past this, a "reproduce this yourself" command may get a missing-state
 * error, which makes the citation unchecked, not disproven.
 */
export const CITATION_RETENTION_MS = 505 * 1000

/**
 * Assets the sweep tried and could not read.
 *
 * `assetsScanned` counts assets ATTEMPTED, so a sweep that lost CRWD to an RPC error still said
 * "195 assets swept" while the critical row silently left the table. The same symbol can fail more
 * than once, so this is by symbol.
 */
export function unreadAssets(d: Pick<SweepData, 'errors'>): string[] {
  return [...new Set((d.errors ?? []).map((e) => e.symbol).filter(Boolean))].sort()
}

/**
 * The Stock Tokens whose multiplier is not 1, with their contract on chain 4663, read from the
 * board's own SHARE_COUNT_MISREAD_RISK rows (subject "SYM (0x…)"). These are the tokens where
 * balanceOf() and the share count differ, so they are what the wallet check reads.
 */
export function divergentTokens(d: Pick<SweepData, 'findings'>): Array<{ symbol: string; token: `0x${string}` }> {
  const out = new Map<string, { symbol: string; token: `0x${string}` }>()
  for (const f of d.findings ?? []) {
    if (f.defectClass !== 'SHARE_COUNT_MISREAD_RISK') continue
    const m = /^([A-Za-z0-9.\-]+) \((0x[0-9a-fA-F]{40})\)$/.exec(f.subject)
    if (m) out.set(m[2]!.toLowerCase(), { symbol: m[1]!, token: m[2] as `0x${string}` })
  }
  return [...out.values()].sort((a, b) => a.symbol.localeCompare(b.symbol))
}

/**
 * Replies from parties named in a finding, published verbatim.
 *
 * The wall footer used to promise a right of reply that had no implementation behind it. This is
 * the implementation: a committed file, keyed by finding id, rendered on the finding page.
 * See docs/RIGHT-OF-REPLY.md.
 */
export interface Reply {
  findingId: string
  from: string
  /** Published EXACTLY as received. Never trimmed, summarised or rebutted inline. */
  text: string
  receivedAt: string
  publishedAt: string
  /** Optional ASSAY response, always rendered as clearly separate from the reply itself. */
  assayResponse?: string
  /** Set when the reply led to a correction or withdrawal. */
  outcome?: 'correction' | 'withdrawn' | 'no-change'
  sourceUrl?: string
}

export function loadReplies(): Reply[] {
  const candidates = [
    path.join(process.cwd(), 'data', 'replies.json'),
    path.join(process.cwd(), '..', 'data', 'replies.json'),
  ]
  for (const p of candidates) {
    if (!existsSync(p)) continue
    try {
      const parsed = JSON.parse(readFileSync(p, 'utf8')) as { replies?: Reply[] }
      return parsed.replies ?? []
    } catch {
      /* try the next candidate */
    }
  }
  return []
}

export function repliesFor(findingId: string, all = loadReplies()): Reply[] {
  return all.filter((r) => r.findingId === findingId)
}
