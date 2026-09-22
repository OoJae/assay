import { readFileSync, existsSync, statSync } from 'node:fs'
import { truePosition, didYouMean, type TruePosition } from './position.js'
import { fetchRhAssets, fetchChainlinkFeeds, feedForSymbol } from './sources.js'
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

/**
 * Where the published sweep lives.
 *
 * Overridable because on the production host it must NOT be the git-tracked path. The sweep timer
 * rewrites it every 8 minutes; if that is a tracked file, `git pull` aborts the moment the artifact
 * also changes upstream — and `git update-index --skip-worktree` does not help, which I verified
 * rather than assumed: with a local modification AND an upstream change to the same path, pull
 * still exits "Please commit your changes or stash them before you merge."
 *
 * So the host writes outside the working tree (ASSAY_FINDINGS_PATH=/home/ubuntu/assay-data/...),
 * deploys stay a plain `git pull`, and the committed copy remains what it was always meant to be:
 * the wall's fallback, not the live board.
 */
export const FINDINGS_PATH = process.env.ASSAY_FINDINGS_PATH || 'data/findings.json'

export interface SweepSnapshot {
  blockNumber?: string
  observedAt?: string
  assetsScanned?: number
  marketClosed?: boolean
  cohort?: { size: number; read?: number; stale: number; failed?: number; quorum?: boolean }
  findings: VerifiedFinding[]
  rejected?: Array<{ reason: string; detail: string; finding: { id: string; subject: string } }>
  chainNotes?: Array<{ id: string; severity: Severity; title: string }>
  /** False when no sweep could be loaded. An empty board and an absent one are different answers. */
  available?: boolean
  unavailableReason?: string
}

const EMPTY: SweepSnapshot = { findings: [], available: false }

/**
 * Cached read of the published sweep.
 *
 * The artifact is ~324 KB of JSON and was re-read and re-parsed on EVERY assay_findings call,
 * for a tool whose whole job is to filter it down to a handful of rows. Keyed on mtime so the
 * sweep timer's republish is picked up on the next call without any invalidation protocol.
 */
let cached: { mtimeMs: number; size: number; data: SweepSnapshot } | null = null

/**
 * The published sweep, or an explicit statement that there isn't one.
 *
 * FAILING OPEN WAS THE DEFECT. A missing or unparsable artifact returned a well-formed
 * `{findings: []}`, which findingsPayload then published as `totalPublished: 0` — indistinguishable
 * from a clean sweep that genuinely found nothing. A buyer asking "is this asset clean?" would be
 * told yes because a file was absent. `available` makes the difference explicit and every caller
 * surfaces it.
 */
export function loadSnapshot(path = FINDINGS_PATH): SweepSnapshot {
  if (!existsSync(path)) return { ...EMPTY, available: false, unavailableReason: `no sweep artifact at ${path}` }
  try {
    const st = statSync(path)
    if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) return cached.data
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as SweepSnapshot
    if (!Array.isArray(parsed.findings)) {
      return { ...EMPTY, available: false, unavailableReason: 'sweep artifact has no findings array' }
    }
    const data = { ...parsed, available: true }
    cached = { mtimeMs: st.mtimeMs, size: st.size, data }
    return data
  } catch (err) {
    if (cached?.data) return cached.data
    return {
      ...EMPTY,
      available: false,
      unavailableReason: `sweep artifact unreadable: ${(err as Error).message.slice(0, 120)}`,
    }
  }
}

/** Age of the published snapshot, so every surface can say how old its answer is. */
export function snapshotAgeSeconds(snap: SweepSnapshot): number | null {
  if (!snap.observedAt) return null
  const ms = Date.now() - new Date(snap.observedAt).getTime()
  return Number.isFinite(ms) ? Math.round(ms / 1000) : null
}

/**
 * How long a citation stays re-fetchable on the public Robinhood Chain RPC.
 *
 * Measured by binary-searching for the oldest block still serving state: retention sits between
 * 5,000 and 10,000 blocks, and block time is 0.101s. That is 505 to 1,010 seconds. The
 * conservative end is used, because claiming a citation is checkable when it is not is the
 * failure that matters here — the opposite error merely understates freshness.
 */
export const CITATION_LIFETIME_SECONDS = 505

const RANK: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 }

export interface FindingsQuery {
  symbol?: string
  defectClass?: DefectClass
  minSeverity?: Severity
  limit?: number
}

