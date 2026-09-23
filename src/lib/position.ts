import { rhClient } from './chains.js'
import { stockTokenAbi, aggregatorV3Abi } from './abis.js'
import {
  fetchChainlinkFeeds,
  fetchRhAssets,
  feedForSymbol,
  pastHeartbeat,
  type ChainlinkFeed,
} from './sources.js'
import { isTransient, describeRpcError } from '../sweep/oracle.js'

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
  /** Raw ERC-20 balance in the token's base units (see tokenDecimals). NOT a share count. */
  rawBalance: string
  /**
   * decimals() as the token reports it at blockNumber.
   *
   * This used to be 1e18 in source. Every Stock Token is 18dp today, which is exactly the kind of
   * scaling assumption that stops holding quietly; detect.ts already stopped making it.
   */
  tokenDecimals: number
  /** ERC-8056 shares-per-token, 1e18 fixed point. */
  uiMultiplier: string
  multiplier: number
  /** tokenUnits * uiMultiplier / 1e18 — the share-equivalent count. */
  shareEquivalents: number
  /** Token units (rawBalance / 10^tokenDecimals) — what most UIs wrongly print as "shares". */
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
  /**
   * ERC-8056's scheduled multiplier change: newUIMultiplier() takes over from uiMultiplier() at
   * effectiveAt(). The tokens implement it, and nothing read it here, so a 'high' answer could be
   * sold minutes before the multiplier stepped. Of the 35 dividend transitions on record, none
   * paused the oracle, so oraclePaused() is not the warning; this is.
   */
  pending: {
    /** False when newUIMultiplier()/effectiveAt() could not be read: UNKNOWN, not "nothing pending". */
    checked: boolean
    /** newUIMultiplier(), 1e18 fixed point, only when it differs from uiMultiplier(). */
    newUIMultiplier: string | null
    newMultiplier: number | null
    effectiveAt: string | null
    secondsUntilEffective: number | null
  }
  /**
   * Non-null when the figures are right at blockNumber but must not be carried past a known time.
   * It does not change `confidence`: the reading is correct when it is taken, and the window
   * between a change being scheduled and taking effect has been about ten minutes.
   */
  warning: string | null
  /** Every read above was taken at this block, so the answer can be reproduced at it. */
  blockNumber: string
  observedAt: string
  /** Non-null when the caller should NOT act on this reading. */
  refusalReason: string | null
  confidence: 'high' | 'degraded' | 'refuse'
}

/** Where every read after head() is taken, and when the whole call must be finished. */
export interface ReadAt {
  blockNumber: bigint
  /** Epoch ms. One deadline for the call, shared by every read — see CALL_DEADLINE_MS. */
  deadline: number
}

/**
 * The chain surface truePosition depends on, injectable so the refusal matrix can be tested
 * without an RPC. Every method MAY throw; the caller records the failure rather than swallowing
 * it, which is the whole point of this file.
 */
export interface PositionReader {
  head(deadline: number): Promise<{ blockNumber: bigint; timestamp: bigint }>
  balanceOf(token: `0x${string}`, holder: `0x${string}`, at: ReadAt): Promise<bigint>
  uiMultiplier(token: `0x${string}`, at: ReadAt): Promise<bigint>
  tokenDecimals(token: `0x${string}`, at: ReadAt): Promise<number>
  pendingMultiplier(
    token: `0x${string}`,
    at: ReadAt,
  ): Promise<{ newUIMultiplier: bigint; effectiveAt: bigint }>
  oraclePaused(token: `0x${string}`, at: ReadAt): Promise<boolean>
  latestRoundData(
    feed: `0x${string}`,
    at: ReadAt,
  ): Promise<readonly [bigint, bigint, bigint, bigint, bigint]>
  feedDecimals(feed: `0x${string}`, at: ReadAt): Promise<number>
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * The whole call, bounded by ONE deadline.
 *
 * viem already retries internally, so wrapping it in another 3 attempts with backoff multiplied
 * the worst case rather than capping it: a single unresponsive RPC could hold a PAID call for well
 * over two minutes. The buyer's x402 authorization is good for 60s, so past that they have paid
 * and will get nothing.
 *
 * The comment here used to say "one deadline over the whole thing" while each read computed its
 * own 12s, so six sequential stages could run 72s. Now the deadline is set once, when the call
 * starts, and every read — directory fetch included — races the same instant. 40s leaves the
 * OpenServ runtime and the tunnel their share of the 60.
 */
export const CALL_DEADLINE_MS = 40_000

/** Thrown when the deadline passes. Says "timed out", so isTransient classifies it as one. */
export class DeadlineExceededError extends Error {
  constructor(ms?: number) {
    super(`timed out: the ${ms ? `${ms}ms ` : ''}deadline for this call passed before its reads returned`)
    this.name = 'DeadlineExceededError'
  }
}

function beforeDeadline<T>(work: Promise<T>, deadline: number, budgetMs?: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new DeadlineExceededError(budgetMs)), Math.max(0, deadline - Date.now()))
    timer.unref?.()
  })
  return Promise.race([work, expired]).finally(() => clearTimeout(timer))
}

