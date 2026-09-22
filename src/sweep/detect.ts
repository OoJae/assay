import type { ChainNote, Finding, Severity } from './types.js'
import { evidence, readFeed, readStockToken } from './oracle.js'
import {
  CHAINLINK_FEEDS_URL,
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

export const METHODOLOGY_VERSION = 'assay-rh-v0.2.0'

/**
 * How often to re-read the chain head during a sweep.
 *
 * The public RPC prunes state at roughly 1k-10k blocks and Robinhood Chain produces ~100ms
 * blocks, so a single block captured at sweep start is unusable by the end of a 194-asset run.
 * Refreshing per asset keeps every citation inside the retention window, which is what makes
 * inline verification possible at all.
 */
const BLOCK_REFRESH_EVERY = 1

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
let cohortCache: { at: number; stale: number; size: number; marketClosed: boolean } | null = null

/** Run tasks with a bounded number in flight, preserving nothing but the count of truthy results. */
async function countStale(
  feeds: ChainlinkFeed[],
  read: (f: ChainlinkFeed) => Promise<boolean>,
  concurrency: number,
): Promise<number> {
  let index = 0
  let stale = 0
  const workers = Array.from({ length: Math.min(concurrency, feeds.length) }, async () => {
    for (;;) {
      const i = index++
      const feed = feeds[i]
      if (!feed) return
      if (await read(feed)) stale++
    }
  })
  await Promise.all(workers)
  return stale
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
  /**
   * Verify every citation before returning. ON BY DEFAULT and strongly recommended:
   * the public RPC prunes state within ~1k-10k blocks, so verification MUST happen in
   * the same window as detection or citations become permanently uncheckable.
   */
  verify?: boolean
}

export interface SweepResult {
  blockNumber: string
  observedAt: string
  /** True when cohort corroboration says the US equity market is shut. */
  marketClosed: boolean
  /** Verifiable observations with no on-chain citation (absences). Never mixed into findings. */
  chainNotes: ChainNote[]
  cohort: { size: number; stale: number; clockHint: boolean }
  assetsScanned: number
  feedsAvailable: number
  findings: VerifiedFinding[]
  /** Findings that failed verification and were never published, with the reason. */
  rejected: RejectedFinding[]
  stats: {
    divergentMultipliers: number
    staleFeeds: number
    staleUnexpected: number
    missingFeeds: number
    pausedOracles: number
  }
  errors: Array<{ symbol: string; error: string }>
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

  let cohortStale: number
  let marketClosed: boolean
  const fresh = cohortCache && Date.now() - cohortCache.at < COHORT_TTL_MS
  if (fresh && cohortCache) {
    cohortStale = cohortCache.stale
    marketClosed = cohortCache.marketClosed
  } else {
    cohortStale = await countStale(
      cohort,
      async (f) => {
        const r = await readFeed(f.proxyAddress, f.heartbeat, nowSeconds, blockNumber)
        return Boolean(r?.stale)
      },
      COHORT_CONCURRENCY,
    )
    marketClosed = scheduledClosure(cohortStale, cohort.length, clockHint)
    cohortCache = { at: Date.now(), stale: cohortStale, size: cohort.length, marketClosed }
  }
  opts.onProgress?.(0, scope.length, `cohort: ${cohortStale}/${cohort.length} stale -> ${marketClosed ? 'MARKET CLOSED' : 'market open'}`)

  const findings: Finding[] = []
  /** Assets with no published Chainlink feed. Reported as ChainNotes, never as Findings. */
  const missingFeedAssets: Array<{ symbol: string; token: `0x${string}`; multiplier: number }> = []
  const stats = {
    divergentMultipliers: 0,
    staleFeeds: 0,
    staleUnexpected: 0,
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

  for (const asset of scope) {
    const dep = rhDeployment(asset)!
    const token = dep.contractAddress
    const sym = asset.tokenSymbol
    done++
    opts.onProgress?.(done, scope.length, sym)

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
      const before = findings.length
    const reading = await readStockToken(token, blockNumber)
    if (!reading) continue

    const feed: ChainlinkFeed | null = feedForSymbol(feeds, sym)
    const mult = reading.multiplierFloat
    const divergenceBps = Math.abs(mult - 1) * 10_000
    /**
     * How much a raw balanceOf() understates the true share count, as a percentage of the TRUE
     * value. This is bounded by 100% by construction.
     *
     * The previous formulation reported `divergenceBps` as "understates by N bps", which for CRWD
     * printed "understates it by 30000.0 bps" — i.e. 300%. An understatement cannot exceed 100%:
     * that figure was the ratio expressed as a gain (true = 4x raw), not an understatement.
     * It was the headline number on the wall and in the README.
     */
    const understatementPct = mult > 0 ? (1 - 1 / mult) * 100 : 0

    // --- Class 4: share-count misreport (only meaningful when multiplier != 1) ---
    if (divergenceBps > 0.01) {
      stats.divergentMultipliers++
      const trueShares = (Number(reading.totalSupply) / 1e18) * mult
      const rawShares = Number(reading.totalSupply) / 1e18
      findings.push({
        id: `${sym}-share-count`,
        defectClass: 'SHARE_COUNT_MISREPORT',
        severity: sev(divergenceBps),
        subject: `${sym} (${token})`,
        title: `${sym}: balanceOf() is ${mult.toFixed(9)}x away from share-equivalents`,
        statement:
          `${sym} reports uiMultiplier() = ${reading.multiplier.toString()} (${mult.toFixed(9)}). ` +
          `Under ERC-8056 a corporate action moves this multiplier rather than balances, so ` +
          `balanceOf() returns tokens, not share-equivalents. Share-equivalents = balance * uiMultiplier() / 1e18. ` +
          `Any surface presenting balanceOf() as a share count understates it by ${understatementPct.toFixed(4)}% ` +
          `(the true count is ${mult.toFixed(4)}x the raw balance). ` +
          `Token value computed as balance * Chainlink feed price is unaffected, because the feed is already multiplier-adjusted.`,
        impact: {
          basisPoints: Number(divergenceBps.toFixed(2)),
          /** Understatement as a share of the TRUE value. Bounded by 100% by construction. */
          percent: Number(understatementPct.toFixed(4)),
          note:
            `totalSupply raw ${rawShares.toFixed(4)} tokens vs ${trueShares.toFixed(4)} share-equivalents ` +
            `(delta ${(trueShares - rawShares).toFixed(4)}). Presenting the raw balance as a share count ` +
            `understates by ${understatementPct.toFixed(4)}%; equivalently the true count is ${mult.toFixed(4)}x the raw.`,
        },
        evidence: [
          evidence(`uiMultiplier() == ${reading.multiplier}`, token, 'uiMultiplier()', reading.rawMultiplier, blockNumber, observedAt),
          evidence(`totalSupply() == ${reading.totalSupply}`, token, 'totalSupply()', reading.rawTotalSupply, blockNumber, observedAt),
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
      if (reading2) {
        if (reading2.stale) {
          stats.staleFeeds++
          // EXPECTED vs UNEXPECTED. Reporting every weekend-stale equity feed as an incident
          // invites the obvious rebuttal ("that's just the weekend") and would be sloppy.
          const scheduled = is24x5(feed) && marketClosed
          if (!scheduled) stats.staleUnexpected++
          findings.push({
            id: `${sym}-stale-feed`,
            defectClass: scheduled ? 'ORACLE_STALE_MARKET_CLOSED' : 'ORACLE_STALE_UNEXPECTED',
            severity: scheduled ? 'medium' : reading2.ageSeconds > feed.heartbeat * 2 ? 'critical' : 'high',
            subject: `${sym} feed (${feed.proxyAddress})`,
            title: scheduled
              ? `${sym}: feed ${(reading2.ageSeconds / 3600).toFixed(1)}h past heartbeat (market closed — no on-chain signal)`
              : `${sym}: feed ${(reading2.ageSeconds / 3600).toFixed(1)}h past heartbeat DURING MARKET HOURS`,
            statement:
              `latestRoundData() for ${sym} returns updatedAt = ${reading2.updatedAt}, which is ` +
              `${reading2.ageSeconds} seconds (${(reading2.ageSeconds / 3600).toFixed(2)} hours) before the current block timestamp, ` +
              `exceeding the feed's published heartbeat of ${feed.heartbeat}s. The call still returns a price. ` +
              (scheduled
                ? `This feed is marked marketHours="${feed.docs?.marketHours}" and ${cohortStale} of ${cohort.length} ` +
                  `24/5 equity feeds are stale at this same block, which corroborates a scheduled market closure rather than ` +
                  `an oracle incident. The staleness is therefore EXPECTED BY DESIGN. ` +
                  `It is reported because the contract gives callers no on-chain ` +
                  `way to distinguish it: latestRoundData() returns a price either way, and marketHours exists only in ` +
                  `off-chain metadata. Robinhood's documentation requires callers to check updatedAt against the heartbeat. ` +
                  `A caller without that guard is pricing off data up to ${(reading2.ageSeconds / 3600).toFixed(1)} hours old.`
                : `Only ${cohortStale} of ${cohort.length} 24/5 equity feeds are stale at this block, so this is NOT a ` +
                  `market-wide closure and the staleness is unexpected for this feed specifically. ` +
                  `Robinhood's documentation requires callers to check updatedAt against the heartbeat.`),
            impact: {
              note: `Price ${reading2.price.toFixed(4)} is ${(reading2.ageSeconds / 3600).toFixed(2)}h stale. Any valuation, liquidation or collateral check reading this feed without a staleness guard is using data from ${new Date(Number(reading2.updatedAt) * 1000).toISOString()}.`,
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
        if (divergenceBps > 1) {
          const under = await fetchRhUnderlyingPrice(sym)
          if (under && under.mid > 0) {
            const predicted = under.mid * mult
            const residualPct = ((reading2.price - predicted) / predicted) * 100
            findings.push({
              id: `${sym}-cross-surface`,
              defectClass: 'CROSS_SURFACE_PRICE_MIX',
              severity: sev(divergenceBps),
              subject: `${sym} (${token})`,
              title: `${sym}: off-chain share price and on-chain token price differ by ${((mult - 1) * 100).toFixed(3)}%`,
              statement:
                `The Chainlink feed returns a multiplier-adjusted TOKEN price (${reading2.price.toFixed(4)}), while ` +
                `Robinhood's REST /prices endpoint returns the RAW UNDERLYING share price (mid ${under.mid.toFixed(4)}). ` +
                `These are different quantities related by uiMultiplier(): underlying x ${mult.toFixed(9)} = ${predicted.toFixed(4)} ` +
                `(residual ${residualPct.toFixed(3)}%, attributable to bid/ask spread and quote timing). ` +
                `Valuing balanceOf() with an off-chain share price, or computing a premium/discount between an on-chain ` +
                `token price and an off-chain share price, produces a phantom error of ${((mult - 1) * 100).toFixed(3)}%.`,
              impact: {
                basisPoints: Number(divergenceBps.toFixed(2)),
                percent: Number(((mult - 1) * 100).toFixed(4)),
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
    if (reading.oraclePaused === true) {
      stats.pausedOracles++
      findings.push({
        id: `${sym}-oracle-paused`,
        defectClass: 'ORACLE_PAUSED',
        severity: 'high',
        subject: `${sym} (${token})`,
        title: `${sym}: oraclePaused() is true`,
        statement: `${sym} reports oraclePaused() == true. Robinhood's documentation requires callers to respect this flag; prices should not be trusted while it is set.`,
        impact: { note: 'Any price-dependent action on this asset is unsafe until the flag clears.' },
        evidence: [evidence('oraclePaused() == true', token, 'oraclePaused()', '0x' + '0'.repeat(63) + '1', blockNumber, observedAt)],
        methodologyVersion: METHODOLOGY_VERSION,
        detectedAt: observedAt,
      })
    }

    if (asset.pendingMultiplier && asset.pendingMultiplier !== '') {
      findings.push({
        id: `${sym}-pending-ca`,
        defectClass: 'PENDING_CORPORATE_ACTION',
        severity: 'medium',
        subject: `${sym} (${token})`,
        title: `${sym}: corporate action pending`,
        statement: `${sym} has pendingMultiplier ${asset.pendingMultiplier} effective ${asset.pendingMultiplierEffectiveTime ?? 'unknown'}. Positions and share-equivalent displays change at that time.`,
        impact: { note: 'Cached multipliers become wrong at the effective time.' },
        evidence: [evidence(`newUIMultiplier() == ${reading.pendingMultiplier}`, token, 'newUIMultiplier()', reading.rawMultiplier, blockNumber, observedAt)],
        methodologyVersion: METHODOLOGY_VERSION,
        detectedAt: observedAt,
      })
    }
      // Verify THIS asset's findings right now, while its block is still served.
      if (shouldVerify) {
        const fresh = findings.splice(before)
        for (const f of fresh) {
          const r = await verifyFindingDetailed(f)
          if (r.ok) verified.push(r.finding)
          else rejected.push(r.rejected)
        }
      }
    } catch (err) {
      // One bad asset must never kill a 194-asset sweep.
      errors.push({ symbol: sym, error: (err as Error).message.slice(0, 160) })
    }
  }

  if (!shouldVerify) verified.push(...(findings as VerifiedFinding[]))

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
    cohort: { size: cohort.length, stale: cohortStale, clockHint },
    chainNotes,
    assetsScanned: scope.length,
    feedsAvailable: feeds.filter((f) => (f.name ?? '').toUpperCase().startsWith('ROBINHOOD')).length,
    findings: verified,
    rejected,
    stats,
    errors,
  }
}
