import type { ChainNote, Finding, Severity } from './types.js'
import { evidence, readFeed, readStockToken } from './oracle.js'
import {
  CHAINLINK_FEEDS_URL,
  COHORT_CLOSURE_FRACTION,
  REOPEN_SETTLE_MINUTES,
  RH_ASSETS_URL,
  RH_PRICES_URL,
  fetchChainlinkFeeds,
  fetchRhAssets,
  fetchRhUnderlyingPrice,
  feedForSymbol,
  is24x5,
  isEquityMarketClosed,
  scheduledClosure,
  type ChainlinkFeed,
  type RhAsset,
} from '../lib/sources.js'
import { rhClient } from '../lib/chains.js'
import { verifyFindingDetailed, type VerifiedFinding, type RejectedFinding } from '../verify/index.js'
import {
  INTEGRATOR_ROLES,
  classifyIntegrator,
  integratorExposure,
  integratorFinding,
  isMaterial,
  readMultiplier,
  readPrice,
  recentCounterparties,
  type IntegratorReading,
  type IntegratorRole,
  type PriceRead,
} from './integrators.js'

/**
 * The methodology a finding was produced under. It appears on every finding so a subject can
 * reproduce their own grade, which only works if it MOVES when the rules move.
 *
 * v0.3.0 changed what is published, not just how it reads:
 *  - SHARE_COUNT_MISREPORT -> SHARE_COUNT_MISREAD_RISK, and `subject` no longer implies fault
 *  - new ORACLE_STALE_INDETERMINATE, and cohort conclusions now require an 80% read quorum
 *  - ORACLE_PAUSED and PENDING_CORPORATE_ACTION now cite the bytes they actually fetched
 *  - CROSS_SURFACE_PRICE_MIX no longer asserts a cause for a residual it did not test
 *
 * v0.4.0 changed what a finding measures and when it is raised, so v0.3.0 results (the committed
 * hard-trials run among them) must not be resumed or compared as if they were the same rules:
 *  - SHARE_COUNT_MISREAD_RISK severity and impact.basisPoints measure |1 - 1/m|, the understatement
 *    (CRWD 7,500 bps, was 30,000), and every numeric impact says what it measures
 *  - the weekend closure is decided by the New York clock first, a feed gets a 600s delivery grace
 *    past its heartbeat, and a closure the cohort did not corroborate no longer claims it did
 *  - integrators: NOT_APPLICABLE for pools, pool managers, custody and distributors, counts of
 *    distinct contracts, and a materiality floor below which nothing is named
 */
export const METHODOLOGY_VERSION = 'assay-rh-v0.4.0'

/**
 * How often to re-read the chain head during a sweep.
 *
 * The public RPC serves state for 5,000-10,000 blocks (measured) and Robinhood Chain produces 0.101s
 * blocks, so a single block captured at sweep start is unusable by the end of a 194-asset run.
 * Refreshing per asset keeps every citation inside the retention window, which is what makes
 * inline verification possible at all.
 */
const BLOCK_REFRESH_EVERY = 1

/** ERC-8056 uiMultiplier() is 1e18 fixed point regardless of the token's own decimals(). */
const ONE_E18 = 10n ** 18n

/**
 * How many counterparties to classify per divergent asset.
 *
 * Each one costs an eth_getCode plus possibly a storage read and a balanceOf. The sweep has to
 * finish inside the 8-minute cadence that keeps its own citations re-fetchable, so this is a
 * budget, not a judgement about how many exist — and the aggregate reports `scanned` so the
 * coverage is stated rather than implied.
 */
const INTEGRATOR_SCAN_CAP = 40

/**
 * Which divergent assets the integrator pass scans: those whose ON-CHAIN multiplier is more than
 * 0.2% from 1.0. Measured on 2026-09-22, that is 9 of the 34 divergent assets (CRWD, CCL, PR, UPS,
 * LHX, SGOV, UNH, KSS, ORCL); SPY, NVDA, AAPL and the rest move by less.
 *
 * A budget, not a judgement, for the same reason as INTEGRATOR_SCAN_CAP: each scanned asset costs
 * five getLogs windows plus up to 40 classifications, and scanning all 34 would roughly quadruple a
 * pass that has to finish inside the 8-minute cadence. The cutoff and the assets it left out are
 * both reported in the aggregate, so the coverage is stated rather than implied. The paid
 * single-address audit has no such budget and checks every divergent token.
 */
export const INTEGRATOR_MIN_DIVERGENCE = 0.002

/**
 * Cohort pre-pass cache.
 *
 * Measured: reading the 35 24/5 feeds SEQUENTIALLY took ~50s of a 62s single-symbol sweep, which
 * blew past the default MCP client timeout and made assay_check_symbol unusable over the wire.
 *
 * Two fixes. First, the reads now run in bounded-concurrency batches. Second, the result is cached:
 * market open/close is a property of the clock, not of the symbol being swept, so re-deriving it
 * per call was pure waste. The TTL is short because the whole point is catching the transition.
 */
const COHORT_TTL_MS = 60_000
const COHORT_CONCURRENCY = 10

/**
 * How much of the cohort must actually be READ before its answer is allowed to decide anything.
 *
 * Below this, "how many feeds are stale" is not a measurement, it is a guess with a denominator.
 */
const COHORT_READ_QUORUM = 0.8

export interface CohortMeasurement {
  /** Feeds in the 24/5 cohort. */
  size: number
  /** Reads that came back. The ONLY honest denominator. */
  read: number
  /** Reads that failed after retries. Previously counted as "fresh". */
  failed: number
  /** Of the feeds that were read, how many were past heartbeat. */
  stale: number
  /** True when enough of the cohort was read to draw any conclusion at all. */
  quorum: boolean
  clockHint: boolean
  marketClosed: boolean
  /** The block the cohort was measured at — NOT necessarily the block a finding cites. */
  blockNumber: string
}

let cohortCache: { at: number; m: CohortMeasurement } | null = null

/**
 * Measure the cohort, counting failures as failures.
 *
 * THE BUG THIS REPLACES. The old version did `Boolean(r?.stale)`, so a feed whose read threw
 * counted as NOT STALE — silently fresh. The consequence ran one way only: fewer apparent stale
 * feeds means `scheduledClosure` is less likely to fire, which means a weekend-stale feed gets
 * classified ORACLE_STALE_UNEXPECTED — high or critical severity, "stale DURING MARKET HOURS" —
 * instead of the expected-by-design medium. RPC flakiness was therefore biased toward ACCUSING a
 * subject, which inverts the stated intent of the whole project.
 *
 * It is also invisible to the byte verifier by construction: the fabricated quantity is the
 * DENOMINATOR of a cohort statistic, and a denominator carries no citation to re-fetch.
 */
