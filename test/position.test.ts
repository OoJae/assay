import { describe, it, expect } from 'vitest'
import { truePosition, didYouMean, type PositionReader } from '../src/lib/position.js'
import type { ChainlinkFeed, RhAsset } from '../src/lib/sources.js'

/**
 * The refusal matrix for the PAID primitive.
 *
 * Every case here is a check that DID NOT COMPLETE. The property under test is not that the
 * numbers are right — it is that a read which failed can never be sold as a read that passed.
 * The regression these tests exist for returned `confidence: 'high'` with `refusalReason: null`
 * on a feed whose every call threw.
 *
 * Runs entirely offline behind an injected reader, so it is a real regression gate in CI rather
 * than something that only fires when the chain happens to be reachable.
 */

const TOKEN = '0xea72Ecca2d0f6bFA1394DBBCff85b52CD4233931' as const
const HOLDER = '0x8366a39CC670B4001A1121B8F6A443A643e40951' as const
const FEED = '0x1111111111111111111111111111111111111111' as const

const ASSETS: RhAsset[] = [
  {
    tokenSymbol: 'TEST',
    deployments: [{ chainId: 4663, contractAddress: TOKEN }],
  } as unknown as RhAsset,
  { tokenSymbol: 'CRWD', deployments: [{ chainId: 4663, contractAddress: TOKEN }] } as unknown as RhAsset,
]

const FEEDS: ChainlinkFeed[] = [
  {
    name: 'Robinhood TEST / USD',
    proxyAddress: FEED,
    decimals: 8,
    heartbeat: 86400,
    assetName: 'TEST',
    docs: { marketHours: 'us_equities_24/5' },
  },
]

const NOW = 1_800_000_000n

/** A reader where every call succeeds and the feed is fresh and sane. Cases override one thing. */
function reader(over: Partial<PositionReader> = {}): PositionReader {
  return {
    head: async () => ({ blockNumber: 68_800_493n, timestamp: NOW }),
    balanceOf: async () => 13_026_200_000_000_000_000n,
    uiMultiplier: async () => 4_000_000_000_000_000_000n,
    oraclePaused: async () => false,
    latestRoundData: async () => [5n, 22_244_730_000n, NOW - 60n, NOW - 60n, 5n] as const,
    feedDecimals: async () => 8,
    ...over,
  }
}

const run = (r: PositionReader, symbol = 'TEST') =>
  truePosition(symbol, HOLDER, { reader: r, assets: ASSETS, feeds: FEEDS })

