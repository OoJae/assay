import { describe, it, expect } from 'vitest'
import {
  RateLimiter,
  clientIp,
  normaliseIp,
  LIMITS,
  EXPENSIVE_TOOLS,
  MAX_TRACKED_CLIENTS,
} from '../src/mcp/ratelimit.js'

describe('rate limiter', () => {
  it('allows up to the limit then blocks', () => {
    const rl = new RateLimiter()
    const limit = { max: 3, windowMs: 1000 }
    expect(rl.check('a', limit, 0)).toBeNull()
    expect(rl.check('a', limit, 0)).toBeNull()
    expect(rl.check('a', limit, 0)).toBeNull()
    const retry = rl.check('a', limit, 0)
    expect(retry).not.toBeNull()
    expect(retry).toBeGreaterThan(0)
  })

  it('resets after the window', () => {
    const rl = new RateLimiter()
    const limit = { max: 1, windowMs: 1000 }
    expect(rl.check('a', limit, 0)).toBeNull()
    expect(rl.check('a', limit, 500)).not.toBeNull()
    expect(rl.check('a', limit, 1001)).toBeNull()
  })

  it('tracks each key independently', () => {
    const rl = new RateLimiter()
    const limit = { max: 1, windowMs: 1000 }
    expect(rl.check('a', limit, 0)).toBeNull()
    expect(rl.check('b', limit, 0)).toBeNull()
    expect(rl.check('a', limit, 0)).not.toBeNull()
  })

  it('sweeps expired buckets so memory does not grow unbounded', () => {
    const rl = new RateLimiter()
    const limit = { max: 1, windowMs: 1000 }
    for (let i = 0; i < 100; i++) rl.check(`ip-${i}`, limit, 0)
    expect(rl.size).toBe(100)
    expect(rl.sweep(2000)).toBe(100)
    expect(rl.size).toBe(0)
  })

  it('the expensive sweep tool is limited far more tightly than cheap reads', () => {
    expect(EXPENSIVE_TOOLS.has('assay_check_symbol')).toBe(true)
    expect(LIMITS.expensiveCall.max).toBeLessThan(LIMITS.cheapCall.max)
  })
})

describe('client IP extraction', () => {
  it('uses the socket address and IGNORES x-forwarded-for when no proxy is trusted', () => {
    // This is the regression. The previous implementation returned the header's first entry
    // unconditionally, with a comment claiming that prevented spoofing — and this test asserted
    // that behaviour as CORRECT. With no proxy deployed, rotating the header minted a fresh
    // bucket per request: 200 allowed / 0 blocked against a 30/min limit.
    const none = new Set<string>()
    expect(clientIp({ 'x-forwarded-for': '9.9.9.9' }, '1.2.3.4', none)).toBe('1.2.3.4')
    expect(clientIp({ 'x-forwarded-for': '10.0.0.1, 10.0.0.2' }, '1.2.3.4', none)).toBe('1.2.3.4')
  })

  it('rotating x-forwarded-for can no longer defeat the limiter', () => {
    const rl = new RateLimiter()
    const none = new Set<string>()
    let allowed = 0
    for (let i = 0; i < 200; i++) {
      const ip = clientIp({ 'x-forwarded-for': `10.0.0.${i}` }, '203.0.113.7', none)
      if (rl.check(`conn:${ip}`, { max: 30, windowMs: 60_000 }, 0) === null) allowed++
    }
    expect(allowed).toBe(30)
  })

  it('honours x-forwarded-for ONLY from an explicitly trusted peer', () => {
    const trusted = new Set(['127.0.0.1'])
    expect(clientIp({ 'x-forwarded-for': '9.9.9.9' }, '127.0.0.1', trusted)).toBe('9.9.9.9')
    expect(clientIp({ 'x-forwarded-for': '9.9.9.9' }, '8.8.8.8', trusted)).toBe('8.8.8.8')
  })

  it('treats ::ffff: mapped addresses as the same identity as their IPv4 form', () => {
    const none = new Set<string>()
    expect(clientIp({}, '::ffff:1.2.3.4', none)).toBe(clientIp({}, '1.2.3.4', none))
  })

  it('collapses IPv6 to a /64, since a client trivially owns one', () => {
    const none = new Set<string>()
    const a = clientIp({}, '2001:db8:1:2:aaaa::1', none)
    const b = clientIp({}, '2001:db8:1:2:bbbb::9', none)
    expect(a).toBe(b)
  })

  it('bounds the bucket map instead of growing forever under key churn', () => {
    const rl = new RateLimiter()
    const limit = { max: 1, windowMs: 60_000 }
    for (let i = 0; i < MAX_TRACKED_CLIENTS + 500; i++) rl.check(`k-${i}`, limit, 0)
    expect(rl.size).toBeLessThanOrEqual(MAX_TRACKED_CLIENTS)
  })

  it('falls back when everything is missing', () => {
    expect(clientIp({}, undefined, new Set())).toBe('unknown')
  })
})

