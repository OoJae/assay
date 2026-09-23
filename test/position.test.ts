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
const HOLDER = '0x1234567890AbcdEF1234567890aBcdef12345678' as const
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

const BLOCK = 68_800_493n

/** A reader where every call succeeds and the feed is fresh and sane. Cases override one thing. */
function reader(over: Partial<PositionReader> = {}): PositionReader {
  return {
    head: async () => ({ blockNumber: BLOCK, timestamp: NOW }),
    balanceOf: async () => 13_026_200_000_000_000_000n,
    uiMultiplier: async () => 4_000_000_000_000_000_000n,
    tokenDecimals: async () => 18,
    // Nothing pending: newUIMultiplier() equals uiMultiplier(), effectiveAt() is a past change.
    pendingMultiplier: async () => ({
      newUIMultiplier: 4_000_000_000_000_000_000n,
      effectiveAt: 1_782_999_000n,
    }),
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
      multiplierSane: true,
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
    // |1 - 1/4| of the true value, as the share-count finding says it. Never the retired |m - 1|.
    expect(p.refusalReason).toMatch(/understates the position by 75\.000% of its true value/)
    expect(p.refusalReason).not.toMatch(/300/)
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

  it("gives the feed its delivery grace: SGOV's measured 86,426s round is on schedule, not stale", async () => {
    // A strict `age > heartbeat` called this stale; only the stale-feed test above, at 200,000s,
    // covered the comparison, so reverting to it failed nothing.
    const at = (age: bigint) =>
      run(reader({ latestRoundData: async () => [5n, 22_244_730_000n, NOW - age, NOW - age, 5n] as const }))
    const onSchedule = await at(86_426n)
    expect(onSchedule.feedStale).toBe(false)
    expect(onSchedule.confidence).toBe('high')
    const late = await at(86_400n + 601n)
    expect(late.feedStale).toBe(true)
    expect(late.confidence).toBe('degraded')
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

  it('REFUSES a zero uiMultiplier — the field this product is named after', async () => {
    // The feed answer got a sanity gate; the multiplier did not. A zero multiplier makes every
    // share-equivalent zero and every derived underlying price infinite, and it reached
    // confidence 'high' with refusalReason null.
    const p = await run(reader({ uiMultiplier: async () => 0n }))
    expect(p.confidence).toBe('refuse')
    expect(p.refusalReason).toMatch(/not a usable scaling factor/i)
    expect(p.checks.multiplierSane).toBe(false)
    expect(p.underlyingSharePriceUsd).toBeNull()
  })

  it('names an unknown symbol as an error and offers the near miss', async () => {
    await expect(run(reader(), 'CRWDD')).rejects.toThrow(/did you mean CRWD/i)
  })
})

describe('truePosition — the answer is reproducible at the block it reports', () => {
  it('pins every read to the block head() returned', async () => {
    // The reads ran at 'latest' while the response reported head()'s block, so on a 0.1s-block
    // chain the balance, multiplier and feed came from blocks the answer did not name.
    const seen: Array<[string, bigint]> = []
    const rec = <T>(name: string, value: T) => async (...args: unknown[]) => {
      seen.push([name, (args[args.length - 1] as { blockNumber: bigint }).blockNumber])
      return value
    }
    const base = reader()
    const p = await run(
      reader({
        balanceOf: rec('balanceOf', 13_026_200_000_000_000_000n),
        uiMultiplier: rec('uiMultiplier', 4_000_000_000_000_000_000n),
        tokenDecimals: rec('tokenDecimals', 18),
        pendingMultiplier: rec('pendingMultiplier', await base.pendingMultiplier(TOKEN, { blockNumber: 0n, deadline: 0 })),
        oraclePaused: rec('oraclePaused', false),
        latestRoundData: rec('latestRoundData', [5n, 22_244_730_000n, NOW - 60n, NOW - 60n, 5n] as const),
        feedDecimals: rec('feedDecimals', 8),
      }),
    )
    expect(p.blockNumber).toBe(BLOCK.toString())
    expect(seen.map(([n]) => n).sort()).toEqual(
      ['balanceOf', 'feedDecimals', 'latestRoundData', 'oraclePaused', 'pendingMultiplier', 'tokenDecimals', 'uiMultiplier'],
    )
    for (const [name, block] of seen) expect([name, block]).toEqual([name, BLOCK])
  })

  it('reads the token decimals instead of assuming 18', async () => {
    // 13.0262 tokens of a 6dp token. Under the old hardcoded 1e18 this printed 1.30262e-11 tokens.
    const p = await run(reader({ tokenDecimals: async () => 6, balanceOf: async () => 13_026_200n }))
    expect(p.tokenDecimals).toBe(6)
    expect(p.tokenUnits).toBeCloseTo(13.0262, 6)
    expect(p.shareEquivalents).toBeCloseTo(52.1048, 4)
    expect(p.confidence).toBe('high')
  })

  it('throws, rather than guessing 18, when decimals() cannot be read', async () => {
    await expect(
      run(reader({ tokenDecimals: async () => { throw new Error('execution reverted') } })),
    ).rejects.toThrow(/execution reverted/)
  })
})

describe('truePosition — a scheduled multiplier change is disclosed', () => {
  it('reports nothing pending when newUIMultiplier() equals uiMultiplier()', async () => {
    const p = await run(reader())
    expect(p.pending).toEqual({
      checked: true,
      newUIMultiplier: null,
      newMultiplier: null,
      effectiveAt: null,
      secondsUntilEffective: null,
    })
    expect(p.warning).toBeNull()
  })

  it('warns, with the time, when the multiplier is about to step', async () => {
    const p = await run(
      reader({
        pendingMultiplier: async () => ({
          newUIMultiplier: 4_008_000_000_000_000_000n,
          effectiveAt: NOW + 576n,
        }),
      }),
    )
    expect(p.pending.checked).toBe(true)
    expect(p.pending.newUIMultiplier).toBe('4008000000000000000')
    expect(p.pending.newMultiplier).toBeCloseTo(4.008, 9)
    expect(p.pending.secondsUntilEffective).toBe(576)
    expect(p.pending.effectiveAt).toBe(new Date(Number(NOW + 576n) * 1000).toISOString())
    expect(p.warning).toMatch(/4\.000000000 -> 4\.008000000/)
    expect(p.warning).toMatch(/in about 10 min/)
    // The reading is right at its block, so this is a warning, not a refusal.
    expect(p.confidence).toBe('high')
    expect(p.refusalReason).toBeNull()
  })

  it('says it could not rule a change out when the pending read fails — unknown is not "none"', async () => {
    const p = await run(
      reader({
        pendingMultiplier: async () => {
          throw new Error('fetch failed')
        },
      }),
    )
    expect(p.pending.checked).toBe(false)
    expect(p.pending.newUIMultiplier).toBeNull()
    expect(p.warning).toMatch(/cannot be ruled out/)
  })
})

describe('truePosition — one deadline over the whole call', () => {
  const never = () => new Promise<never>(() => {})

  it('fails at the deadline when a load-bearing read hangs, not a per-read budget later', async () => {
    const started = Date.now()
    await expect(
      truePosition('TEST', HOLDER, {
        reader: reader({ balanceOf: never }),
        assets: ASSETS,
        feeds: FEEDS,
        deadlineMs: 150,
      }),
    ).rejects.toThrow(/deadline/)
    expect(Date.now() - started).toBeLessThan(1_000)
  })

  it('counts time already spent: slow stages share one budget instead of each getting their own', async () => {
    // head() takes 100ms of a 150ms budget, so the feed read that needs another 100ms must miss
    // it. With a per-read deadline both would have fit.
    const slow = <T>(v: T) => () => new Promise<T>((r) => setTimeout(() => r(v), 100))
    const p = await truePosition('TEST', HOLDER, {
      reader: reader({
        head: slow({ blockNumber: BLOCK, timestamp: NOW }),
        latestRoundData: slow([5n, 22_244_730_000n, NOW - 60n, NOW - 60n, 5n] as const),
      }),
      assets: ASSETS,
      feeds: FEEDS,
      deadlineMs: 150,
    })
    expect(p.confidence).toBe('refuse')
    expect(p.checks.feedRead).toBe(false)
    expect(p.refusalReason).toMatch(/could not be read.*timed out/)
  })

  it('refuses, within the deadline, when the pause check hangs', async () => {
    const p = await truePosition('TEST', HOLDER, {
      reader: reader({ oraclePaused: never }),
      assets: ASSETS,
      feeds: FEEDS,
      deadlineMs: 100,
    })
    expect(p.confidence).toBe('refuse')
    expect(p.checks.pauseChecked).toBe(false)
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
