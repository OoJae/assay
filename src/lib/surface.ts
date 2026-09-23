import { readFileSync, existsSync, statSync } from 'node:fs'
import { truePosition, didYouMean, type TruePosition } from './position.js'
import { fetchRhAssets, fetchChainlinkFeeds, feedForSymbol } from './sources.js'
import { sweep } from '../sweep/detect.js'
import type { VerifiedFinding } from '../verify/index.js'
import type { DefectClass, Evidence, Severity } from '../sweep/types.js'
import type { IntegratorRole, IntegratorVerdict } from '../sweep/integrators.js'
import { PAID_ENDPOINTS } from './endpoints.js'

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

// The publication rule for named integrators lives in redact.ts; re-exported for existing callers.
export { NAMED_INTEGRATOR_CLASS, withoutNamedIntegrators, redactSnapshot } from './redact.js'
import { NAMED_INTEGRATOR_CLASS, isNamedIntegrator, withoutNamedIntegrators } from './redact.js'

export function findingsPayload(q: FindingsQuery = {}, snap = loadSnapshot()) {
  // Public by default. A caller that explicitly filters for the class gets an empty list and the
  // note below, rather than silently receiving names it did not pay for.
  const publiclyNamed = q.defectClass === NAMED_INTEGRATOR_CLASS
  let out = withoutNamedIntegrators(snap.findings)
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
    /**
     * Named integrator findings exist but are not served here. The aggregate is public; the name
     * is the paid assay_check_contract call.
     */
    namedIntegratorsWithheld: snap.findings.length - withoutNamedIntegrators(snap.findings).length,
    ...(publiclyNamed
      ? {
          note:
            'INTEGRATOR_NOT_MULTIPLIER_AWARE findings name a third-party contract and are not ' +
            'returned on this endpoint. assay_check_contract(address) gives the free verdict for an ' +
            `address you supply; its holdings and evidence are the paid audit at ${PAID_ENDPOINTS.checkContract.trigger}.`,
        }
      : {}),
  }
}

export function truePositionPayload(p: TruePosition) {
  return p
}

/**
 * The free half of assay_true_position: whether a reading is safe to act on, and why not, without
 * the corrected position itself.
 *
 * The free MCP tool returned the same TruePosition the $0.01 x402 endpoint sells, so the paid tier
 * had nothing in it. The verdict stays free because refusing is the safety-critical half — a
 * caller about to move money learns that it should not, and why — and the figures are what is paid.
 */
export function truePositionVerdictPayload(p: TruePosition) {
  const paid = PAID_ENDPOINTS.truePosition
  return {
    symbol: p.symbol,
    holder: p.holder,
    blockNumber: p.blockNumber,
    observedAt: p.observedAt,
    confidence: p.confidence,
    refusalReason: p.refusalReason,
    /** Which safety checks completed. `false` means UNKNOWN, not OK. */
    checks: p.checks,
    fullAnswer: {
      priceUsd: paid.priceUsd,
      x402: paid.trigger,
      paywall: paid.paywall,
      note:
        'The share-equivalent count, token price, underlying share price and position value for this ' +
        `holder are the paid ${paid.capability} answer ($${paid.priceUsd} over x402).`,
    },
  }
}

