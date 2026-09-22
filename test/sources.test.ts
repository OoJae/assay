import { describe, it, expect } from 'vitest'
import {
  feedForSymbol,
  is24x5,
  isEquityMarketClosed,
  scheduledClosure,
  type ChainlinkFeed,
} from '../src/lib/sources.js'

/**
 * Offline tests for the pure helpers that decide a subject's SEVERITY.
 *
 * These carried no coverage at all while the suite concentrated on the verifier — where the risk
 * mostly is not, because the verifier is the part that already refuses to be wrong. The
 * market-closure classifier is where a mistake turns an expected weekend into an accusation.
 */

const feed = (name: string, marketHours?: string): ChainlinkFeed => ({
  name,
  proxyAddress: '0x1111111111111111111111111111111111111111',
  decimals: 8,
  heartbeat: 86400,
  ...(marketHours ? { docs: { marketHours } } : {}),
})

describe('feedForSymbol — the directory names feeds three different ways', () => {
  const feeds = [
    feed('Robinhood NVDA / USD'),
    feed('Robinhood SGOV-USD'),
    feed('Robinhood DELL-USD'),
    feed('BTC / USD'),
  ]

  it('matches the slash-separated spelling', () => {
    expect(feedForSymbol(feeds, 'NVDA')?.name).toBe('Robinhood NVDA / USD')
  })
  it('matches the hyphenated spelling', () => {
    expect(feedForSymbol(feeds, 'SGOV')?.name).toBe('Robinhood SGOV-USD')
    expect(feedForSymbol(feeds, 'DELL')?.name).toBe('Robinhood DELL-USD')
  })
  it('is case-insensitive on the ticker', () => {
    expect(feedForSymbol(feeds, 'nvda')?.name).toBe('Robinhood NVDA / USD')
  })
  it('returns null rather than guessing — an absent feed is itself the finding', () => {
    // CRWD, the only 4.0x token on the chain, has no feed. Returning a near match here would
    // price a position off the wrong asset.
    expect(feedForSymbol(feeds, 'CRWD')).toBeNull()
  })
  it('ignores non-Robinhood feeds sharing the directory', () => {
    expect(feedForSymbol(feeds, 'BTC')).toBeNull()
  })
})

describe('is24x5', () => {
  it('separates the 35 equity feeds from the 22 crypto feeds', () => {
    expect(is24x5(feed('Robinhood NVDA / USD', 'us_equities_24/5'))).toBe(true)
    expect(is24x5(feed('BTC / USD', 'Crypto'))).toBe(false)
  })
  it('treats a feed with no marketHours metadata as not 24/5', () => {
    expect(is24x5(feed('Robinhood XYZ / USD'))).toBe(false)
  })
})

describe('isEquityMarketClosed — a WEAK hint only', () => {
  const at = (iso: string) => Math.floor(new Date(iso).getTime() / 1000)

  it('is true across the whole weekend', () => {
    expect(isEquityMarketClosed(at('2026-09-18T23:00:00Z'))).toBe(true) // Friday night
    expect(isEquityMarketClosed(at('2026-09-19T12:00:00Z'))).toBe(true) // Saturday
    expect(isEquityMarketClosed(at('2026-09-20T21:57:00Z'))).toBe(true) // Sunday
  })
  it('is false during a Tuesday session', () => {
    expect(isEquityMarketClosed(at('2026-09-22T15:00:00Z'))).toBe(false)
  })
  it('errs toward "expected" at the edges rather than toward accusing anyone', () => {
    expect(isEquityMarketClosed(at('2026-09-21T01:00:00Z'))).toBe(true) // early Monday UTC
  })
  it('does NOT extend the hint into the Monday session', () => {
    // The hint is only a tiebreaker. Letting it run all Monday would suppress a real incident.
    expect(isEquityMarketClosed(at('2026-09-21T21:57:00Z'))).toBe(false)
  })
})

describe('scheduledClosure — cohort corroboration, not a calendar', () => {
  it('calls a whole-cohort stall a closure regardless of the clock', () => {
    // Validated live across a real close->open transition: 35/35 stale, then 0/35.
    expect(scheduledClosure(35, 35, false)).toBe(true)
    expect(scheduledClosure(33, 35, false)).toBe(true)
  })
  it('calls an isolated stale feed an incident even when the clock says closed', () => {
    // One stale feed among fresh peers is a real problem whatever day it is.
    expect(scheduledClosure(1, 35, true)).toBe(false)
  })
  it('defers to the clock only in the ambiguous middle', () => {
    expect(scheduledClosure(18, 35, true)).toBe(true)
    expect(scheduledClosure(18, 35, false)).toBe(false)
  })
  it('falls back to the clock when the cohort is too small to corroborate', () => {
    expect(scheduledClosure(2, 2, true)).toBe(true)
    expect(scheduledClosure(2, 2, false)).toBe(false)
  })
  it('does not divide by zero on an empty cohort', () => {
    expect(scheduledClosure(0, 0, true)).toBe(true)
    expect(scheduledClosure(0, 0, false)).toBe(false)
  })
})