export function findingsPayload(q: FindingsQuery = {}, snap = loadSnapshot()) {
  let out = snap.findings
  if (q.symbol) {
    // EXACT ticker, not a prefix. `subject` is formatted "SYM (0x…)" or "SYM feed (0x…)", and
    // startsWith meant a caller asking about NVDA was handed findings for NVDAX — someone else's
    // asset, published under their own question. On a tool whose entire value is not confusing one
    // subject with another, a prefix match is the wrong comparison.
    const want = q.symbol.toUpperCase()
    out = out.filter((f) => (f.subject.split(' ')[0] ?? '').toUpperCase() === want)
  }
  if (q.defectClass) out = out.filter((f) => f.defectClass === q.defectClass)
  if (q.minSeverity) out = out.filter((f) => RANK[f.severity] <= RANK[q.minSeverity!])
  out = [...out].sort((a, b) => RANK[a.severity] - RANK[b.severity]).slice(0, q.limit ?? 25)
  const ageSeconds = snapshotAgeSeconds(snap)
  return {
    /**
     * False when no sweep could be loaded at all. A caller MUST distinguish this from a clean
     * result: `count: 0` with `available: false` means nothing was checked, not that nothing
     * was found.
     */
    available: snap.available !== false,
    ...(snap.unavailableReason ? { unavailableReason: snap.unavailableReason } : {}),
    sweepBlock: snap.blockNumber,
    observedAt: snap.observedAt,
    /**
     * How old this answer is, and whether its citations can still be re-fetched.
     *
     * MEASURED, not guessed. Binary-searching the public RPC for the oldest block still serving
     * state puts retention between 5,000 and 10,000 blocks, and block time at 0.101s — so cited
     * bytes stop being reproducible about 8 to 17 minutes after the sweep that minted them.
     *
     * The previous threshold here was 3600s, an hour, which meant the payload reported
     * `snapshotStale: false` for answers whose "reproduce this yourself" commands had been dead
     * for the better part of an hour. That is the project's own guarantee quietly expiring while
     * the payload says everything is fine.
     */
    snapshotAgeSeconds: ageSeconds,
    // An UNKNOWN age is stale, not fresh. `ageSeconds !== null && ...` reported snapshotStale:false
    // when there was no timestamp at all — the same error as reporting an unread asset as clean.
    snapshotStale: ageSeconds === null || ageSeconds > CITATION_LIFETIME_SECONDS,
    citationsReproducible: ageSeconds !== null && ageSeconds <= CITATION_LIFETIME_SECONDS,
    citationLifetimeSeconds: CITATION_LIFETIME_SECONDS,
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
  /** False when the asset could not be read at all — NOT the same as "checked and clean". */
  assessed?: boolean
  notAssessed?: string[]
  errors?: Array<{ symbol: string; error: string }>
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
  /**
   * An asset we FAILED TO READ must never read as clean on the surface people pay for.
   *
   * detect.ts records that case in `errors` — but nothing carried it out to a caller, so
   * `assay_check_symbol` returned `published: 0` for an asset whose uiMultiplier() read had failed
   * outright, which is indistinguishable from an asset that was checked and found sound. The fix
   * that put it in `errors` only helped whoever read the sweep artifact by hand.
   */
  const unread = r.errors.filter((e) => e.symbol.toUpperCase() === match.toUpperCase())
  return {
    symbol: match,
    block: r.blockNumber,
    observedAt: r.observedAt,
    assetsScanned: r.assetsScanned,
    /** True only when the asset was actually read. `published: 0` with this false means NOTHING was checked. */
    assessed: unread.length === 0,
    ...(unread.length ? { notAssessed: unread.map((e) => e.error) } : {}),
    errors: r.errors,
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
    assessed: r.assessed,
    ...(r.notAssessed ? { notAssessed: r.notAssessed } : {}),
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

/**
 * Audit ONE contract: does it handle ERC-8056, and what is it exposed on?
 *
 * The paid counterpart to the aggregate figures on the wall. The wall says "N contracts holding $X
 * cannot call uiMultiplier()"; this names one and shows the bytecode evidence.
 *
 * Deliberately answerable about ANY address, not only ones already on the board — the question
 * "is this counterparty multiplier-aware" is one an agent wants to ask before it acts, about an
 * address nobody has swept yet.
 */
export interface ContractAuditResult {
  address: string
  /** AWARE | NOT_AWARE | PROXY_UNRESOLVED | EOA | TOO_SMALL */
  verdict: string
  /** False when no claim is made — a proxy that could not be resolved. */
  conclusive: boolean
  codeSize: number
  /** The bytecode actually tested, which for a proxy is the implementation's. */
  testedCodeSize?: number
  implementation?: string
  proxyKind?: string
  beacon?: string
  codeHash: string
  blockNumber: string
  observedAt: string
  /** Divergent-multiplier Stock Tokens this address holds, and the exposure on each. */
  holdings: Array<{
    symbol: string
    token: string
    multiplier: number
    tokenUnits: number
    shareEquivalents: number
    sharesUnaccounted: number
    misreadPct: number
    usdHeld: number | null
  }>
  totalUsdHeld: number
  /** What this result does and does not establish. Always present. */
  interpretation: string
}

export async function auditContract(address: `0x${string}`): Promise<ContractAuditResult> {
  const { classifyIntegrator, integratorExposure } = await import('../sweep/integrators.js')
  const { rhClient } = await import('./chains.js')
  const { readFeed } = await import('../sweep/oracle.js')

  const blockNumber = await rhClient.getBlockNumber()
  const block = await rhClient.getBlock({ blockNumber })
  const observedAt = new Date(Number(block.timestamp) * 1000).toISOString()

  const reading = await classifyIntegrator(address, blockNumber)
  if (!reading) throw new Error(`could not read code at ${address}`)

  const [assets, feeds] = await Promise.all([fetchRhAssets(), fetchChainlinkFeeds()])
  const holdings: ContractAuditResult['holdings'] = []
  let totalUsdHeld = 0

  for (const a of assets) {
    const mult = Number((a as { currentMultiplier?: string }).currentMultiplier)
    if (!Number.isFinite(mult) || Math.abs(mult - 1) <= 0.002) continue
    const dep = a.deployments?.find((d: { chainId: number }) => d.chainId === 4663)
    if (!dep) continue

    const feed = feedForSymbol(feeds, a.tokenSymbol)
    let price: number | null = null
    if (feed) {
      const fr = await readFeed(feed.proxyAddress, feed.heartbeat, Number(block.timestamp), blockNumber)
      if (fr?.usable) price = fr.price
    }
    const e = await integratorExposure(reading, a.tokenSymbol, dep.contractAddress, mult, price)
    if (!e) continue
    holdings.push({
      symbol: e.symbol,
      token: e.token,
      multiplier: e.multiplier,
      tokenUnits: e.tokenUnits,
      shareEquivalents: e.shareEquivalents,
      sharesUnaccounted: e.sharesUnaccounted,
      misreadPct: e.misreadPct,
      usdHeld: e.usdHeld,
    })
    totalUsdHeld += e.usdHeld ?? 0
  }

  const conclusive = reading.verdict !== 'PROXY_UNRESOLVED'
  const interpretation =
    reading.verdict === 'AWARE'
      ? 'This bytecode references uiMultiplier(), so it is capable of making the ERC-8056 correction. That it CAN does not prove it always DOES.'
      : reading.verdict === 'NOT_AWARE'
        ? 'This bytecode does not reference uiMultiplier(), so it cannot make that call directly. IT MAY NOT NEED TO — a contract that only custodies or routes the token is not wrong to lack it. What is established is the absence of the call, not the presence of a mistake.'
        : reading.verdict === 'PROXY_UNRESOLVED'
          ? 'This is a proxy whose implementation could not be resolved, so NO CLAIM IS MADE either way. Unchecked is not disproven.'
          : reading.verdict === 'EOA'
            ? 'No code at this address. An externally owned account holds tokens through whatever software controls its key, which cannot be inspected on-chain.'
            : 'Too little bytecode to contain valuation logic — typically a stub or an unrecognised proxy. No claim is made.'

  return {
    address,
    verdict: reading.verdict,
    conclusive,
    codeSize: reading.codeSize,
    testedCodeSize: reading.testedCodeSize,
    implementation: reading.implementation,
    proxyKind: reading.proxyKind,
    beacon: reading.beacon,
    codeHash: reading.implementationCodeHash ?? reading.codeHash,
    blockNumber: blockNumber.toString(),
    observedAt,
    holdings,
    totalUsdHeld,
    interpretation,
  }
}