export async function truePositionVerdict(symbol: string, holder: `0x${string}`) {
  return truePositionVerdictPayload(await truePosition(symbol, holder))
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

  /**
   * No integrator pass. It ran by default here, so this free tool returned every named
   * INTEGRATOR_NOT_MULTIPLIER_AWARE contract for the ticker, with full addresses and citations,
   * while the wall and /findings.json withheld the class. Names come only from the paid audit of an
   * address the buyer supplies. The pass was also most of this tool's RPC cost.
   */
  const r = await sweep({ symbols: [match], integrators: false })
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
    // Filtered as well, so a named row cannot reach this free tool even if the pass runs again.
    published: withoutNamedIntegrators(r.findings).length,
    rejectedByVerifier: r.rejected.filter((x) => !isNamedIntegrator(x.finding)).length,
    findings: withoutNamedIntegrators(r.findings),
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
  /** AWARE | NOT_AWARE | NOT_APPLICABLE | PROXY_UNRESOLVED | EOA | TOO_SMALL */
  verdict: IntegratorVerdict
  /** NOT_APPLICABLE only: what the contract was recognised as, and the functions it implements that said so. */
  role?: IntegratorRole
  roleSelectors?: string[]
  /**
   * False when this result does not settle the question: the proxy could not be resolved, or a
   * multiplier, balance or feed read failed. `incomplete` names the tokens affected.
   */
  conclusive: boolean
  /** Tokens whose multiplier, balance or feed read FAILED. Their exposure is unknown, not zero. */
  incomplete: string[]
  /** PROXY_UNRESOLVED only: which read failed. */
  unresolvedReason?: string
  codeSize: number
  /** The bytecode actually tested, which for a proxy is the implementation's. */
  testedCodeSize?: number
  implementation?: string
  proxyKind?: string
  beacon?: string
  codeHash: string
  blockNumber: string
  observedAt: string
  /** Stock Tokens whose on-chain uiMultiplier() is not exactly 1.0 at this block. Every one was checked. */
  divergentTokensChecked: number
  /** Divergent-multiplier Stock Tokens this address holds, and the exposure on each, all at `blockNumber`. */
  holdings: Array<{
    symbol: string
    token: string
    /** On-chain uiMultiplier() at `blockNumber`, 1e18 fixed point. */
    uiMultiplier: string
    multiplier: number
    tokenUnits: number
    shareEquivalents: number
    sharesUnaccounted: number
    misreadPct: number
    usdHeld: number | null
  }>
  /** Sum of usdHeld. null when any holding is unpriced or any read failed: unknown is not $0. */
  totalUsdHeld: number | null
  /** The priced holdings only — a lower bound whenever totalUsdHeld is null. */
  pricedUsdHeld: number
  /** Held tokens with no usable price. */
  unpricedSymbols: string[]
  /** Every read this result rests on, each re-runnable at its block. */
  evidence: Evidence[]
  /** What this result does and does not establish. Always present. */
  interpretation: string
}

async function head() {
  const { rhClient } = await import('./chains.js')
  const blockNumber = await rhClient.getBlockNumber()
  const block = await rhClient.getBlock({ blockNumber })
  return { blockNumber, nowSeconds: Number(block.timestamp), observedAt: new Date(Number(block.timestamp) * 1000).toISOString() }
}

/**
 * How long the paid audit keeps reading holdings before it answers with what it has.
 *
 * The OpenServ agent gives each capability 45s and x402 allows 60s. 30s leaves room for the head,
 * the classification and the directories before the scan, and for a read already in flight at
 * the deadline, while still covering the 28.5s the full scan took from a laptop.
 */
export const AUDIT_READ_BUDGET_MS = 30_000

/**
 * THE INVARIANT truePosition() holds applies here too: a read that did not complete is never
 * reported as one that found nothing. This dropped a failed balanceOf() with `continue`, counted an
 * unreadable price as $0 (`totalUsdHeld: 0` for a contract holding 444 CCL, which has no feed),
 * read balances at `latest` while citing the code at a pinned block, and quoted the REST registry's
 * multiplier as uiMultiplier(). Every read is now pinned to one block, the multiplier comes from the
 * chain, and anything that failed is named in `incomplete` with `conclusive: false`.
 *
 * The holdings scan stops reading AUDIT_READ_BUDGET_MS after the call starts; see scanHoldings.
 */
