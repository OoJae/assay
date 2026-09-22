import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'

export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'info'

export interface Evidence {
  claim: string
  chainId: number
  contract: string
  call: string
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
  impact: { basisPoints?: number; percent?: number; note: string }
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
   * behind the paid/MCP call. The public claim is a count and a dollar figure, so nobody who
   * might merely be custodying a token is named on a public page.
   */
  integrators?: {
    scanned: number
    contracts: number
    notAware: number
    aware: number
    proxyUnresolved: number
    usdHeldByNotAware: number
    sharesUnaccounted: number
  }
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
 * Load the published sweep.
 *
 * Checks web/data first, then the repo-root data/. The prebuild step copies the root artifact
 * into web/data because Vercel only bundles files inside the project root — reading '../data'
 * works locally and silently yields an empty board once deployed.
 */
export function loadSweep(): SweepData {
  const candidates = [
    path.join(process.cwd(), 'data', 'findings.json'),
    path.join(process.cwd(), '..', 'data', 'findings.json'),
  ]
  for (const p of candidates) {
    if (!existsSync(p)) continue
    try {
      return { ...EMPTY, ...(JSON.parse(readFileSync(p, 'utf8')) as Partial<SweepData>) }
    } catch {
      /* try the next candidate */
    }
  }
  return EMPTY
}

/** Where the sweeper host publishes its current snapshot. */
export const LIVE_SNAPSHOT_URL = 'https://sonar.my.id/assay-mcp/findings.json'

/**
 * Prefer the LIVE snapshot, fall back to the copy committed at build time.
 *
 * The sweep runs on a 30-minute timer on the VPS, but this is a separate deployment reading a file
 * baked in at build time — so regenerating the artifact only fixed half the staleness. Every
 * citation on this wall carries a "reproduce this yourself" command against a block the public RPC
 * serves for 5,000-10,000 blocks at 0.101s each (measured), which means a board that only moves when someone
 * redeploys is publishing commands that stopped working hours earlier.
 *
 * The committed copy is the fallback rather than the source, so the sweeper host being unreachable
 * costs freshness — which the page then renders in the past tense behind a STALE badge — instead of
 * emptying the board. Both paths are the same shape, so nothing downstream knows which one it got.
 */
export async function loadSweepLive(): Promise<SweepData> {
  try {
    const res = await fetch(LIVE_SNAPSHOT_URL, {
      cache: 'no-store',
      signal: AbortSignal.timeout(4000),
    })
    if (res.ok) {
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
       * better than a blank page claiming everything is clean.
       */
      if (live.available === false) return loadSweep()
      if (Array.isArray(live.findings) && live.findings.length > 0) return { ...EMPTY, ...live }
    }
  } catch {
    /* fall through to the committed copy */
  }
  return loadSweep()
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
 */
export const SNAPSHOT_FRESH_MS = 2 * 60 * 60 * 1000

export function snapshotAge(observedAt: string): { ms: number; fresh: boolean } {
  const ms = Date.now() - new Date(observedAt).getTime()
  // An unparseable or absent timestamp is NOT fresh. Treating an unknown age as fresh is the same
  // error as treating an unread asset as clean, on the banner that states live market conditions.
  return { ms, fresh: Number.isFinite(ms) && ms >= 0 && ms < SNAPSHOT_FRESH_MS }
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
