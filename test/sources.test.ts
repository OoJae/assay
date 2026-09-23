import { describe, it, expect } from 'vitest'
import {
  HEARTBEAT_GRACE_SECONDS,
  feedForSymbol,
  is24x5,
  isEquityMarketClosed,
  pastHeartbeat,
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

describe('isEquityMarketClosed — the 24/5 session in New York time', () => {
  const at = (iso: string) => Math.floor(new Date(iso).getTime() / 1000)

  it('is true across the whole weekend', () => {
    expect(isEquityMarketClosed(at('2026-09-19T00:30:00Z'))).toBe(true) // Fri 20:30 EDT
    expect(isEquityMarketClosed(at('2026-09-19T12:00:00Z'))).toBe(true) // Saturday
    expect(isEquityMarketClosed(at('2026-09-20T21:57:00Z'))).toBe(true) // Sunday
  })
  it('is false during a Tuesday session', () => {
    expect(isEquityMarketClosed(at('2026-09-22T15:00:00Z'))).toBe(false)
  })
  it('closes at Friday 20:00 New York, not at a fixed UTC hour', () => {
    // The old fixed window opened at Fri 22:00 UTC, two hours inside the EDT session.
    expect(isEquityMarketClosed(at('2026-09-18T23:59:00Z'))).toBe(false) // Fri 19:59 EDT
    expect(isEquityMarketClosed(at('2026-09-19T00:00:00Z'))).toBe(true) // Fri 20:00 EDT
    // Under EST the same close is an hour later in UTC.
    expect(isEquityMarketClosed(at('2026-12-05T00:30:00Z'))).toBe(false) // Fri 19:30 EST
    expect(isEquityMarketClosed(at('2026-12-05T01:00:00Z'))).toBe(true) // Fri 20:00 EST
  })
  it('reopens at Sunday 20:00 New York, after a short settle for the cohort to refresh', () => {
    expect(isEquityMarketClosed(at('2026-09-21T00:00:30Z'))).toBe(true) // Sun 20:00:30 EDT, mid-refresh
    expect(isEquityMarketClosed(at('2026-09-21T00:15:00Z'))).toBe(false) // Sun 20:15 EDT
    expect(isEquityMarketClosed(at('2026-12-07T00:30:00Z'))).toBe(true) // Sun 19:30 EST
    expect(isEquityMarketClosed(at('2026-12-07T01:15:00Z'))).toBe(false) // Sun 20:15 EST
  })
  it('follows the DST change on the weekend it happens', () => {
    // 2026-11-01 is the Sunday EDT ends, so that evening's reopen is at 01:00 UTC, not 00:00.
    expect(isEquityMarketClosed(at('2026-11-02T00:30:00Z'))).toBe(true) // Sun 19:30 EST
    expect(isEquityMarketClosed(at('2026-11-02T01:20:00Z'))).toBe(false) // Sun 20:20 EST
    // 2026-03-08 is the Sunday EDT starts, so that evening's reopen is at 00:00 UTC.
    expect(isEquityMarketClosed(at('2026-03-09T00:20:00Z'))).toBe(false) // Sun 20:20 EDT
  })
  it('does NOT extend into the Monday session', () => {
    // Letting the window run into Monday would suppress a real incident.
    expect(isEquityMarketClosed(at('2026-09-21T01:00:00Z'))).toBe(false) // Sun 21:00 EDT
    expect(isEquityMarketClosed(at('2026-09-21T21:57:00Z'))).toBe(false)
  })
})

describe('scheduledClosure — the clock first, the cohort for holidays', () => {
  it('calls any staleness inside the weekend closure scheduled, whatever the fraction', () => {
    // The cohort goes stale feed by feed through Saturday, so a low fraction on a weekend is the
    // closure starting, not an isolated failure.
    expect(scheduledClosure(0, 35, true)).toBe(true)
    expect(scheduledClosure(1, 35, true)).toBe(true)
    expect(scheduledClosure(7, 35, true)).toBe(true)
    expect(scheduledClosure(18, 35, true)).toBe(true)
  })
  it('calls a whole-cohort stall a closure on a weekday (a market holiday)', () => {
    // Validated live across a real close->open transition: 35/35 stale, then 0/35.
    expect(scheduledClosure(35, 35, false)).toBe(true)
    expect(scheduledClosure(33, 35, false)).toBe(true)
  })
  it('calls an isolated stale feed on a weekday an incident', () => {
    expect(scheduledClosure(1, 35, false)).toBe(false)
    expect(scheduledClosure(18, 35, false)).toBe(false)
  })
  it('does not call a holiday from a cohort too small to corroborate one', () => {
    expect(scheduledClosure(2, 2, true)).toBe(true)
    expect(scheduledClosure(2, 2, false)).toBe(false)
  })
  it('does not divide by zero on an empty cohort', () => {
    expect(scheduledClosure(0, 0, true)).toBe(true)
    expect(scheduledClosure(0, 0, false)).toBe(false)
  })
})

describe('pastHeartbeat — a delivery grace, not a strict comparison', () => {
  it('does not call SGOV stale for landing seconds after its heartbeat', () => {
    // SGOV only updates on its heartbeat; consecutive rounds were measured 86,400-86,426s apart.
    expect(pastHeartbeat(86_417, 86_400)).toBe(false)
    expect(pastHeartbeat(86_426, 86_400)).toBe(false)
  })
  it('still calls a feed that has stopped stale', () => {
    expect(pastHeartbeat(86_400 + HEARTBEAT_GRACE_SECONDS + 1, 86_400)).toBe(true)
    expect(pastHeartbeat(172_800, 86_400)).toBe(true)
  })
})

/**
 * The weekend of 2026-09-19, replayed.
 *
 * Every 24/5 equity feed's last update before that weekend and its first update after, read from
 * getRoundData on Robinhood Chain (independently reproduced by two reviewers). Heartbeats are all
 * 86,400s. Feeds go stale one at a time through Saturday as each one's Friday update ages past
 * 24h, and all refresh within 31 seconds of the Sunday reopen.
 */
const WEEKEND_2026_09_19: Array<[symbol: string, lastBefore: string, firstAfter: string]> = [
  ['SPY', '2026-09-18T12:22:01Z', '2026-09-21T00:00:26Z'],
  ['AAPL', '2026-09-18T15:11:28Z', '2026-09-21T00:00:20Z'],
  ['AMZN', '2026-09-18T16:19:12Z', '2026-09-21T00:00:38Z'],
  ['EWY', '2026-09-18T19:12:06Z', '2026-09-21T00:00:24Z'],
  ['CRWV', '2026-09-18T19:37:00Z', '2026-09-21T00:00:36Z'],
  ['TSLA', '2026-09-18T19:48:47Z', '2026-09-21T00:00:39Z'],
  ['QQQ', '2026-09-18T19:50:26Z', '2026-09-21T00:00:48Z'],
  ['META', '2026-09-18T19:53:36Z', '2026-09-21T00:00:23Z'],
  ['RKLB', '2026-09-18T19:55:28Z', '2026-09-21T00:00:50Z'],
  ['NVDA', '2026-09-18T19:55:32Z', '2026-09-21T00:00:20Z'],
  ['MU', '2026-09-18T19:55:34Z', '2026-09-21T00:00:21Z'],
  ['ORCL', '2026-09-18T19:56:34Z', '2026-09-21T00:00:22Z'],
  ['SLV', '2026-09-18T19:56:35Z', '2026-09-21T00:00:22Z'],
  ['DELL', '2026-09-18T19:57:22Z', '2026-09-21T00:00:44Z'],
  ['TSM', '2026-09-18T19:57:46Z', '2026-09-21T00:00:38Z'],
  ['COIN', '2026-09-18T19:57:46Z', '2026-09-21T00:00:38Z'],
  ['AMD', '2026-09-18T19:57:55Z', '2026-09-21T00:00:29Z'],
  ['PLTR', '2026-09-18T19:58:14Z', '2026-09-21T00:00:36Z'],
  ['ASML', '2026-09-18T20:02:05Z', '2026-09-21T00:00:40Z'],
  ['SNDK', '2026-09-18T20:03:22Z', '2026-09-21T00:00:44Z'],
  ['INTC', '2026-09-18T20:11:01Z', '2026-09-21T00:00:35Z'],
  ['GOOGL', '2026-09-18T20:11:48Z', '2026-09-21T00:00:40Z'],
  ['IONQ', '2026-09-18T20:16:21Z', '2026-09-21T00:00:43Z'],
  ['GME', '2026-09-18T20:18:46Z', '2026-09-21T00:00:38Z'],
  ['CRCL', '2026-09-18T20:28:54Z', '2026-09-21T00:00:46Z'],
  ['NBIS', '2026-09-18T20:36:25Z', '2026-09-21T00:00:47Z'],
  ['RGTI', '2026-09-18T20:36:46Z', '2026-09-21T00:00:37Z'],
  ['MSFT', '2026-09-18T20:41:53Z', '2026-09-21T00:00:44Z'],
  ['BABA', '2026-09-18T20:50:45Z', '2026-09-21T00:00:19Z'],
  ['USAR', '2026-09-18T22:44:29Z', '2026-09-21T00:00:31Z'],
  ['SPCX', '2026-09-18T23:07:55Z', '2026-09-21T00:00:27Z'],
  ['CLSK', '2026-09-18T23:40:41Z', '2026-09-21T00:00:24Z'],
  ['MSTR', '2026-09-18T23:41:26Z', '2026-09-21T00:00:43Z'],
  ['USO', '2026-09-18T23:50:32Z', '2026-09-21T00:00:49Z'],
  ['SGOV', '2026-09-19T00:01:45Z', '2026-09-21T00:00:27Z'],
]

describe('the real 2026-09-19 weekend, one sweep every 8 minutes', () => {
  const HEARTBEAT = 86_400
  const sec = (iso: string) => Math.floor(Date.parse(iso) / 1000)
  const staleAt = (t: number) =>
    WEEKEND_2026_09_19.filter(([, before, after]) => {
      const updatedAt = t >= sec(after) ? sec(after) : sec(before)
      return pastHeartbeat(t - updatedAt, HEARTBEAT)
    }).map(([s]) => s)
  const classify = (t: number) => {
    const stale = staleAt(t)
    return { stale, closed: scheduledClosure(stale.length, WEEKEND_2026_09_19.length, isEquityMarketClosed(t)) }
  }

  it('has the 35-feed cohort and the onset the audit measured', () => {
    expect(WEEKEND_2026_09_19).toHaveLength(35)
    // Saturday 12:40 UTC: SPY alone is stale, 1/35. The old rule called this an incident.
    expect(staleAt(sec('2026-09-19T12:40:00Z'))).toEqual(['SPY'])
    // Saturday 20:02 UTC: seven feeds, still at or under the 20% the old rule called isolated.
    expect(staleAt(sec('2026-09-19T20:02:00Z'))).toHaveLength(7)
  })

  it('never publishes a stale feed as an incident, from the Friday close to after the reopen', () => {
    const accused: string[] = []
    for (let t = sec('2026-09-18T12:00:00Z'); t <= sec('2026-09-21T02:00:00Z'); t += 8 * 60) {
      const { stale, closed } = classify(t)
      if (stale.length && !closed) accused.push(`${new Date(t * 1000).toISOString()} ${stale.join(',')}`)
    }
    expect(accused).toEqual([])
  })

  it('has no incident second by second through the 31-second reopen refresh', () => {
    for (let t = sec('2026-09-21T00:00:00Z'); t <= sec('2026-09-21T00:01:00Z'); t++) {
      const { stale, closed } = classify(t)
      if (stale.length) expect(closed).toBe(true)
    }
  })

  it('says closed for the whole closure, including before any feed is stale', () => {
    // The wall used to read "Market open" from the Friday close until the 8th feed went stale.
    for (let t = sec('2026-09-19T00:00:00Z'); t < sec('2026-09-21T00:00:00Z'); t += 8 * 60) {
      expect(classify(t).closed).toBe(true)
    }
  })

  it('says open once the session is back and the cohort is fresh', () => {
    const { stale, closed } = classify(sec('2026-09-21T00:30:00Z'))
    expect(stale).toEqual([])
    expect(closed).toBe(false)
  })

  it('still calls one stale feed among fresh peers on a weekday an incident', () => {
    // Tuesday 2026-09-22 15:00 UTC: one feed a full day past its heartbeat, the rest fresh.
    const t = sec('2026-09-22T15:00:00Z')
    expect(scheduledClosure(1, 35, isEquityMarketClosed(t))).toBe(false)
  })
})