describe('client IP behind a real proxy — the appended-header bypass', () => {
  const trusted = new Set(['127.0.0.1'])

  it('takes the RIGHTMOST hop, which is the only entry a client cannot author', () => {
    // nginx's $proxy_add_x_forwarded_for APPENDS the peer address to whatever the client sent, so
    // the leftmost entry stays attacker-controlled even behind a trusted proxy. Measured against
    // the deployed stack: 42 bursted connections with no header gave 29 allowed / 13 limited; the
    // same burst with a rotating X-Forwarded-For gave ZERO 429s. Putting a proxy in front had
    // re-opened the exact bypass this function exists to close.
    expect(clientIp({ 'x-forwarded-for': '203.0.113.9, 8.8.8.8' }, '127.0.0.1', trusted)).toBe('8.8.8.8')
  })

  it('a client rotating the leftmost entry cannot mint new buckets', () => {
    const limiter = new RateLimiter()
    let allowed = 0
    for (let i = 0; i < 60; i++) {
      // The attacker authors the first hop; the proxy appends the real peer. Only the appended one counts.
      const ip = clientIp(
        { 'x-forwarded-for': `203.0.113.${i}, 8.8.8.8` },
        '127.0.0.1',
        trusted,
      )
      if (limiter.check(`conn:${ip}`, LIMITS.connection) === null) allowed++
    }
    expect(allowed).toBe(LIMITS.connection.max)
  })

  it('is still correct when the proxy OVERWRITES rather than appends', () => {
    // deploy/assay-mcp.nginx.conf sets X-Forwarded-For to $remote_addr, so there is one hop and
    // rightmost == leftmost == the peer. Both configurations must give the same answer.
    expect(clientIp({ 'x-forwarded-for': '8.8.8.8' }, '127.0.0.1', trusted)).toBe('8.8.8.8')
  })

  it('handles a repeated header field without letting the client pick the winner', () => {
    expect(
      clientIp({ 'x-forwarded-for': ['203.0.113.1', '203.0.113.2, 8.8.8.8'] }, '127.0.0.1', trusted),
    ).toBe('8.8.8.8')
  })

  it('falls back to the peer when a trusted proxy sends no header at all', () => {
    expect(clientIp({}, '127.0.0.1', trusted)).toBe('127.0.0.1')
  })
})

describe('IPv6 bucketing — the /64 collapse must survive compressed notation', () => {
  it('collapses the same /64 written two different ways', () => {
    // The bug: a bare split(':').slice(0,4) only works on fully-written addresses. Measured
    // against the old function, 2001:db8::1 and 2001:db8:0:0:0:0:0:2 are the SAME /64 and got
    // DIFFERENT buckets — so an IPv6 caller could mint a fresh bucket per request just by varying
    // how it compressed its own address, which is the exact bypass the collapse exists to close.
    expect(normaliseIp('2001:db8::1')).toBe(normaliseIp('2001:db8:0:0:0:0:0:2'))
    expect(normaliseIp('::1')).toBe(normaliseIp('::2'))
    expect(normaliseIp('2001:db8:1:2:aaaa::1')).toBe(normaliseIp('2001:db8:1:2:bbbb::9'))
  })

  it('keeps genuinely different /64s apart', () => {
    expect(normaliseIp('2001:db8:1:3::1')).not.toBe(normaliseIp('2001:db8:1:2::1'))
  })

  it('treats an IPv4-mapped address as that IPv4 address, not a /64', () => {
    expect(normaliseIp('::ffff:1.2.3.4')).toBe('1.2.3.4')
    expect(normaliseIp('::ffff:1.2.3.4')).toBe(normaliseIp('1.2.3.4'))
    // A mapped address must not collide with an unrelated v4 client.
    expect(normaliseIp('::ffff:1.2.3.4')).not.toBe(normaliseIp('1.2.3.5'))
  })

  it('ignores a zone index rather than bucketing on it', () => {
    expect(normaliseIp('fe80::1%eth0')).toBe(normaliseIp('fe80::2'))
  })

  it('an IPv6 client cannot mint buckets by rewriting its own address', () => {
    const limiter = new RateLimiter()
    const spellings = [
      '2001:db8:0:0:0:0:0:1',
      '2001:db8::1',
      '2001:db8:0:0::1',
      '2001:DB8::1',
      '[2001:db8::1]',
      '2001:db8::1%en0',
    ]
    let allowed = 0
    for (let i = 0; i < 60; i++) {
      const ip = normaliseIp(spellings[i % spellings.length]!)
      if (limiter.check(`conn:${ip}`, LIMITS.connection) === null) allowed++
    }
    expect(allowed).toBe(LIMITS.connection.max)
  })

  it('falls back to the literal for unparseable input instead of inventing a prefix', () => {
    expect(normaliseIp('not:a:valid:::address:::')).toBe('not:a:valid:::address:::')
    expect(normaliseIp('unknown')).toBe('unknown')
  })
})
