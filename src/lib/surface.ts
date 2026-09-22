import { readFileSync, existsSync, statSync } from 'node:fs'
import { truePosition, didYouMean, type TruePosition } from './position.js'
import { fetchRhAssets } from './sources.js'
import { sweep } from '../sweep/detect.js'
import type { VerifiedFinding } from '../verify/index.js'
import type { DefectClass, Severity } from '../sweep/types.js'

/**
 * ONE definition of each answer, shared by every surface that sells it.
 *
 * The MCP server, the AgentKit action provider and the OpenServ agent each reimplemented the same
 * two calls with different wire shapes, different field names and different subsets of the data.
 * That is not only duplication: it means a buyer cannot use one endpoint to check another, which
 * is a strange property for a verification product. These are the canonical shapes.
 */

export const FINDINGS_PATH = 'data/findings.json'

export interface SweepSnapshot {
  blockNumber?: string
  observedAt?: string
  assetsScanned?: number
  marketClosed?: boolean
  cohort?: { size: number; read?: number; stale: number; failed?: number; quorum?: boolean }
  findings: VerifiedFinding[]
  rejected?: Array<{ reason: string; detail: string; finding: { id: string; subject: string } }>
  chainNotes?: Array<{ id: string; severity: Severity; title: string }>
}

const EMPTY: SweepSnapshot = { findings: [] }

/**
 * Cached read of the published sweep.
 *
 * The artifact is ~324 KB of JSON and was re-read and re-parsed on EVERY assay_findings call,
 * for a tool whose whole job is to filter it down to a handful of rows. Keyed on mtime so the
 * sweep timer's republish is picked up on the next call without any invalidation protocol.
 */
let cached: { mtimeMs: number; size: number; data: SweepSnapshot } | null = null

export function loadSnapshot(path = FINDINGS_PATH): SweepSnapshot {
  if (!existsSync(path)) return EMPTY
  try {
    const st = statSync(path)
    if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) return cached.data
    const data = JSON.parse(readFileSync(path, 'utf8')) as SweepSnapshot
    cached = { mtimeMs: st.mtimeMs, size: st.size, data }
    return data
  } catch {
    return cached?.data ?? EMPTY
  }
}

/** Age of the published snapshot, so every surface can say how old its answer is. */
export function snapshotAgeSeconds(snap: SweepSnapshot): number | null {
  if (!snap.observedAt) return null
  const ms = Date.now() - new Date(snap.observedAt).getTime()
  return Number.isFinite(ms) ? Math.round(ms / 1000) : null
}

const RANK: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 }

export interface FindingsQuery {
  symbol?: string
  defectClass?: DefectClass
  minSeverity?: Severity
  limit?: number
}

export function findingsPayload(q: FindingsQuery = {}, snap = loadSnapshot()) {
  let out = snap.findings
  if (q.symbol) out = out.filter((f) => f.subject.toUpperCase().startsWith(q.symbol!.toUpperCase()))
  if (q.defectClass) out = out.filter((f) => f.defectClass === q.defectClass)
  if (q.minSeverity) out = out.filter((f) => RANK[f.severity] <= RANK[q.minSeverity!])
  out = [...out].sort((a, b) => RANK[a.severity] - RANK[b.severity]).slice(0, q.limit ?? 25)
  const ageSeconds = snapshotAgeSeconds(snap)
  return {
    sweepBlock: snap.blockNumber,
    observedAt: snap.observedAt,
    /**
     * How old this answer is. Published because citations reference blocks this RPC serves for
     * roughly 5k-20k blocks at ~100ms each — so past about half an hour the cited bytes are no
     * longer re-fetchable and the caller deserves to know that before relying on them.
     */
    snapshotAgeSeconds: ageSeconds,
    snapshotStale: ageSeconds !== null && ageSeconds > 3600,
    totalPublished: snap.findings.length,
    totalWithheld: snap.rejected?.length ?? 0,
    marketClosed: snap.marketClosed,
    cohort: snap.cohort,
    count: out.length,
    findings: out,
  }
}

export function truePositionPayload(p: TruePosition) {
  return p
}

export interface CheckSymbolResult {
  error?: string
  didYouMean?: string | null
  symbol?: string
  block?: string
  observedAt?: string
  assetsScanned?: number
  marketClosed?: boolean
  cohort?: unknown
  published?: number
  rejectedByVerifier?: number
  findings?: VerifiedFinding[]
  chainNotes?: unknown
}

/**
 * Live single-symbol check.
 *
 * An unknown ticker used to be indistinguishable from a clean one: `assay_check_symbol('CRWDD')`
 * returned `{published: 0}` with no error, and CRWDD is one keystroke from CRWD, the only 4.0x
 * asset on the chain. "No findings" and "no such asset" are opposite answers and must read that way.
 */
export async function checkSymbol(symbol: string): Promise<CheckSymbolResult> {
  const assets = await fetchRhAssets()
  const known = assets.map((a) => a.tokenSymbol)
  const match = known.find((s) => s.toUpperCase() === symbol.toUpperCase())
  if (!match) {
    return {
      error:
        `${symbol} is not a Robinhood Stock Token on chain 4663. This is NOT a clean result — ` +
        `nothing was checked.`,
      didYouMean: didYouMean(symbol, known),
    }
  }

  const r = await sweep({ symbols: [match] })
  return {
    symbol: match,
    block: r.blockNumber,
    observedAt: r.observedAt,
    assetsScanned: r.assetsScanned,
    // Exposed because the wall shows the corroborating context and the paid surface did not: a
    // caller cannot tell an expected weekend closure from an incident without it.
    marketClosed: r.marketClosed,
    cohort: r.cohort,
    published: r.findings.length,
    rejectedByVerifier: r.rejected.length,
    findings: r.findings,
    chainNotes: r.chainNotes,
  }
}

export async function truePositionFor(symbol: string, holder: `0x${string}`) {
  return truePositionPayload(await truePosition(symbol, holder))
}

/**
 * The compact form of a live check, for surfaces whose caller is an LLM rather than a program.
 *
 * The OpenServ agent and the AgentKit action provider each built this shape by hand, with
 * different fields, so the same question asked through two of ASSAY's own endpoints came back
 * differently. One definition, two callers.
 */
export async function checkSymbolSummary(symbol: string) {
  const r = await checkSymbol(symbol)
  if (r.error) return { error: r.error, didYouMean: r.didYouMean }
  return {
    symbol: r.symbol,
    block: r.block,
    observedAt: r.observedAt,
    marketClosed: r.marketClosed,
    cohort: r.cohort,
    published: r.published,
    withheld: r.rejectedByVerifier,
    findings: (r.findings ?? []).map((f) => ({
      id: f.id,
      severity: f.severity,
      defectClass: f.defectClass,
      title: f.title,
      statement: f.statement,
      // Named on every row, because the contract in `subject` is usually not the party at fault.
      affectedParty: f.affectedParty,
      impact: f.impact,
      citationsVerified: `${f.verification.reproduced}/${f.verification.checked}`,
    })),
  }
}