export async function auditContract(
  address: `0x${string}`,
  opts: { readBudgetMs?: number } = {},
): Promise<ContractAuditResult> {
  const { classifyIntegrator, holdingEvidence, integratorEvidence, scanHoldings, verdictInterpretation } =
    await import('../sweep/integrators.js')
  const deadline = Date.now() + (opts.readBudgetMs ?? AUDIT_READ_BUDGET_MS)

  const { blockNumber, nowSeconds, observedAt } = await head()
  const reading = await classifyIntegrator(address, blockNumber)
  if (!reading) throw new Error(`could not read code at ${address}`)

  const [assets, feeds] = await Promise.all([fetchRhAssets(), fetchChainlinkFeeds()])
  const tokens = assets.flatMap((a) => {
    const dep = a.deployments?.find((d: { chainId: number }) => d.chainId === 4663)
    return dep ? [{ symbol: a.tokenSymbol, token: dep.contractAddress, feed: feedForSymbol(feeds, a.tokenSymbol) }] : []
  })
  const scan = await scanHoldings(reading, tokens, blockNumber, nowSeconds, deadline)

  const holdings: ContractAuditResult['holdings'] = scan.holdings.map((e) => ({
    symbol: e.symbol,
    token: e.token,
    uiMultiplier: e.uiMultiplier.toString(),
    multiplier: e.multiplier,
    tokenUnits: e.tokenUnits,
    shareEquivalents: e.shareEquivalents,
    sharesUnaccounted: e.sharesUnaccounted,
    misreadPct: e.misreadPct,
    usdHeld: e.usdHeld,
  }))
  const pricedUsdHeld = holdings.reduce((t, h) => t + (h.usdHeld ?? 0), 0)
  const totalKnown = scan.incomplete.length === 0 && scan.unpriced.length === 0

  const gaps: string[] = []
  const failed = scan.incomplete.filter((sym) => !scan.outOfTime.includes(sym))
  if (failed.length)
    gaps.push(
      `${failed.length} token read(s) failed (${failed.join(', ')}), so the holdings ` +
        `listed are INCOMPLETE and no total is given. This is not a clean result.`,
    )
  if (scan.outOfTime.length)
    gaps.push(
      `${scan.outOfTime.length} token(s) were not read before this audit's ` +
        `${Number(((opts.readBudgetMs ?? AUDIT_READ_BUDGET_MS) / 1000).toFixed(1))}s read budget ran out ` +
        `(${scan.outOfTime.join(', ')}), so the holdings listed are INCOMPLETE ` +
        `and no total is given. The RPC was slow; this is not a clean result.`,
    )
  if (scan.unpriced.length)
    gaps.push(
      `${scan.unpriced.length} holding(s) have no usable price (${scan.unpriced.join(', ')}), so no dollar ` +
        `total is given; pricedUsdHeld is a lower bound.`,
    )

  return {
    address,
    verdict: reading.verdict,
    ...(reading.role ? { role: reading.role, roleSelectors: reading.roleSelectors } : {}),
    conclusive: reading.verdict !== 'PROXY_UNRESOLVED' && scan.incomplete.length === 0,
    incomplete: scan.incomplete,
    ...(reading.unresolvedReason ? { unresolvedReason: reading.unresolvedReason } : {}),
    codeSize: reading.codeSize,
    testedCodeSize: reading.testedCodeSize,
    implementation: reading.implementation,
    proxyKind: reading.proxyKind,
    beacon: reading.beacon,
    codeHash: reading.implementationCodeHash ?? reading.codeHash,
    blockNumber: blockNumber.toString(),
    observedAt,
    divergentTokensChecked: scan.divergent.length,
    holdings,
    totalUsdHeld: totalKnown ? pricedUsdHeld : null,
    pricedUsdHeld,
    unpricedSymbols: scan.unpriced,
    evidence: [
      ...integratorEvidence(reading, blockNumber, observedAt),
      ...scan.holdings.flatMap((e) => holdingEvidence(e, observedAt)),
    ],
    interpretation: [verdictInterpretation(reading), ...gaps].join(' '),
  }
}

/**
 * The FREE answer about one contract: its verdict, and nothing about what it holds.
 *
 * The public MCP served the whole auditContract() result, holdings and dollars included, for free
 * and at the cheap rate limit, while the same answer was sold for $0.25 over x402. The verdict is
 * the part an agent needs before it acts ("can this counterparty make the ERC-8056 correction?"),
 * so it stays free; the exposure figures are the paid audit, and this says where to get them.
 */
export interface ContractVerdict {
  address: string
  blockNumber: string
  observedAt: string
  verdict: IntegratorVerdict
  /** NOT_APPLICABLE only. */
  role?: IntegratorRole
  codeHash: string
  /** False when no claim is made either way — the proxy could not be resolved. */
  conclusive: boolean
  /** What the verdict does and does not establish. A bare NOT_AWARE reads as an accusation. */
  interpretation: string
  fullAudit: { priceUsd: number; x402: string; paywall: string; note: string }
}

export async function contractVerdict(address: `0x${string}`): Promise<ContractVerdict> {
  const { classifyIntegrator, verdictInterpretation } = await import('../sweep/integrators.js')
  const { blockNumber, observedAt } = await head()
  const reading = await classifyIntegrator(address, blockNumber)
  if (!reading) throw new Error(`could not read code at ${address}`)
  const paid = PAID_ENDPOINTS.checkContract
  return {
    address,
    blockNumber: blockNumber.toString(),
    observedAt,
    verdict: reading.verdict,
    ...(reading.verdict === 'NOT_APPLICABLE' && reading.role ? { role: reading.role } : {}),
    codeHash: reading.implementationCodeHash ?? reading.codeHash,
    conclusive: reading.verdict !== 'PROXY_UNRESOLVED',
    interpretation: verdictInterpretation(reading),
    fullAudit: {
      priceUsd: paid.priceUsd,
      x402: paid.trigger,
      paywall: paid.paywall,
      note:
        'Which divergent-multiplier Stock Tokens this address holds, the share-equivalents and dollars ' +
        `at stake on each, and the cited reads behind them, are the paid ${paid.capability} audit ` +
        `($${paid.priceUsd} over x402).`,
    },
  }
}
