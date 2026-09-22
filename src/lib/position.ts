import { rhClient } from './chains.js'
import { stockTokenAbi, aggregatorV3Abi } from './abis.js'
import { fetchChainlinkFeeds, fetchRhAssets, feedForSymbol, type ChainlinkFeed } from './sources.js'
import { isTransient } from '../sweep/oracle.js'

/**
 * assay_true_position — the corrected number, sold next to the bug.
 *
 * This is deliberately NOT "balanceOf x feed price and hope". It returns every quantity a
 * caller needs to be correct, plus the oracle-hygiene flags Robinhood's docs require, plus
 * an explicit refusal reason when the read is not safe to act on.
 *
 * THE INVARIANT THIS FILE EXISTS TO HOLD: a check that did not COMPLETE must never be reported
 * as a check that PASSED. An earlier version reset only the price on a failed feed read, leaving
 * every flag null — so the refusal ladder, which tested `paused === true` and `feedStale`, fell
 * straight through to `confidence: 'high'` with `refusalReason: null`. A caller about to
 * collateralise a position was handed a clean bill of health for a read that never happened.
 * Every safety check below therefore records its own completion, and an incomplete one refuses.
 */
export interface TruePosition {
  symbol: string
  token: `0x${string}`
  holder: `0x${string}`
  /** Raw ERC-20 balance, 18dp. NOT a share count. */
  rawBalance: string
  /** ERC-8056 shares-per-token, 1e18 fixed point. */
  uiMultiplier: string
  multiplier: number
  /** balance * uiMultiplier / 1e18 — the share-equivalent count. */
  shareEquivalents: number
  /** Token units (rawBalance / 1e18) — what most UIs wrongly print as "shares". */
  tokenUnits: number
  /** Chainlink TOKEN price (already multiplier-adjusted). null when no feed exists. */
  tokenPriceUsd: number | null
  /** Derived underlying share price = feedPrice * 1e18 / uiMultiplier. */
  underlyingSharePriceUsd: number | null
  /** tokenUnits * tokenPriceUsd. The CORRECT position value. */
  positionValueUsd: number | null
  feed: `0x${string}` | null
  feedAgeSeconds: number | null
  feedHeartbeat: number | null
  feedStale: boolean | null
  oraclePaused: boolean | null
  /**
   * Which safety checks actually completed. `false` means UNKNOWN, not OK — it is the
   * difference between "we checked and it is fine" and "we could not check". A caller that
   * only reads `refusalReason` is safe; a caller that wants to reason for itself needs this.
   */
  checks: {
    pauseChecked: boolean
    feedRead: boolean
    priceSane: boolean
    roundComplete: boolean
    /** False when uiMultiplier() is zero or non-finite — the field this product is named after. */
    multiplierSane: boolean
  }
  blockNumber: string
  observedAt: string
  /** Non-null when the caller should NOT act on this reading. */
  refusalReason: string | null
  confidence: 'high' | 'degraded' | 'refuse'
}

/**
 * The chain surface truePosition depends on, injectable so the refusal matrix can be tested
 * without an RPC. Every method MAY throw; the caller records the failure rather than swallowing
 * it, which is the whole point of this file.
 */
