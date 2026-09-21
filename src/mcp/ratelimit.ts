/**
 * Per-IP rate limiting for the public MCP endpoint.
 *
 * The endpoint is unauthenticated by design — every tool is a public chain read and the host holds
 * no keys. The exposure that matters is not data, it is COST: assay_check_symbol runs a full live
 * sweep per call, so an unthrottled endpoint lets anyone burn Robinhood RPC quota and CPU.
 *
 * Two independent limits, because the tools are not equally expensive:
 *   - connections: how often an IP may open an SSE session
 *   - expensive tool calls: sweeps, which cost real upstream work
 *
 * Deliberately in-memory. This is a single-process service; a shared store would add a dependency
 * for no benefit at this scale, and losing counters on restart is acceptable for a throttle.
 */

export interface Limit {
  /** Max events allowed inside the window. */
  max: number
  /** Window length in milliseconds. */
  windowMs: number
}

export const LIMITS = {
  /** Opening SSE sessions. Generous: a legitimate client reconnects. */
  connection: { max: 30, windowMs: 60_000 },
  /** Cheap reads — true_position, findings — are chain reads against a cached sweep. */
  cheapCall: { max: 60, windowMs: 60_000 },
  /** check_symbol runs a live sweep. This is the one that costs us. */
  expensiveCall: { max: 5, windowMs: 60_000 },
} as const satisfies Record<string, Limit>

/** Tools whose cost justifies the tighter bucket. */
export const EXPENSIVE_TOOLS = new Set(['assay_check_symbol'])

/** Hard ceiling on simultaneous SSE sessions, so a slow-loris cannot exhaust memory. */
export const MAX_CONCURRENT_SESSIONS = 50

interface Bucket {
  count: number
  resetAt: number
}

export class RateLimiter {
  private buckets = new Map<string, Bucket>()

  /** Returns null when allowed, or seconds-until-reset when the caller should back off. */
  check(key: string, limit: Limit, now = Date.now()): number | null {
    const bucket = this.buckets.get(key)
    if (!bucket || now >= bucket.resetAt) {
      this.buckets.set(key, { count: 1, resetAt: now + limit.windowMs })
      return null
    }
    if (bucket.count >= limit.max) {
      return Math.ceil((bucket.resetAt - now) / 1000)
    }
    bucket.count++
    return null
  }

  /** Drop expired buckets so an endpoint under scan does not grow unbounded. */
  sweep(now = Date.now()): number {
    let removed = 0
    for (const [k, b] of this.buckets) {
      if (now >= b.resetAt) {
        this.buckets.delete(k)
        removed++
      }
    }
    return removed
  }

  get size(): number {
    return this.buckets.size
  }
}

/**
 * Client IP, honouring x-forwarded-for only for its FIRST entry.
 *
 * Trusting the whole header would let a caller spoof an arbitrary IP and defeat the limiter
 * entirely, so we take the left-most value and fall back to the socket address.
 */
export function clientIp(headers: Record<string, string | string[] | undefined>, socketAddr?: string): string {
  const xff = headers['x-forwarded-for']
  const raw = Array.isArray(xff) ? xff[0] : xff
  const first = raw?.split(',')[0]?.trim()
  return first || socketAddr || 'unknown'
}
