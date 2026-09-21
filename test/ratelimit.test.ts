import { describe, it, expect } from 'vitest'
import { RateLimiter, clientIp, LIMITS, EXPENSIVE_TOOLS } from '../src/mcp/ratelimit.js'

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
  it('uses the socket address when no proxy header is present', () => {
    expect(clientIp({}, '1.2.3.4')).toBe('1.2.3.4')
  })

  it('takes only the FIRST x-forwarded-for entry', () => {
    // Trusting the whole header would let a caller append a fake IP and dodge the limiter.
    expect(clientIp({ 'x-forwarded-for': '9.9.9.9, 1.2.3.4' }, '5.5.5.5')).toBe('9.9.9.9')
  })

  it('does not let a spoofed trailing entry change the identity', () => {
    const a = clientIp({ 'x-forwarded-for': '9.9.9.9, 8.8.8.8' }, 's')
    const b = clientIp({ 'x-forwarded-for': '9.9.9.9, 7.7.7.7' }, 's')
    expect(a).toBe(b)
  })

  it('falls back when everything is missing', () => {
    expect(clientIp({}, undefined)).toBe('unknown')
  })
})
