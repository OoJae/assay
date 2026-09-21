import { describe, it, expect } from 'vitest'
import { RateLimiter, clientIp, LIMITS, EXPENSIVE_TOOLS, MAX_TRACKED_CLIENTS } from '../src/mcp/ratelimit.js'

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