export interface PositionReader {
  head(): Promise<{ blockNumber: bigint; timestamp: bigint }>
  balanceOf(token: `0x${string}`, holder: `0x${string}`): Promise<bigint>
  uiMultiplier(token: `0x${string}`): Promise<bigint>
  oraclePaused(token: `0x${string}`): Promise<boolean>
  latestRoundData(
    feed: `0x${string}`,
  ): Promise<readonly [bigint, bigint, bigint, bigint, bigint]>
  feedDecimals(feed: `0x${string}`): Promise<number>
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * Bounded retry on transient faults only, matching the discipline in sweep/oracle.ts. A revert
 * is a real answer and must not be retried into a timeout; a socket reset is worth one more go.
 */
/**
 * The whole read, bounded.
 *
 * viem already retries internally (4 attempts, 10s timeout each), so wrapping it in another 3
 * attempts with backoff multiplied the worst case rather than capping it: a single unresponsive
 * RPC could hold a PAID call for well over two minutes with no deadline anywhere in the chain.
 * The buyer's x402 trigger times out at 60s, so past that they have paid and will get nothing.
 *
 * This puts one deadline over the whole thing. A bounded failure the caller can see beats an
 * unbounded wait it cannot.
 */
const CALL_DEADLINE_MS = 12_000

async function withRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  const deadline = Date.now() + CALL_DEADLINE_MS
  let last: unknown
  for (let i = 0; i < attempts; i++) {
    if (Date.now() >= deadline) {
      throw last ?? new Error(`read exceeded the ${CALL_DEADLINE_MS}ms deadline`)
    }
    try {
      return await Promise.race([
        fn(),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error(`read timed out after ${CALL_DEADLINE_MS}ms`)),
            Math.max(1, deadline - Date.now()),
          ).unref(),
        ),
      ])
    } catch (err) {
      last = err
      const msg = (err as Error)?.message ?? String(err)
      if (!isTransient(msg)) throw err
      if (i < attempts - 1 && Date.now() + 150 * 2 ** i < deadline) await sleep(150 * 2 ** i)
      else break
    }
  }
  throw last
}

export const liveReader: PositionReader = {
  async head() {
    const blockNumber = await withRetry(() => rhClient.getBlockNumber())
    const block = await withRetry(() => rhClient.getBlock({ blockNumber }))
    return { blockNumber, timestamp: block.timestamp }
  },
  balanceOf: (token, holder) =>
    withRetry(
      () =>
        rhClient.readContract({
          address: token,
          abi: stockTokenAbi,
          functionName: 'balanceOf',
          args: [holder],
        }) as Promise<bigint>,
    ),
  uiMultiplier: (token) =>
    withRetry(
      () =>
        rhClient.readContract({
          address: token,
          abi: stockTokenAbi,
          functionName: 'uiMultiplier',
        }) as Promise<bigint>,
    ),
  oraclePaused: (token) =>
    withRetry(
      () =>
        rhClient.readContract({
          address: token,
          abi: stockTokenAbi,
          functionName: 'oraclePaused',
        }) as Promise<boolean>,
    ),
  latestRoundData: (feed) =>
    withRetry(
      () =>
        rhClient.readContract({
          address: feed,
          abi: aggregatorV3Abi,
          functionName: 'latestRoundData',
        }) as Promise<readonly [bigint, bigint, bigint, bigint, bigint]>,
    ),
  feedDecimals: (feed) =>
    withRetry(
      () =>
        rhClient.readContract({
          address: feed,
          abi: aggregatorV3Abi,
          functionName: 'decimals',
        }) as Promise<number>,
    ),
}

/** Suggest a near miss for a mistyped ticker: one keystroke from CRWD is the only 4.0x asset. */
export function didYouMean(symbol: string, known: string[]): string | null {
  const s = symbol.toUpperCase()
  let best: string | null = null
  let bestScore = Infinity
  for (const k of known) {
    if (Math.abs(k.length - s.length) > 2) continue
    // Cheap edit distance; the candidate set is ~200 short strings.
    const d = editDistance(s, k)
    if (d < bestScore) {
      bestScore = d
      best = k
    }
  }
  return bestScore <= 2 ? best : null
}

function editDistance(a: string, b: string): number {
  const prev: number[] = Array.from({ length: b.length + 1 }, (_, i) => i)
  const cur: number[] = new Array<number>(b.length + 1).fill(0)
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(
        (prev[j] ?? 0) + 1,
        (cur[j - 1] ?? 0) + 1,
        (prev[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1),
      )
    }
    for (let j = 0; j <= b.length; j++) prev[j] = cur[j] ?? 0
  }
  return prev[b.length] ?? 0
}