describe('truePosition — a check that did not complete is never reported as one that passed', () => {
  it('returns high confidence only when every check actually completed', async () => {
    const p = await run(reader())
    expect(p.confidence).toBe('high')
    expect(p.refusalReason).toBeNull()
    expect(p.checks).toEqual({
      pauseChecked: true,
      feedRead: true,
      priceSane: true,
      roundComplete: true,
    })
    // ERC-8056: 13.0262 tokens at a 4.0x multiplier is 52.1048 share-equivalents.
    expect(p.shareEquivalents).toBeCloseTo(52.1048, 4)
    expect(p.positionValueUsd).toBeCloseTo(13.0262 * 222.4473, 2)
  })

  it('REFUSES when the feed read fails — the regression that shipped', async () => {
    const p = await run(
      reader({
        latestRoundData: async () => {
          throw new Error('fetch failed')
        },
      }),
    )
    expect(p.confidence).toBe('refuse')
    expect(p.refusalReason).toMatch(/could not be read/i)
    expect(p.checks.feedRead).toBe(false)
    expect(p.tokenPriceUsd).toBeNull()
    expect(p.positionValueUsd).toBeNull()
    // The old ladder left this null and then read it as "not stale".
    expect(p.feedStale).toBeNull()
  })

  it('REFUSES when decimals() fails rather than defaulting to 8', async () => {
    const p = await run(
      reader({
        feedDecimals: async () => {
          throw new Error('socket hang up')
        },
      }),
    )
    expect(p.confidence).toBe('refuse')
    expect(p.checks.feedRead).toBe(false)
    expect(p.positionValueUsd).toBeNull()
  })

  it('REFUSES when oraclePaused() cannot be read — unknown is not false', async () => {
    const p = await run(
      reader({
        oraclePaused: async () => {
          throw new Error('execution reverted')
        },
      }),
    )
    expect(p.confidence).toBe('refuse')
    expect(p.refusalReason).toMatch(/safety check did not complete/i)
    expect(p.checks.pauseChecked).toBe(false)
    expect(p.oraclePaused).toBeNull()
  })

  it('REFUSES when oraclePaused() is true', async () => {
    const p = await run(reader({ oraclePaused: async () => true }))
    expect(p.confidence).toBe('refuse')
    expect(p.refusalReason).toMatch(/oraclePaused\(\) is true/)
  })

  it('REFUSES a non-positive answer instead of selling a $0 valuation', async () => {
    const p = await run(
      reader({ latestRoundData: async () => [5n, 0n, NOW - 60n, NOW - 60n, 5n] as const }),
    )
    expect(p.confidence).toBe('refuse')
    expect(p.refusalReason).toMatch(/non-positive/i)
    expect(p.checks.priceSane).toBe(false)
    expect(p.positionValueUsd).toBeNull()
  })

  it('REFUSES an incomplete round (answeredInRound < roundId)', async () => {
    const p = await run(
      reader({ latestRoundData: async () => [9n, 22_244_730_000n, NOW - 60n, NOW - 60n, 4n] as const }),
    )
    expect(p.confidence).toBe('refuse')
    expect(p.refusalReason).toMatch(/answeredInRound < roundId/)
    expect(p.checks.roundComplete).toBe(false)
    expect(p.positionValueUsd).toBeNull()
  })

  it('REFUSES when no feed is published, quoting the error an off-chain price would introduce', async () => {
    const p = await truePosition('CRWD', HOLDER, { reader: reader(), assets: ASSETS, feeds: [] })
    expect(p.confidence).toBe('refuse')
    expect(p.refusalReason).toMatch(/300\.000%/)
  })

  it('DEGRADES, not refuses, on a stale-but-valid feed — a price exists, it is just old', async () => {
    const p = await run(
      reader({
        latestRoundData: async () =>
          [5n, 22_244_730_000n, NOW - 200_000n, NOW - 200_000n, 5n] as const,
      }),
    )
    expect(p.confidence).toBe('degraded')
    expect(p.feedStale).toBe(true)
    expect(p.positionValueUsd).not.toBeNull()
  })

  it('never returns high confidence with any check incomplete', async () => {
    const breakages: Array<Partial<PositionReader>> = [
      { latestRoundData: async () => { throw new Error('fetch failed') } },
      { feedDecimals: async () => { throw new Error('fetch failed') } },
      { oraclePaused: async () => { throw new Error('boom') } },
      { latestRoundData: async () => [5n, -1n, NOW - 60n, NOW - 60n, 5n] as const },
      { latestRoundData: async () => [9n, 1n, NOW - 60n, NOW - 60n, 1n] as const },
    ]
    for (const b of breakages) {
      const p = await run(reader(b))
      const complete = Object.values(p.checks).every(Boolean)
      expect(complete).toBe(false)
      expect(p.confidence).not.toBe('high')
      expect(p.refusalReason).not.toBeNull()
    }
  })

  it('names an unknown symbol as an error and offers the near miss', async () => {
    await expect(run(reader(), 'CRWDD')).rejects.toThrow(/did you mean CRWD/i)
  })
})

describe('didYouMean', () => {
  it('catches a one-keystroke miss from the only 4.0x asset', () => {
    expect(didYouMean('CRWDD', ['CRWD', 'NVDA', 'SPY'])).toBe('CRWD')
    expect(didYouMean('crwd', ['CRWD'])).toBe('CRWD')
  })
  it('returns null rather than guessing wildly', () => {
    expect(didYouMean('ZZZZZ', ['CRWD', 'NVDA'])).toBeNull()
  })
})