async function measureCohort(
  feeds: ChainlinkFeed[],
  read: (f: ChainlinkFeed) => Promise<boolean | null>,
  concurrency: number,
): Promise<{ stale: number; read: number; failed: number }> {
  let index = 0
  let stale = 0
  let ok = 0
  let failed = 0
  const workers = Array.from({ length: Math.min(concurrency, feeds.length) }, async () => {
    for (;;) {
      const i = index++
      const feed = feeds[i]
      if (!feed) return
      const r = await read(feed)
      if (r === null) failed++
      else {
        ok++
        if (r) stale++
      }
    }
  })
  await Promise.all(workers)
  return { stale, read: ok, failed }
}

function sev(bps: number): Severity {
  if (bps >= 1000) return 'critical'
  if (bps >= 100) return 'high'
  if (bps >= 10) return 'medium'
  if (bps > 0) return 'low'
  return 'info'
}

function rhDeployment(a: RhAsset) {
  return a.deployments?.find((d) => d.chainId === 4663) ?? a.deployments?.[0]
}

export interface SweepOptions {
  /** Limit assets scanned; undefined = all */
  limit?: number
  /** Only these symbols */
  symbols?: string[]
  /** Progress callback: (done, total, symbol) */
  onProgress?: (done: number, total: number, symbol: string) => void
  /** Run the integrator pass. Defaults on; disable for a fast asset-only sweep. */
  integrators?: boolean
  /**
   * Verify every citation before returning. ON BY DEFAULT and strongly recommended:
   * the public RPC serves state for only 5,000-10,000 blocks, so verification MUST happen in
   * the same window as detection or citations become permanently uncheckable.
   */
  verify?: boolean
}

export interface SweepResult {
  blockNumber: string
  observedAt: string
  /** True when the 24/5 schedule, or on a weekday the cohort going stale together, says the US equity market is shut. */
  marketClosed: boolean
  /** Verifiable observations with no on-chain citation (absences). Never mixed into findings. */
  chainNotes: ChainNote[]
  cohort: CohortMeasurement
  assetsScanned: number
  feedsAvailable: number
  findings: VerifiedFinding[]
  /** Findings that failed verification and were never published, with the reason. */
  rejected: RejectedFinding[]
  stats: {
    divergentMultipliers: number
    staleFeeds: number
    staleUnexpected: number
    /** Stale, but the cohort could not be read well enough to say why. */
    staleIndeterminate: number
    missingFeeds: number
    pausedOracles: number
  }
  errors: Array<{ symbol: string; error: string }>
  /**
   * AGGREGATE integrator exposure, for the public wall.
   *
   * The named contracts live in `findings` (class INTEGRATOR_NOT_MULTIPLIER_AWARE) and are served
   * only through the paid surface. The wall gets counts and dollars, so the public claim is
   * "N contracts holding $X cannot call uiMultiplier()" without naming anyone who might merely be
   * custodying the token.
   */
  integrators: IntegratorAggregate
}

/**
 * Every contract COUNT here is of DISTINCT ADDRESSES. They used to be (address, token) pairs, so the
 * v4 PoolManager counted four times and the wall's "25 of 66 contracts" was 17 contracts. Pair
 * counts are kept, under names that say so (`holdings*`).
 *
 * Every dollar figure sums PRICED holdings only. A holding with no usable feed is counted in
 * `unpriced*` instead of adding $0, so a dollar figure is a lower bound whenever its unpriced count
 * is above zero.
 */
export interface IntegratorAggregate {
  /** Distinct counterparty addresses examined. */
  scanned: number
  /** Distinct examined addresses with code. */
  contracts: number
  /** Distinct NOT_AWARE contracts holding a nonzero balance of a scanned token. */
  notAware: number
  /** Distinct contracts whose logic references uiMultiplier(). */
  aware: number
  /** Distinct proxies that could not be resolved. No claim is made about them. */
  proxyUnresolved: number
  /** Distinct NOT_APPLICABLE contracts (AMM pools, pool managers, custody, distributors) holding a scanned token. */
  notApplicable: number
  /** Distinct contracts with too little code to hold valuation logic. */
  tooSmall: number
  /** Distinct NOT_AWARE or NOT_APPLICABLE contracts that held none of the scanned tokens at the block. */
  noHolding: number
  /** NOT_APPLICABLE broken down by what each contract was recognised as. */
  byRole: Record<IntegratorRole, { contracts: number; usdHeld: number }>
  /** Priced NOT_AWARE holdings, balance x feed price. A lower bound when `unpricedNotAware` > 0. */
  usdHeldByNotAware: number
  /** Priced NOT_APPLICABLE holdings. A lower bound when `unpricedNotApplicable` > 0. */
  usdHeldByNotApplicable: number
  /** (address, token) holdings with no usable price, left out of the dollar sums. */
  unpricedNotAware: number
  unpricedNotApplicable: number
  /** (address, token) holdings, NOT_AWARE and NOT_APPLICABLE. */
  holdingsNotAware: number
  holdingsNotApplicable: number
  /** NOT_AWARE holdings below the materiality floor: counted above, never named. */
  dustNotAware: number
  /** |share-equivalents - raw balance| summed over NOT_AWARE holdings. */
  sharesUnaccounted: number
  /** (address, token) balance reads that failed. Not counted anywhere above, and not zero. */
  unreadHoldings: number
  /** The divergence cutoff, as a fraction (0.002 = 0.2%). */
  minDivergence: number
  /** Divergent assets whose holders were scanned. */
  assetsScanned: string[]
  /** Divergent assets at or under the cutoff, not scanned. */
  assetsBelowCutoff: string[]
  /**
   * Divergent assets not scanned because a read failed: uiMultiplier() could not be re-read at the
   * integrator block, or not one window of Transfer logs could be read.
   */
  assetsUnread: string[]
}