export interface TruePositionDeps {
  reader?: PositionReader
  assets?: Awaited<ReturnType<typeof fetchRhAssets>>
  feeds?: ChainlinkFeed[]
}

export async function truePosition(
  symbol: string,
  holder: `0x${string}`,
  deps: TruePositionDeps = {},
): Promise<TruePosition> {
  const reader = deps.reader ?? liveReader
  const [assets, feeds] = await Promise.all([
    deps.assets ? Promise.resolve(deps.assets) : fetchRhAssets(),
    deps.feeds ? Promise.resolve(deps.feeds) : fetchChainlinkFeeds(),
  ])

  const asset = assets.find((a) => a.tokenSymbol.toUpperCase() === symbol.toUpperCase())
  if (!asset) {
    // A mistyped ticker previously looked identical to a clean asset on the summary surfaces.
    // Name it as an error and offer the near miss, because CRWDD is one keystroke from the
    // only 4.0x token on the chain.
    const near = didYouMean(
      symbol,
      assets.map((a) => a.tokenSymbol),
    )
    throw new Error(
      `unknown Robinhood Stock Token symbol: ${symbol}` + (near ? ` — did you mean ${near}?` : ''),
    )
  }
  const dep = asset.deployments.find((d) => d.chainId === 4663) ?? asset.deployments[0]
  if (!dep) throw new Error(`no chain-4663 deployment for ${symbol}`)
  const token = dep.contractAddress

  const { blockNumber, timestamp } = await reader.head()
  const now = Number(timestamp)
  const observedAt = new Date(now * 1000).toISOString()

  // balanceOf and uiMultiplier are load-bearing for EVERY field. If either fails there is no
  // position to report at all, so this throws rather than returning a hollow object.
  const [balance, mult] = await Promise.all([
    reader.balanceOf(token, holder),
    reader.uiMultiplier(token),
  ])

  // oraclePaused is a SAFETY check. Failing to read it is not the same as reading `false`.
  let paused: boolean | null = null
  let pauseChecked = false
  try {
    paused = await reader.oraclePaused(token)
    pauseChecked = true
  } catch {
    paused = null
    pauseChecked = false
  }

  const multiplier = Number(mult) / 1e18
  const tokenUnits = Number(balance) / 1e18
  const shareEquivalents = tokenUnits * multiplier

  /**
   * The feed answer got a sanity gate (`answer > 0n`); uiMultiplier() did not.
   *
   * A zero multiplier makes every share-equivalent zero and every derived underlying price
   * infinite, and it sailed through to `confidence: 'high'` with `refusalReason: null` — the same
   * class of defect as selling a $0 valuation from a zero feed answer, on the field this entire
   * product is named after.
   */
  const multiplierSane = mult > 0n && Number.isFinite(multiplier) && multiplier > 0

  const feed = feedForSymbol(feeds, symbol)
  let tokenPriceUsd: number | null = null
  let feedAgeSeconds: number | null = null
  let feedStale: boolean | null = null
  let feedRead = false
  let priceSane = false
  let roundComplete = false
  let feedError: string | null = null

  if (feed) {
    try {
      const [roundId, answer, , updatedAt, answeredInRound] = await reader.latestRoundData(
        feed.proxyAddress,
      )
      // decimals() used to fall back to 8 silently. A wrong exponent is a 10^n valuation error,
      // so a failed read must refuse, not guess.
      const dec = Number(await reader.feedDecimals(feed.proxyAddress))
      feedRead = true

      feedAgeSeconds = now - Number(updatedAt)
      feedStale = feedAgeSeconds > feed.heartbeat

      // A non-positive answer is not a price. Publishing it would sell a $0 valuation whose
      // bytes reproduce perfectly, so the byte verifier would certify it.
      priceSane = answer > 0n
      // Chainlink's own guidance: answeredInRound < roundId means the round never completed
      // and the carried answer is stale in a way `updatedAt` does not reveal.
      roundComplete = answeredInRound >= roundId

      if (priceSane && roundComplete) {
        tokenPriceUsd = Number(answer) / 10 ** dec
      }
    } catch (err) {
      feedError = (err as Error)?.message ?? String(err)
      feedRead = false
      tokenPriceUsd = null
      feedAgeSeconds = null
      feedStale = null
    }
  }

  // Refusal policy — the caller is moving money, so say plainly when not to.
  // Order matters: every INCOMPLETE check refuses before any conclusion is drawn from the
  // values that did come back.
  let refusalReason: string | null = null
  let confidence: TruePosition['confidence'] = 'high'

  if (!multiplierSane) {
    refusalReason =
      `uiMultiplier() returned ${mult.toString()} for ${asset.tokenSymbol}, which is not a usable ` +
      `scaling factor. Every share-equivalent derived from it would be zero and every derived ` +
      `underlying price infinite, so no position is reported.`
    confidence = 'refuse'
  } else if (paused === true) {
    refusalReason = 'oraclePaused() is true for this token; price must not be trusted.'
    confidence = 'refuse'
  } else if (!pauseChecked) {
    refusalReason =
      `oraclePaused() could not be read for ${asset.tokenSymbol} after retries, so the ` +
      `corporate-action safety check did not complete. This is NOT a clean result: during a ` +
      `corporate action the oracle is paused and the price must not be used.`
    confidence = 'refuse'
  } else if (!feed) {
    refusalReason = `No Chainlink feed is published for ${asset.tokenSymbol} on Robinhood Chain; no on-chain price is available. Using an off-chain SHARE price here would introduce a ${((multiplier - 1) * 100).toFixed(3)}% error, because the multiplier is ${multiplier.toFixed(9)}.`
    confidence = 'refuse'
  } else if (!feedRead) {
    refusalReason =
      `The Chainlink feed at ${feed.proxyAddress} could not be read after retries` +
      (feedError ? ` (${feedError})` : '') +
      `, so neither the price nor its age is known. No valuation is returned.`
    confidence = 'refuse'
  } else if (!priceSane) {
    refusalReason =
      `latestRoundData() for ${asset.tokenSymbol} returned a non-positive answer, which is not a ` +
      `price. Multiplying it out would report a $0 position from bytes that reproduce exactly.`
    confidence = 'refuse'
  } else if (!roundComplete) {
    refusalReason =
      `latestRoundData() for ${asset.tokenSymbol} reports answeredInRound < roundId: the round ` +
      `did not complete and the answer is carried over from an earlier one.`
    confidence = 'refuse'
  } else if (feedStale) {
    refusalReason = `Chainlink feed is ${(feedAgeSeconds! / 3600).toFixed(2)}h old, past its ${feed.heartbeat}s heartbeat. Equity feeds update 24/5, so this recurs every weekend.`
    confidence = 'degraded'
  }

  return {
    symbol: asset.tokenSymbol,
    token,
    holder,
    rawBalance: balance.toString(),
    uiMultiplier: mult.toString(),
    multiplier,
    shareEquivalents,
    tokenUnits,
    tokenPriceUsd,
    underlyingSharePriceUsd:
      tokenPriceUsd !== null && multiplierSane ? tokenPriceUsd / multiplier : null,
    positionValueUsd: tokenPriceUsd !== null ? tokenUnits * tokenPriceUsd : null,
    feed: feed?.proxyAddress ?? null,
    feedAgeSeconds,
    feedHeartbeat: feed?.heartbeat ?? null,
    feedStale,
    oraclePaused: paused,
    checks: { pauseChecked, feedRead, priceSane, roundComplete, multiplierSane },
    blockNumber: blockNumber.toString(),
    observedAt,
    refusalReason,
    confidence,
  }
}