/**
 * Bounded retry on transient faults only, matching the discipline in sweep/oracle.ts. A revert
 * is a real answer and must not be retried into a timeout; a Cloudflare 403 or a timeout is worth
 * another go while the deadline allows it.
 */
export async function withRetry<T>(fn: () => Promise<T>, deadline: number, attempts = 3): Promise<T> {
  let last: unknown
  for (let i = 0; i < attempts; i++) {
    if (Date.now() >= deadline) break
    try {
      return await beforeDeadline(fn(), deadline)
    } catch (err) {
      last = err
      if (!isTransient(err)) throw err
      const backoff = 150 * 2 ** i
      if (i < attempts - 1 && Date.now() + backoff < deadline) await sleep(backoff)
      else break
    }
  }
  throw last ?? new DeadlineExceededError()
}

export const liveReader: PositionReader = {
  async head(deadline) {
    // One call for number and timestamp together; getBlockNumber then getBlock was two round
    // trips out of the deadline, for a pair of values a single block header already carries.
    const block = await withRetry(() => rhClient.getBlock(), deadline)
    return { blockNumber: block.number, timestamp: block.timestamp }
  },
  // Every read below passes `blockNumber`. They used to run at 'latest', so on a 0.1s-block chain
  // the balance, the multiplier and the feed came from different blocks than the one the answer
  // reported, and at a corporate-action boundary the returned multiplier could postdate it.
  balanceOf: (token, holder, at) =>
    withRetry(
      () =>
        rhClient.readContract({
          address: token,
          abi: stockTokenAbi,
          functionName: 'balanceOf',
          args: [holder],
          blockNumber: at.blockNumber,
        }) as Promise<bigint>,
      at.deadline,
    ),
  uiMultiplier: (token, at) =>
    withRetry(
      () =>
        rhClient.readContract({
          address: token,
          abi: stockTokenAbi,
          functionName: 'uiMultiplier',
          blockNumber: at.blockNumber,
        }) as Promise<bigint>,
      at.deadline,
    ),
  tokenDecimals: (token, at) =>
    withRetry(
      () =>
        rhClient.readContract({
          address: token,
          abi: stockTokenAbi,
          functionName: 'decimals',
          blockNumber: at.blockNumber,
        }) as Promise<number>,
      at.deadline,
    ),
  async pendingMultiplier(token, at) {
    const [newUIMultiplier, effectiveAt] = await Promise.all([
      withRetry(
        () =>
          rhClient.readContract({
            address: token,
            abi: stockTokenAbi,
            functionName: 'newUIMultiplier',
            blockNumber: at.blockNumber,
          }) as Promise<bigint>,
        at.deadline,
      ),
      withRetry(
        () =>
          rhClient.readContract({
            address: token,
            abi: stockTokenAbi,
            functionName: 'effectiveAt',
            blockNumber: at.blockNumber,
          }) as Promise<bigint>,
        at.deadline,
      ),
    ])
    return { newUIMultiplier, effectiveAt }
  },
  oraclePaused: (token, at) =>
    withRetry(
      () =>
        rhClient.readContract({
          address: token,
          abi: stockTokenAbi,
          functionName: 'oraclePaused',
          blockNumber: at.blockNumber,
        }) as Promise<boolean>,
      at.deadline,
    ),
  latestRoundData: (feed, at) =>
    withRetry(
      () =>
        rhClient.readContract({
          address: feed,
          abi: aggregatorV3Abi,
          functionName: 'latestRoundData',
          blockNumber: at.blockNumber,
        }) as Promise<readonly [bigint, bigint, bigint, bigint, bigint]>,
      at.deadline,
    ),
  feedDecimals: (feed, at) =>
    withRetry(
      () =>
        rhClient.readContract({
          address: feed,
          abi: aggregatorV3Abi,
          functionName: 'decimals',
          blockNumber: at.blockNumber,
        }) as Promise<number>,
      at.deadline,
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
  /** Overrides CALL_DEADLINE_MS, for tests. */
  deadlineMs?: number
}

export async function truePosition(
  symbol: string,
  holder: `0x${string}`,
  deps: TruePositionDeps = {},
): Promise<TruePosition> {
  const reader = deps.reader ?? liveReader
  const budgetMs = deps.deadlineMs ?? CALL_DEADLINE_MS
  const deadline = Date.now() + budgetMs
  const bounded = <T>(work: Promise<T>) => beforeDeadline(work, deadline, budgetMs)

  const [assets, feeds] = await bounded(
    Promise.all([
      deps.assets ? Promise.resolve(deps.assets) : fetchRhAssets(),
      deps.feeds ? Promise.resolve(deps.feeds) : fetchChainlinkFeeds(),
    ]),
  )

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
  const feed = feedForSymbol(feeds, symbol)

  const { blockNumber, timestamp } = await bounded(reader.head(deadline))
  const now = Number(timestamp)
  const observedAt = new Date(now * 1000).toISOString()
  const at: ReadAt = { blockNumber, deadline }

  // Every read is pinned to the same block, so they have no ordering to respect: one parallel
  // batch instead of five sequential stages, which is what lets the whole call fit its deadline.
  // allSettled, because a failed read is recorded below, never dropped.
  const [balanceR, multR, decimalsR, pausedR, pendingR, roundR, feedDecR] = await Promise.allSettled([
    bounded(reader.balanceOf(token, holder, at)),
    bounded(reader.uiMultiplier(token, at)),
    bounded(reader.tokenDecimals(token, at)),
    bounded(reader.oraclePaused(token, at)),
    bounded(reader.pendingMultiplier(token, at)),
    feed ? bounded(reader.latestRoundData(feed.proxyAddress, at)) : Promise.resolve(null),
    feed ? bounded(reader.feedDecimals(feed.proxyAddress, at)) : Promise.resolve(null),
  ])

  // balanceOf, uiMultiplier and decimals are load-bearing for EVERY field. If any failed there is
  // no position to report at all, so this throws rather than returning a hollow object.
  if (balanceR.status === 'rejected') throw balanceR.reason
  if (multR.status === 'rejected') throw multR.reason
  if (decimalsR.status === 'rejected') throw decimalsR.reason
  const balance = balanceR.value
  const mult = multR.value
  const tokenDecimals = Number(decimalsR.value)

  // oraclePaused is a SAFETY check. Failing to read it is not the same as reading `false`.
  const paused: boolean | null = pausedR.status === 'fulfilled' ? pausedR.value : null
  const pauseChecked = pausedR.status === 'fulfilled'

  const multiplier = Number(mult) / 1e18
  const tokenUnits = Number(balance) / 10 ** tokenDecimals
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

  let tokenPriceUsd: number | null = null
  let feedAgeSeconds: number | null = null
  let feedStale: boolean | null = null
  let feedRead = false
  let priceSane = false
  let roundComplete = false
  let feedError: string | null = null

  if (feed) {
    const round = roundR.status === 'fulfilled' ? roundR.value : null
    const feedDec = feedDecR.status === 'fulfilled' ? feedDecR.value : null
    if (round && feedDec !== null) {
      const [roundId, answer, , updatedAt, answeredInRound] = round
      // decimals() used to fall back to 8 silently. A wrong exponent is a 10^n valuation error,
      // so a failed read must refuse, not guess.
      const dec = Number(feedDec)
      feedRead = true

      feedAgeSeconds = now - Number(updatedAt)
      // The same delivery grace the sweep applies: a heartbeat is when the node sends the update,
      // not when it lands, so a strict comparison degraded on-schedule feeds for ~26s a day.
      feedStale = pastHeartbeat(feedAgeSeconds, feed.heartbeat)

      // A non-positive answer is not a price. Publishing it would sell a $0 valuation whose
      // bytes reproduce perfectly, so the byte verifier would certify it.
      priceSane = answer > 0n
      // Chainlink's own guidance: answeredInRound < roundId means the round never completed
      // and the carried answer is stale in a way `updatedAt` does not reveal.
      roundComplete = answeredInRound >= roundId

      if (priceSane && roundComplete) {
        tokenPriceUsd = Number(answer) / 10 ** dec
      }
    } else {
      const failed = roundR.status === 'rejected' ? roundR : feedDecR.status === 'rejected' ? feedDecR : null
      feedError = failed ? describeRpcError(failed.reason) : null
    }
  }

  let pending: TruePosition['pending'] = {
    checked: pendingR.status === 'fulfilled',
    newUIMultiplier: null,
    newMultiplier: null,
    effectiveAt: null,
    secondsUntilEffective: null,
  }
  let warning: string | null = null
  if (pendingR.status === 'fulfilled') {
    const { newUIMultiplier, effectiveAt } = pendingR.value
    // Gate on newUIMultiplier() differing, as detect.ts does: effectiveAt() keeps its last value
    // after a change lands, so on its own it does not mean anything is pending.
    if (newUIMultiplier !== mult) {
      const newMultiplier = Number(newUIMultiplier) / 1e18
      const when = effectiveAt > 0n ? new Date(Number(effectiveAt) * 1000).toISOString() : null
      const secs = effectiveAt > 0n ? Number(effectiveAt) - now : null
      pending = {
        checked: true,
        newUIMultiplier: newUIMultiplier.toString(),
        newMultiplier,
        effectiveAt: when,
        secondsUntilEffective: secs,
      }
      warning =
        `${asset.tokenSymbol} has a multiplier change scheduled: uiMultiplier() moves ` +
        `${multiplier.toFixed(9)} -> ${newMultiplier.toFixed(9)}` +
        (when ? ` at ${when}` : '') +
        (secs !== null && secs > 0 ? ` (in about ${Math.ceil(secs / 60)} min)` : '') +
        `. These figures are correct at block ${blockNumber}; from that time the same balance is a ` +
        `different number of share-equivalents, so do not cache shareEquivalents or ` +
        `underlyingSharePriceUsd past it.`
    }
  } else {
    warning =
      `newUIMultiplier()/effectiveAt() could not be read for ${asset.tokenSymbol}, so a scheduled ` +
      `multiplier change cannot be ruled out. These figures are correct at block ${blockNumber}; do ` +
      `not cache the share-equivalents.`
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
    // The understatement framing detect.ts publishes: |1 - 1/m| of the TRUE value, which cannot
    // exceed 100%. This quoted |m - 1| as "a 300.000% error" for CRWD, the figure the wall retired as
    // an overclaim, and the free MCP verdict passes this sentence through verbatim.
    const misreadPct = (1 - 1 / multiplier) * 100
    refusalReason =
      `No Chainlink feed is published for ${asset.tokenSymbol} on Robinhood Chain; no on-chain price is available. ` +
      `The multiplier is ${multiplier.toFixed(9)}, so valuing the raw balance at an off-chain SHARE price ` +
      `${misreadPct >= 0 ? 'understates' : 'overstates'} the position by ${Math.abs(misreadPct).toFixed(3)}% ` +
      `of its true value (the true value is ${multiplier.toFixed(9)}x that).`
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
    tokenDecimals,
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
    pending,
    warning,
    blockNumber: blockNumber.toString(),
    observedAt,
    refusalReason,
    confidence,
  }
}