export async function sweep(opts: SweepOptions = {}): Promise<SweepResult> {
  const blockNumber = await rhClient.getBlockNumber()
  const block = await rhClient.getBlock({ blockNumber })
  const nowSeconds = Number(block.timestamp)
  const observedAt = new Date(nowSeconds * 1000).toISOString()

  const [assets, feeds] = await Promise.all([fetchRhAssets(), fetchChainlinkFeeds()])

  let scope = assets.filter((a) => rhDeployment(a))
  if (opts.symbols?.length) {
    const want = new Set(opts.symbols.map((s) => s.toUpperCase()))
    scope = scope.filter((a) => want.has(a.tokenSymbol.toUpperCase()))
  }
  if (opts.limit) scope = scope.slice(0, opts.limit)

  // ---- Cohort pre-pass -------------------------------------------------------------
  // Measure how many of the 24/5 equity feeds are stale RIGHT NOW. If nearly all of them
  // are, the market is shut and the staleness is scheduled — not 35 independent failures.
  const cohort = feeds.filter(is24x5)
  const clockHint = isEquityMarketClosed(nowSeconds)

  let cohortM: CohortMeasurement
  const cached = cohortCache && Date.now() - cohortCache.at < COHORT_TTL_MS ? cohortCache.m : null
  if (cached) {
    cohortM = cached
  } else {
    const { stale, read, failed } = await measureCohort(
      cohort,
      async (f) => {
        const r = await readFeed(f.proxyAddress, f.heartbeat, nowSeconds, blockNumber)
        return r === null ? null : r.stale
      },
      COHORT_CONCURRENCY,
    )
    // Decide on what was actually read. `scheduledClosure` takes a fraction, so handing it the
    // full cohort size as the denominator when a third of the reads failed understates the
    // stale fraction and pushes the classifier toward "incident".
    const quorum = cohort.length === 0 ? false : read / cohort.length >= COHORT_READ_QUORUM
    const marketClosed = quorum ? scheduledClosure(stale, read, clockHint) : false
    cohortM = {
      size: cohort.length,
      read,
      failed,
      stale,
      quorum,
      clockHint,
      marketClosed,
      blockNumber: blockNumber.toString(),
    }
    cohortCache = { at: Date.now(), m: cohortM }
  }
  const cohortStale = cohortM.stale
  const marketClosed = cohortM.marketClosed
  opts.onProgress?.(
    0,
    scope.length,
    `cohort: ${cohortM.stale}/${cohortM.read} stale (${cohortM.failed} unread) -> ` +
      (cohortM.quorum ? (marketClosed ? 'MARKET CLOSED' : 'market open') : 'INDETERMINATE'),
  )

  const findings: Finding[] = []
  /** Assets with no published Chainlink feed. Reported as ChainNotes, never as Findings. */
  const missingFeedAssets: Array<{ symbol: string; token: `0x${string}`; multiplier: number }> = []
  const stats = {
    divergentMultipliers: 0,
    staleFeeds: 0,
    staleUnexpected: 0,
    staleIndeterminate: 0,
    missingFeeds: 0,
    pausedOracles: 0,
  }

  let done = 0
  const errors: Array<{ symbol: string; error: string }> = []
  const verified: VerifiedFinding[] = []
  const rejected: RejectedFinding[] = []
  const shouldVerify = opts.verify !== false
  let lastBlock = blockNumber
  let lastObservedAt = observedAt
  let lastNow = nowSeconds
  /** Each asset's ON-CHAIN uiMultiplier(), for the integrator pass to gate on instead of REST. */
  const onChainMultiplier = new Map<string, bigint>()

  for (const asset of scope) {
    const dep = rhDeployment(asset)!
    const token = dep.contractAddress
    const sym = asset.tokenSymbol
    done++
    opts.onProgress?.(done, scope.length, sym)

    // Captured OUTSIDE the try. It used to live inside it, so a throw after findings had been
    // pushed left them stranded in the array: never spliced out, never verified, and then swept
    // wholesale into `verified` by the `!shouldVerify` tail. The splice moved to `finally` for
    // the same reason.
    const before = findings.length
    try {
      // Fresh head per asset so this asset's citations are minted at a block still served.
      if (done % BLOCK_REFRESH_EVERY === 0) {
        lastBlock = await rhClient.getBlockNumber()
        const b = await rhClient.getBlock({ blockNumber: lastBlock })
        lastNow = Number(b.timestamp)
        lastObservedAt = new Date(lastNow * 1000).toISOString()
      }
      const blockNumber = lastBlock
      const observedAt = lastObservedAt
      const nowSeconds = lastNow
    const reading = await readStockToken(token, blockNumber)
    if (!reading) {
      // Recorded, not silently skipped. A bare `continue` meant a failed uiMultiplier() read (or a
      // pruned block) dropped the asset with no trace: `errors` stayed empty, `assetsScanned`
      // still counted it, and the wall reported a clean sweep over assets it had never read.
      errors.push({ symbol: sym, error: 'uiMultiplier() unreadable at this block — asset not assessed' })
      continue
    }

    const feed: ChainlinkFeed | null = feedForSymbol(feeds, sym)
    const mult = reading.multiplierFloat
    const divergenceBps = Math.abs(mult - 1) * 10_000
    /**
     * A zero or non-finite multiplier is a BROKEN READ, not a 100%-divergent asset.
     *
     * misreadPct guards with `mult > 0 ? ... : 0`, so the impact reported 0% — while divergenceBps
     * stayed |0-1|*10000 = 10000, which sev() maps to CRITICAL. That published a critical finding
     * against a named asset whose own impact field said the effect was zero, which is not a
     * statement anyone should be able to screenshot.
     */
    const multiplierUsable = mult > 0 && Number.isFinite(mult)
    if (!multiplierUsable) {
      errors.push({
        symbol: sym,
        error: `uiMultiplier() returned ${reading.multiplier.toString()} — not a usable scaling factor, asset not assessed`,
      })
      continue
    }
    onChainMultiplier.set(sym, reading.multiplier)
    /**
     * How much a raw balanceOf() understates the true share count, as a percentage of the TRUE
     * value. This is bounded by 100% by construction.
     *
     * The previous formulation reported `divergenceBps` as "understates by N bps", which for CRWD
     * printed "understates it by 30000.0 bps" — i.e. 300%. An understatement cannot exceed 100%:
     * that figure was the ratio expressed as a gain (true = 4x raw), not an understatement.
     * It was the headline number on the wall and in the README.
     */
    /**
     * Signed on purpose, and named for what it is.
     *
     * (1 - 1/mult) is NEGATIVE when the multiplier is below 1 — a reverse split, which ERC-8056
     * permits and Robinhood has not done yet but can. That published the title "understates by
     * -300.0000%", which is not a sentence anyone should read on an audit finding. The magnitude
     * and the direction are now separated, so the copy says "overstates" when it overstates.
     */
    const misreadPct = mult > 0 ? (1 - 1 / mult) * 100 : 0
    const understatementPct = Math.abs(misreadPct)
    const direction = misreadPct >= 0 ? 'understates' : 'overstates'
    /**
     * The same quantity in basis points, and the one severity is graded on.
     *
     * basisPoints used to be |m - 1| while percent was |1 - 1/m|, so the flagship CRWD page read
     * "30,000 bps · 75%": two different measures side by side, the first being the "300%" framing
     * retired above. One metric now, in two units.
     */
    const understatementBps = understatementPct * 100

    // --- Class 4: share-count misreport (only meaningful when multiplier != 1) ---
    if (multiplierUsable && divergenceBps > 0.01) {
      stats.divergentMultipliers++
      // C-9: scale by the token's OWN decimals(), read above and previously discarded while the
      // code hardcoded 1e18. Divide in bigint first so a large supply keeps full precision, then
      // convert once at the end.
      // Scale by the token's OWN decimals(). When that read failed the supply figure is simply
      // not quoted — the same treatment totalSupply itself gets — rather than assuming 18.
      const unit = reading.decimals === null ? null : 10n ** BigInt(reading.decimals)
      /**
       * totalSupply is CORROBORATING, not load-bearing.
       *
       * The finding is about uiMultiplier(): a caller reading balanceOf() as shares is wrong by the
       * multiplier whatever the supply happens to be. So when the supply read failed, the finding
       * still stands — it simply stops quoting a number it does not have, and stops citing bytes
       * nobody returned. Previously it published `totalSupply() == 0` against the literal bytes
       * `0x`, which the verifier then correctly refused to reproduce, discarding the whole finding.
       */
      const haveSupply =
        reading.totalSupply !== null && reading.rawTotalSupply !== null && unit !== null
      const rawShares = haveSupply ? Number((reading.totalSupply! * 10_000n) / unit!) / 10_000 : null
      const trueShares = haveSupply
        ? Number((reading.totalSupply! * reading.multiplier * 10_000n) / (unit! * ONE_E18)) / 10_000
        : null
      findings.push({
        id: `${sym}-share-count`,
        defectClass: 'SHARE_COUNT_MISREAD_RISK',
        severity: sev(understatementBps),
        subject: `${sym} (${token})`,
        affectedParty:
          `Any integrator that presents ${sym} balanceOf() as a share count. The contract itself ` +
          `is behaving as ERC-8056 specifies and is not at fault.`,
        title: `${sym}: reading balanceOf() as shares ${direction} by ${understatementPct.toFixed(4)}% (multiplier ${mult.toFixed(9)}x)`,
        statement:
          `${sym} reports uiMultiplier() = ${reading.multiplier.toString()} (${mult.toFixed(9)}), which is ` +
          `CORRECT AND SPEC-COMPLIANT behaviour under ERC-8056 — this finding is not a defect in the ` +
          `token contract. It records the exposure carried by a caller that reads balanceOf() as shares. ` +
          `Under ERC-8056 a corporate action moves the multiplier rather than balances, so balanceOf() ` +
          `returns tokens and share-equivalents = balance * uiMultiplier() / 1e18. A surface presenting ` +
          `the raw balance as a share count ${direction} it by ${understatementPct.toFixed(4)}% ` +
          `(the true count is ${mult.toFixed(4)}x the raw balance). ` +
          `Token value computed as balance * Chainlink feed price is unaffected, because the feed is already multiplier-adjusted.`,
        impact: {
          basisPoints: Number(understatementBps.toFixed(2)),
          /** Understatement as a share of the TRUE value. Bounded by 100% by construction. */
          percent: Number(understatementPct.toFixed(4)),
          measures: `how far a raw balanceOf() read as shares ${direction} the true share count, as a share of the true count`,
          note:
            (rawShares !== null && trueShares !== null
              ? `totalSupply raw ${rawShares.toFixed(4)} tokens vs ${trueShares.toFixed(4)} share-equivalents ` +
                `(delta ${(trueShares - rawShares).toFixed(4)}). `
              : `totalSupply() or decimals() could not be read at this block, so no supply figure is quoted — the finding rests ` +
                `on uiMultiplier(), which is byte-verified below. `) +
            `Presenting the raw balance as a share count ` +
            `${direction} by ${understatementPct.toFixed(4)}%; equivalently the true count is ${mult.toFixed(4)}x the raw.`,
        },
        evidence: [
          evidence(`uiMultiplier() == ${reading.multiplier}`, token, 'uiMultiplier()', reading.rawMultiplier, blockNumber, observedAt),
          // Only cited when it was actually read. A citation is a promise that these exact bytes
          // came back from this exact call at this exact block.
          ...(haveSupply
            ? [
                evidence(
                  `totalSupply() == ${reading.totalSupply}`,
                  token,
                  'totalSupply()',
                  reading.rawTotalSupply!,
                  blockNumber,
                  observedAt,
                ),
              ]
            : []),
        ],
        methodologyVersion: METHODOLOGY_VERSION,
        detectedAt: observedAt,
      })
    }

    // --- Class 3: no price feed at all ---
    //
    // This is an assertion of ABSENCE: "no Chainlink feed is published for this asset". An absence
    // cannot be proven by an eth_call, so it MUST NOT be published as a Finding — a Finding carries
    // the byte-verified guarantee, and the only citation available here (uiMultiplier()) does not
    // test the claim at all.
    //
    // It previously was a Finding, and the consequence was severe: 159 of 201 published findings
    // asserted an absence while citing an unrelated multiplier read, so 79% of the wall carried a
    // "citations reproduced byte-for-byte" badge for a claim its citation could not support. The
    // rule was already stated in types.ts and again above the ChainNote block below, and broken here.
    //
    // Collected and emitted as ChainNotes, which carry checkable `sources[]` instead of citations.
    if (!feed) {
      stats.missingFeeds++
      missingFeedAssets.push({ symbol: sym, token, multiplier: mult })
    }

    // --- Classes 1 + 2: feed present -> staleness and cross-surface mixing ---
    if (feed) {
      const reading2 = await readFeed(feed.proxyAddress, feed.heartbeat, nowSeconds, blockNumber)
      if (!reading2) {
        // Symmetric with the unreadable-token case above, and it was missing here.
        // `if (reading2) { ... }` had no else, so a feed whose latestRoundData() could not be read
        // produced silence: no finding, no error, and a caller asking about that asset was told
        // nothing was wrong with it. "We could not read the oracle" is not "the oracle is fine".
        errors.push({
          symbol: sym,
          error: `Chainlink feed ${feed.proxyAddress} unreadable at this block — staleness not assessed`,
        })
      }
      if (reading2) {
        if (reading2.stale) {
          stats.staleFeeds++
          // EXPECTED vs UNEXPECTED vs UNKNOWN. Reporting every weekend-stale equity feed as an
          // incident invites the obvious rebuttal ("that's just the weekend") and would be sloppy.
          // But asserting EITHER answer when we could not read the cohort is worse than sloppy:
          // it lets our own RPC flakiness pick a subject's severity, and it always picked the
          // harsher one, because an unread feed used to count as "not stale".
          const equity = is24x5(feed)
          /**
           * INDETERMINATE applies to ANY feed, not just equities.
           *
           * This was gated on `equity &&`, so a crypto feed past its heartbeat skipped the
           * indeterminate branch entirely and went straight to ORACLE_STALE_UNEXPECTED at high or
           * critical — even when the cohort read had failed and we had no idea whether something
           * market-wide was happening. The quorum exists to stop our own RPC flakiness picking a
           * subject's severity; excluding a whole class of feeds from it defeated that.
           *
           * A crypto feed is never explained by an equity closure, so `scheduled` stays
           * equity-only. But "we could not measure the cohort" is a statement about US, and it is
           * true regardless of what kind of feed we are looking at.
           */
          const indeterminate = !cohortM.quorum
          const scheduled = equity && cohortM.quorum && marketClosed
          /**
           * A closure the clock called is not one the cohort corroborated.
           *
           * The clock decides first now (src/lib/sources.ts), so on a Saturday morning the market is
           * closed with 1 of 35 feeds stale. The statement used to say "1 of the 35 feeds ... are
           * stale, which corroborates a scheduled market closure" on every scheduled finding, a
           * false sentence on a byte-verified finding. It only claims corroboration when the cohort
           * actually went stale together.
           */
          const corroborated = cohortM.read > 0 && cohortM.stale / cohortM.read >= COHORT_CLOSURE_FRACTION
          if (!scheduled && !indeterminate) stats.staleUnexpected++
          if (indeterminate) stats.staleIndeterminate++
          // C-6: the cohort was measured at ITS OWN block, up to ~17 minutes before this asset's
          // block on a full sweep — a spread wider than this RPC's entire retention window. The
          // statement used to claim both were "at this same block".
          const cohortWhen =
            cohortM.blockNumber === blockNumber.toString()
              ? 'at this same block'
              : `at block ${cohortM.blockNumber} (this finding cites block ${blockNumber})`
          // The title printed the TOTAL age as "Xh past heartbeat", so a weekend feed 23.9h late
          // read as 47.9h late. It now states both, and says which is which.
          const hours = (s: number) => `${Number((s / 3600).toFixed(1))}h`
          const lateness =
            `feed ${hours(reading2.ageSeconds)} old, ` +
            `${hours(reading2.ageSeconds - feed.heartbeat)} past its ${hours(feed.heartbeat)} heartbeat`
          findings.push({
            id: `${sym}-stale-feed`,
            defectClass: indeterminate
              ? 'ORACLE_STALE_INDETERMINATE'
              : scheduled
                ? 'ORACLE_STALE_MARKET_CLOSED'
                : 'ORACLE_STALE_UNEXPECTED',
            severity: indeterminate
              ? 'medium'
              : scheduled
                ? 'medium'
                : reading2.ageSeconds > feed.heartbeat * 2
                  ? 'critical'
                  : 'high',
            subject: `${sym} feed (${feed.proxyAddress})`,
            affectedParty:
              `Any caller pricing ${sym} from this feed without checking updatedAt against the ` +
              `published ${feed.heartbeat}s heartbeat.`,
            title: indeterminate
              ? `${sym}: ${lateness} (cause undetermined — cohort unread)`
              : scheduled
                ? `${sym}: ${lateness} (market closed — no on-chain signal)`
                : `${sym}: ${lateness} DURING MARKET HOURS`,
            statement:
              `latestRoundData() for ${sym} returns updatedAt = ${reading2.updatedAt}, which is ` +
              `${reading2.ageSeconds} seconds (${(reading2.ageSeconds / 3600).toFixed(2)} hours) before the current block timestamp, ` +
              `exceeding the feed's published heartbeat of ${feed.heartbeat}s. The call still returns a price. ` +
              (indeterminate
                ? `Whether this is a scheduled closure or an oracle incident is NOT DETERMINED: only ` +
                  `${cohortM.read} of the ${cohortM.size} 24/5 equity feeds could be read ${cohortWhen} ` +
                  `(${cohortM.failed} reads failed), which is below the ${Math.round(COHORT_READ_QUORUM * 100)}% ` +
                  `quorum this methodology requires before drawing a market-wide conclusion. The staleness ` +
                  `itself is byte-verified; its cause is not claimed. ` +
                  `Robinhood's documentation requires callers to check updatedAt against the heartbeat either way.`
                : scheduled
                  ? `This feed is marked marketHours="${feed.docs?.marketHours}" and ` +
                    (corroborated
                      ? `${cohortM.stale} of the ${cohortM.read} 24/5 equity feeds that could be read ${cohortWhen} ` +
                        `are stale, which corroborates a scheduled market closure rather than an oracle incident. `
                      : `the US equity market is closed per the published 24/5 schedule (Friday 20:00 to Sunday ` +
                        `20:00 New York time, plus ${REOPEN_SETTLE_MINUTES} minutes for the feeds to refresh after the ` +
                        `reopen); ${cohortM.stale} of the ${cohortM.read} 24/5 equity feeds that could be read ` +
                        `${cohortWhen} are past their heartbeat so far. The cohort does not go stale together at ` +
                        `the close: each feed's heartbeat runs from its own last update before it. `) +
                    `The staleness is therefore EXPECTED BY DESIGN. It is reported because the contract gives callers no on-chain ` +
                    `way to distinguish it: latestRoundData() returns a price either way, and marketHours exists only in ` +
                    `off-chain metadata. Robinhood's documentation requires callers to check updatedAt against the heartbeat. ` +
                    `A caller without that guard is pricing off data up to ${(reading2.ageSeconds / 3600).toFixed(1)} hours old.`
                  : `Only ${cohortM.stale} of the ${cohortM.read} 24/5 equity feeds that could be read ${cohortWhen} ` +
                    `are stale, so this is NOT a market-wide closure and the staleness is unexpected for this feed ` +
                    `specifically. Robinhood's documentation requires callers to check updatedAt against the heartbeat.`),
            impact: {
              note:
                (reading2.price === null
                  ? `The feed's decimals() could not be read at this block, so no dollar figure is quoted here — the staleness itself comes from updatedAt and is byte-verified. `
                  : `Price ${reading2.price.toFixed(4)} is `) +
                `${(reading2.ageSeconds / 3600).toFixed(2)}h stale. Any valuation, liquidation or collateral check reading this feed without a staleness guard is using data from ${new Date(Number(reading2.updatedAt) * 1000).toISOString()}.`,
            },
            evidence: [
              evidence(
                `latestRoundData().updatedAt == ${reading2.updatedAt} (age ${reading2.ageSeconds}s > heartbeat ${feed.heartbeat}s)`,
                feed.proxyAddress,
                'latestRoundData()',
                reading2.raw,
                blockNumber,
                observedAt,
              ),
            ],
            methodologyVersion: METHODOLOGY_VERSION,
            detectedAt: observedAt,
          })
        }

        // Cross-surface mixing: quantify what an off-chain share price would do.
        // CROSS-SURFACE NEEDS A PRICE. Unlike staleness, this finding IS a statement about two
        // numbers, so it is simply not made when one of them is unknown.
        if (multiplierUsable && divergenceBps > 1 && reading2.price !== null && reading2.usable) {
          const under = await fetchRhUnderlyingPrice(sym)
          if (under && under.mid > 0) {
            const predicted = under.mid * mult
            const residualPct = ((reading2.price - predicted) / predicted) * 100
            const effectPct = (mult - 1) * 100
            /**
             * Does the multiplier relationship actually EXPLAIN the two quotes?
             *
             * The statement used to assert the residual was "attributable to bid/ask spread and
             * quote timing" without ever testing that. Measured across the divergent set, in 6 of
             * 10 cases the residual EXCEEDED the effect it was being subtracted from, once with
             * the opposite sign — so the sentence was an explanation offered for a number that
             * did not support it. The residual is now reported as an observation, and a cause is
             * only suggested when it is small relative to the effect.
             */
            const residualExplained = Math.abs(residualPct) < Math.abs(effectPct) / 2
            findings.push({
              id: `${sym}-cross-surface`,
              defectClass: 'CROSS_SURFACE_PRICE_MIX',
              severity: sev(divergenceBps),
              subject: `${sym} (${token})`,
              affectedParty:
                `Any caller that values ${sym} with an off-chain SHARE price, or computes a ` +
                `premium/discount between the on-chain token price and an off-chain share price.`,
              title: `${sym}: off-chain share price and on-chain token price differ by ${effectPct.toFixed(3)}%`,
              statement:
                `The Chainlink feed returns a multiplier-adjusted TOKEN price (${reading2.price.toFixed(4)}), while ` +
                `Robinhood's REST /prices endpoint returns the RAW UNDERLYING share price (mid ${under.mid.toFixed(4)}). ` +
                `These are different quantities related by uiMultiplier(): underlying x ${mult.toFixed(9)} = ${predicted.toFixed(4)}, ` +
                `leaving a residual of ${residualPct.toFixed(3)}% against the observed feed price. ` +
                (residualExplained
                  ? `That residual is small relative to the ${effectPct.toFixed(3)}% multiplier effect, consistent with ` +
                    `bid/ask spread and the timing gap between the REST quote and the feed's updatedAt. `
                  : `That residual is NOT small relative to the ${effectPct.toFixed(3)}% multiplier effect, so it is ` +
                    `reported as an observation and no cause is asserted for it. Bid/ask spread and quote timing are ` +
                    `plausible contributors but are not established here; a trading halt on the underlying would also ` +
                    `produce it, and this sweep does not test that. `) +
                `The finding stands on the multiplier relationship itself, which is byte-verified: valuing balanceOf() ` +
                `with an off-chain share price, or computing a premium/discount between an on-chain token price and an ` +
                `off-chain share price, produces a phantom error of ${effectPct.toFixed(3)}%.`,
              impact: {
                basisPoints: Number(divergenceBps.toFixed(2)),
                percent: Number(((mult - 1) * 100).toFixed(4)),
                measures: 'how far the on-chain token price differs from the off-chain share price, as a share of the share price',
                note: `feed ${reading2.price.toFixed(4)} vs underlying-mid ${under.mid.toFixed(4)} x multiplier ${mult.toFixed(9)} = ${predicted.toFixed(4)}`,
              },
              evidence: [
                evidence(`uiMultiplier() == ${reading.multiplier}`, token, 'uiMultiplier()', reading.rawMultiplier, blockNumber, observedAt),
                evidence(`latestRoundData().answer == ${reading2.answer}`, feed.proxyAddress, 'latestRoundData()', reading2.raw, blockNumber, observedAt),
              ],
              // The underlying mid is an off-chain quote and CANNOT be byte-verified. Disclosed
              // with provenance so the verification badge is not read as covering it.
              offChainSources: [
                {
                  url: RH_PRICES_URL(sym),
                  describes: `underlying share bid/ask used for the mid ${under.mid.toFixed(4)} (not multiplier-adjusted)`,
                  fetchedAt: under.generatedAt || observedAt,
                },
              ],
              methodologyVersion: METHODOLOGY_VERSION,
              detectedAt: observedAt,
            })
          }
        }
      }
    }

    // --- oracle paused / pending corporate action ---
    //
    // Both of these used to cite bytes they had not fetched. ORACLE_PAUSED hand-built its
    // rawReturn in source; PENDING_CORPORATE_ACTION attached uiMultiplier()'s bytes to a
    // newUIMultiplier() claim, which reproduces only while the two are equal — that is, only
    // while the finding is NOT true. The moment a corporate action was genuinely pending, the
    // verifier would mismatch and discard the highest-value early warning this tool can emit as
    // fabrication. Both now cite what was actually read.
    if (reading.oraclePaused === true && reading.rawOraclePaused) {
      stats.pausedOracles++
      findings.push({
        id: `${sym}-oracle-paused`,
        defectClass: 'ORACLE_PAUSED',
        severity: 'high',
        subject: `${sym} (${token})`,
        affectedParty: `Any caller taking a price-dependent action on ${sym} while this flag is set.`,
        title: `${sym}: oraclePaused() is true`,
        statement: `${sym} reports oraclePaused() == true. Robinhood's documentation requires callers to respect this flag; prices should not be trusted while it is set.`,
        impact: { note: 'Any price-dependent action on this asset is unsafe until the flag clears.' },
        evidence: [
          evidence('oraclePaused() == true', token, 'oraclePaused()', reading.rawOraclePaused, blockNumber, observedAt),
        ],
        methodologyVersion: METHODOLOGY_VERSION,
        detectedAt: observedAt,
      })
    }

    // Gate on ON-CHAIN state, not the REST registry. The off-chain `pendingMultiplier` field was
    // the trigger while the citation was on-chain, so the two could disagree and the finding
    // would fire with nothing on-chain to support it.
    const pendingOnChain =
      reading.pendingMultiplier !== null &&
      reading.pendingMultiplier !== reading.multiplier &&
      reading.rawPendingMultiplier !== null
    if (pendingOnChain) {
      const newMult = Number(reading.pendingMultiplier) / 1e18
      const effective = reading.effectiveAt !== null && reading.effectiveAt > 0n
        ? new Date(Number(reading.effectiveAt) * 1000).toISOString()
        : (asset.pendingMultiplierEffectiveTime ?? 'unknown')
      const ev = [
        evidence(
          `newUIMultiplier() == ${reading.pendingMultiplier}`,
          token,
          'newUIMultiplier()',
          reading.rawPendingMultiplier!,
          blockNumber,
          observedAt,
        ),
        evidence(
          `uiMultiplier() == ${reading.multiplier}`,
          token,
          'uiMultiplier()',
          reading.rawMultiplier,
          blockNumber,
          observedAt,
        ),
      ]
      if (reading.rawEffectiveAt) {
        ev.push(
          evidence(
            `effectiveAt() == ${reading.effectiveAt}`,
            token,
            'effectiveAt()',
            reading.rawEffectiveAt,
            blockNumber,
            observedAt,
          ),
        )
      }
      findings.push({
        id: `${sym}-pending-ca`,
        defectClass: 'PENDING_CORPORATE_ACTION',
        severity: 'medium',
        subject: `${sym} (${token})`,
        affectedParty:
          `Any caller holding a cached ${sym} multiplier, or displaying share-equivalents computed ` +
          `before ${effective}.`,
        title: `${sym}: corporate action pending — multiplier moves ${mult.toFixed(9)} -> ${newMult.toFixed(9)}`,
        statement:
          `${sym} reports newUIMultiplier() = ${reading.pendingMultiplier} (${newMult.toFixed(9)}) against a current ` +
          `uiMultiplier() of ${reading.multiplier} (${mult.toFixed(9)}), effective ${effective}. Under ERC-8056 the ` +
          `corporate action moves the multiplier rather than balances, so balanceOf() will not change and any cached ` +
          `multiplier, or any share-equivalent figure derived from one, becomes wrong at the effective time. The ` +
          `Chainlink feed price is multiplier-adjusted and steps with it.`,
        impact: {
          percent: Number((((newMult - mult) / mult) * 100).toFixed(4)),
          measures: 'how much the share-equivalent count of a fixed balance changes at the effective time',
          note:
            `Share-equivalents for a fixed balance change by ${(((newMult - mult) / mult) * 100).toFixed(4)}% at ` +
            `${effective}. Cached multipliers become wrong at that instant.`,
        },
        evidence: ev,
        methodologyVersion: METHODOLOGY_VERSION,
        detectedAt: observedAt,
      })
    }
    } catch (err) {
      // One bad asset must never kill a 194-asset sweep.
      errors.push({ symbol: sym, error: (err as Error).message.slice(0, 160) })
    } finally {
      // Verify THIS asset's findings right now, while its block is still served — including on
      // the throw path, so a partially-built asset either publishes verified findings or none.
      if (shouldVerify) {
        const fresh = findings.splice(before)
        for (const f of fresh) {
          try {
            const r = await verifyFindingDetailed(f)
            if (r.ok) verified.push(r.finding)
            else rejected.push(r.rejected)
          } catch (verifyErr) {
            // A verifier failure is never a licence to publish unverified.
            rejected.push({
              finding: f,
              reason: 'unchecked',
              detail: `verification threw: ${(verifyErr as Error).message.slice(0, 160)}`,
              results: [],
            })
          }
        }
      }
    }
  }

  if (!shouldVerify) verified.push(...(findings as VerifiedFinding[]))

  // ---- Integrator pass ------------------------------------------------------------
  //
  // Everything above audits ASSETS, all of which behave exactly as ERC-8056 specifies. This pass
  // audits the contracts that HOLD them, which is where the exposure actually is: measured on this
  // chain, ~80% of the addresses touching these tokens are contracts.
  //
  // Only DIVERGENT assets are scanned. Where the multiplier is 1.0 there is nothing to misread, so
  // naming a contract would be pure noise about a party with no exposure at all.
  //
  // Gated on the ON-CHAIN multiplier from the asset pass, then re-read at the block the holdings
  // are read at, so the multiplier a finding quotes is the one it cites. It used to be the REST
  // registry's value, printed as "uiMultiplier() = X" with no citation behind it.
  const integrators: IntegratorAggregate = {
    scanned: 0,
    contracts: 0,
    notAware: 0,
    aware: 0,
    proxyUnresolved: 0,
    notApplicable: 0,
    tooSmall: 0,
    noHolding: 0,
    byRole: Object.fromEntries(
      INTEGRATOR_ROLES.map((r) => [r, { contracts: 0, usdHeld: 0 }]),
    ) as IntegratorAggregate['byRole'],
    usdHeldByNotAware: 0,
    usdHeldByNotApplicable: 0,
    unpricedNotAware: 0,
    unpricedNotApplicable: 0,
    holdingsNotAware: 0,
    holdingsNotApplicable: 0,
    dustNotAware: 0,
    sharesUnaccounted: 0,
    unreadHoldings: 0,
    minDivergence: INTEGRATOR_MIN_DIVERGENCE,
    assetsScanned: [],
    assetsBelowCutoff: [],
    assetsUnread: [],
  }

  if (opts.integrators !== false) {
    const seen = new Set<string>()
    /** One classification per ADDRESS: the same pool or router turns up under several tokens. */
    const classified = new Map<`0x${string}`, IntegratorReading | null>()
    const holding = { notAware: new Set<string>(), notApplicable: new Set<string>(), unread: new Set<string>() }
    for (const asset of scope) {
      const sym = asset.tokenSymbol
      const onChain = onChainMultiplier.get(sym)
      // Unread in the asset pass (already in `errors`), or exactly 1.0: nothing to gate on.
      if (onChain === undefined || onChain === ONE_E18) continue
      if (Math.abs(Number(onChain) / 1e18 - 1) <= INTEGRATOR_MIN_DIVERGENCE) {
        integrators.assetsBelowCutoff.push(sym)
        continue
      }
      const dep = rhDeployment(asset)
      if (!dep) continue
      const m = await readMultiplier(sym, dep.contractAddress, lastBlock)
      if (!m) {
        // Kept out of `errors`, which the publish guard reads as unread ASSETS.
        integrators.assetsUnread.push(sym)
        continue
      }
      // Read the holders BEFORE counting the asset as scanned: `assetsScanned` is the public
      // coverage statement, and an asset whose first Transfer-log window failed had no holder read.
      const counterparties = await recentCounterparties(dep.contractAddress, lastBlock)
      if (counterparties.windowsRead === 0) {
        integrators.assetsUnread.push(sym)
        continue
      }
      integrators.assetsScanned.push(sym)

      // A failed feed read leaves the price unknown: those holdings are counted as unpriced.
      const feed = feedForSymbol(feeds, sym)
      const price: PriceRead | null = feed ? (await readPrice(feed, lastNow, lastBlock)).price : null

      for (const addr of [...counterparties.addrs].slice(0, INTEGRATOR_SCAN_CAP)) {
        const key = `${addr}:${sym}`
        if (seen.has(key)) continue
        seen.add(key)

        let reading = classified.get(addr)
        if (reading === undefined) {
          reading = await classifyIntegrator(addr, lastBlock)
          classified.set(addr, reading)
        }
        if (!reading || (reading.verdict !== 'NOT_AWARE' && reading.verdict !== 'NOT_APPLICABLE')) continue

        const x = await integratorExposure(reading, m, price)
        if (x.status === 'unreadable') {
          integrators.unreadHoldings++
          holding.unread.add(addr)
          continue
        }
        if (x.status === 'empty') continue
        const e = x.exposure

        if (reading.verdict === 'NOT_APPLICABLE') {
          // Its own line, never inside the NOT_AWARE headline, and never named.
          holding.notApplicable.add(addr)
          integrators.holdingsNotApplicable++
          if (e.usdHeld === null) integrators.unpricedNotApplicable++
          else {
            integrators.usdHeldByNotApplicable += e.usdHeld
            if (reading.role) integrators.byRole[reading.role].usdHeld += e.usdHeld
          }
          continue
        }

        holding.notAware.add(addr)
        integrators.holdingsNotAware++
        integrators.sharesUnaccounted += Math.abs(e.sharesUnaccounted)
        if (e.usdHeld === null) integrators.unpricedNotAware++
        else integrators.usdHeldByNotAware += e.usdHeld
        // Counted, never named.
        if (!isMaterial(e)) {
          integrators.dustNotAware++
          continue
        }

        const f = integratorFinding(e, lastBlock, lastObservedAt, METHODOLOGY_VERSION)
        if (shouldVerify) {
          try {
            const r = await verifyFindingDetailed(f)
            if (r.ok) verified.push(r.finding)
            else rejected.push(r.rejected)
          } catch (err) {
            rejected.push({
              finding: f,
              reason: 'unchecked',
              detail: `verification threw: ${(err as Error).message.slice(0, 160)}`,
              results: [],
            })
          }
        } else {
          verified.push(f as VerifiedFinding)
        }
      }
    }

    // Distinct-address counts, once every holding has been read. The aggregate counts what was
    // read at the pinned block; verification gates only the named finding.
    for (const [addr, r] of classified) {
      integrators.scanned++
      if (!r || r.verdict === 'EOA') continue
      integrators.contracts++
      if (r.verdict === 'AWARE') integrators.aware++
      else if (r.verdict === 'PROXY_UNRESOLVED') integrators.proxyUnresolved++
      else if (r.verdict === 'TOO_SMALL') integrators.tooSmall++
      else if (r.verdict === 'NOT_AWARE' && holding.notAware.has(addr)) integrators.notAware++
      else if (r.verdict === 'NOT_APPLICABLE' && holding.notApplicable.has(addr)) {
        integrators.notApplicable++
        if (r.role) integrators.byRole[r.role].contracts++
      } else if (!holding.unread.has(addr)) integrators.noHolding++
    }
  }

  // ---- Chain-level notes -----------------------------------------------------------
  // Absences. These carry sources a third party can check, not eth_call citations, so they
  // are reported separately from findings and never inherit the byte-verified guarantee.
  const chainNotes: ChainNote[] = []
  const hasUptimeFeed = feeds.some((f) => /sequencer|uptime/i.test(f.name ?? ''))
  if (!hasUptimeFeed) {
    chainNotes.push({
      id: 'rh-chain-no-sequencer-uptime-feed',
      severity: 'high',
      title: 'Robinhood Chain publishes no L2 sequencer-uptime feed, yet its docs require checking one',
      statement:
        `Robinhood's oracle documentation instructs callers to "verify the sequencer is up before trusting a price" ` +
        `because during a sequencer outage feeds can go stale. No such feed could be found: the Robinhood Chain ` +
        `Chainlink reference-data directory contains ${feeds.length} feeds and none is a sequencer-uptime feed, and ` +
        `chain 4663 does not appear on Chainlink's L2 Sequencer Uptime Feeds page, which lists Arbitrum, Base, Celo, ` +
        `Mantle, MegaETH, Metis, OP, Scroll, Soneium, X Layer and ZKsync. The recommended control therefore cannot be ` +
        `performed on this chain today. Stated as "not found in the published directories" rather than "does not exist".`,
      sources: [
        'https://docs.robinhood.com/chain/oracles-and-price-feeds/',
        'https://reference-data-directory.vercel.app/feeds-robinhood-mainnet.json',
        'https://docs.chain.link/data-feeds/l2-sequencer-feeds',
      ],
      observedAt,
    })
  }

  if (missingFeedAssets.length) {
    const withMultiplier = missingFeedAssets.filter((a) => Math.abs(a.multiplier - 1) > 1e-9)
    chainNotes.push({
      id: 'rh-chain-assets-without-price-feed',
      severity: withMultiplier.length ? 'high' : 'medium',
      title: `${missingFeedAssets.length} of ${scope.length} scanned Stock Tokens have no Chainlink price feed`,
      statement:
        `The Robinhood Chain Chainlink reference-data directory publishes ${feeds.length} feeds, of which ` +
        `${cohort.length} are 24/5 equity feeds. ${missingFeedAssets.length} of the ${scope.length} Stock Tokens ` +
        `scanned have no feed entry, so they cannot be priced on-chain at all and any valuation must come from ` +
        `an off-chain source — which reintroduces the cross-surface mixing hazard. ` +
        (withMultiplier.length
          ? `${withMultiplier.length} of them also carry a uiMultiplier() other than 1.0, where an off-chain SHARE ` +
            `price differs from token value by that multiplier: ` +
            withMultiplier
              .slice(0, 5)
              .map((a) => `${a.symbol} (${a.multiplier.toFixed(4)}x)`)
              .join(', ') +
            (withMultiplier.length > 5 ? `, and ${withMultiplier.length - 5} more.` : '.')
          : ''),
      sources: [
        CHAINLINK_FEEDS_URL,
        'https://docs.robinhood.com/chain/oracles-and-price-feeds/',
        RH_ASSETS_URL,
      ],
      observedAt,
    })
  }

  return {
    blockNumber: blockNumber.toString(),
    observedAt,
    marketClosed,
    cohort: cohortM,
    chainNotes,
    assetsScanned: scope.length,
    feedsAvailable: feeds.filter((f) => (f.name ?? '').toUpperCase().startsWith('ROBINHOOD')).length,
    findings: verified,
    rejected,
    stats,
    errors,
    integrators,
  }
}
