import { rhClient } from './chains.js'
import { stockTokenAbi, aggregatorV3Abi } from './abis.js'
import { fetchChainlinkFeeds, fetchRhAssets, feedForSymbol } from './sources.js'

/**
 * assay_true_position — the corrected number, sold next to the bug.
 *
 * This is deliberately NOT "balanceOf x feed price and hope". It returns every quantity a
 * caller needs to be correct, plus the oracle-hygiene flags Robinhood's docs require, plus
 * an explicit refusal reason when the read is not safe to act on.
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
  blockNumber: string
  observedAt: string
  /** Non-null when the caller should NOT act on this reading. */
  refusalReason: string | null
  confidence: 'high' | 'degraded' | 'refuse'
}

export async function truePosition(
  symbol: string,
  holder: `0x${string}`,
): Promise<TruePosition> {
  const [assets, feeds] = await Promise.all([fetchRhAssets(), fetchChainlinkFeeds()])
  const asset = assets.find((a) => a.tokenSymbol.toUpperCase() === symbol.toUpperCase())
  if (!asset) throw new Error(`unknown Robinhood Stock Token symbol: ${symbol}`)
  const dep = asset.deployments.find((d) => d.chainId === 4663) ?? asset.deployments[0]
  if (!dep) throw new Error(`no chain-4663 deployment for ${symbol}`)
  const token = dep.contractAddress

  const blockNumber = await rhClient.getBlockNumber()
  const block = await rhClient.getBlock({ blockNumber })
  const now = Number(block.timestamp)
  const observedAt = new Date(now * 1000).toISOString()

  const [balance, mult, paused] = await Promise.all([
    rhClient.readContract({ address: token, abi: stockTokenAbi, functionName: 'balanceOf', args: [holder] }),
    rhClient.readContract({ address: token, abi: stockTokenAbi, functionName: 'uiMultiplier' }),
    rhClient
      .readContract({ address: token, abi: stockTokenAbi, functionName: 'oraclePaused' })
      .catch(() => null),
  ])

  const multiplier = Number(mult) / 1e18
  const tokenUnits = Number(balance) / 1e18
  const shareEquivalents = tokenUnits * multiplier

  const feed = feedForSymbol(feeds, symbol)
  let tokenPriceUsd: number | null = null
  let feedAgeSeconds: number | null = null
  let feedStale: boolean | null = null

  if (feed) {
    try {
      const [, answer, , updatedAt] = (await rhClient.readContract({
        address: feed.proxyAddress,
        abi: aggregatorV3Abi,
        functionName: 'latestRoundData',
      })) as readonly [bigint, bigint, bigint, bigint, bigint]
      const dec = (await rhClient.readContract({
        address: feed.proxyAddress,
        abi: aggregatorV3Abi,
        functionName: 'decimals',
      })) as number
      tokenPriceUsd = Number(answer) / 10 ** Number(dec)
      feedAgeSeconds = now - Number(updatedAt)
      feedStale = feedAgeSeconds > feed.heartbeat
    } catch {
      tokenPriceUsd = null
    }
  }

  // Refusal policy — the caller is moving money, so say plainly when not to.
  let refusalReason: string | null = null
  let confidence: TruePosition['confidence'] = 'high'
  if (paused === true) {
    refusalReason = 'oraclePaused() is true for this token; price must not be trusted.'
    confidence = 'refuse'
  } else if (!feed) {
    refusalReason = `No Chainlink feed is published for ${symbol} on Robinhood Chain; no on-chain price is available. Using an off-chain SHARE price here would introduce a ${((multiplier - 1) * 100).toFixed(3)}% error, because the multiplier is ${multiplier.toFixed(9)}.`
    confidence = 'refuse'
  } else if (feedStale) {
    refusalReason = `Chainlink feed is ${(feedAgeSeconds! / 3600).toFixed(2)}h old, past its ${feed.heartbeat}s heartbeat. Equity feeds update 24/5, so this recurs every weekend.`
    confidence = 'degraded'
  }

  return {
    symbol: asset.tokenSymbol,
    token,
    holder,
    rawBalance: (balance as bigint).toString(),
    uiMultiplier: (mult as bigint).toString(),
    multiplier,
    shareEquivalents,
    tokenUnits,
    tokenPriceUsd,
    underlyingSharePriceUsd: tokenPriceUsd !== null ? tokenPriceUsd / multiplier : null,
    positionValueUsd: tokenPriceUsd !== null ? tokenUnits * tokenPriceUsd : null,
    feed: feed?.proxyAddress ?? null,
    feedAgeSeconds,
    feedHeartbeat: feed?.heartbeat ?? null,
    feedStale,
    oraclePaused: paused as boolean | null,
    blockNumber: blockNumber.toString(),
    observedAt,
    refusalReason,
    confidence,
  }
}
