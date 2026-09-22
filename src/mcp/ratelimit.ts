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

/** Hard ceiling on tracked identities, so bucket growth is bounded even under a key-churn attack. */
export const MAX_TRACKED_CLIENTS = 10_000

export class RateLimiter {
  private buckets = new Map<string, Bucket>()

  /** Returns null when allowed, or seconds-until-reset when the caller should back off. */
  check(key: string, limit: Limit, now = Date.now()): number | null {
    const bucket = this.buckets.get(key)
    if (!bucket || now >= bucket.resetAt) {
      if (!bucket && this.buckets.size >= MAX_TRACKED_CLIENTS) {
        // Reap first; if still full, fail CLOSED rather than growing without bound.
        this.sweep(now)
        if (this.buckets.size >= MAX_TRACKED_CLIENTS) return Math.ceil(limit.windowMs / 1000)
      }
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
 * Trusted proxy peers, as CIDR-less exact addresses, from MCP_TRUSTED_PROXIES.
 *
 * EMPTY BY DEFAULT, and that default is the point: this service is exposed directly on a public
 * IP with no proxy in front of it, so nothing should be trusted to tell us who the caller is.
 */
export function trustedProxies(env: string | undefined = process.env.MCP_TRUSTED_PROXIES): Set<string> {
  return new Set(
    (env ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  )
}

/** Normalise so ::ffff:1.2.3.4 and 1.2.3.4 are one identity, and collapse IPv6 to its /64. */
export function normaliseIp(addr: string): string {
  let a = addr.trim().toLowerCase()
  if (a.startsWith('::ffff:')) a = a.slice(7)
  if (a.includes(':')) {
    // An IPv6 client trivially has a /64 to itself, so limiting per-address is no limit at all.
    const parts = a.split(':')
    return parts.slice(0, 4).join(':') + '::/64'
  }
  return a
}

/**
 * Identify the client for rate-limiting purposes.
 *
 * x-forwarded-for is honoured ONLY when the immediate peer is an explicitly trusted proxy.
 *
 * The first version took the header's first entry unconditionally, with a comment claiming it
 * prevented spoofing. It did the opposite: with no proxy deployed, any caller could mint a fresh
 * bucket per request by rotating the header. Measured against the real limits — rotating XFF over
 * one socket: 200 allowed, 0 blocked, against a 30/min limit. Without the header: 30 allowed,
 * 170 blocked. Every limit was a no-op for anyone who sent a header, while the README advertised
 * the protection to third parties.
 *
 * TRUSTING THE PEER WAS NOT ENOUGH, which is the second half of this and was measured too.
 * nginx's `$proxy_add_x_forwarded_for` APPENDS the real address to whatever the client sent, so
 * the LEFTMOST entry is still attacker-authored even behind a trusted proxy. Measured against the
 * deployed stack: 42 bursted connections with no header gave 29 allowed / 13 limited, and the
 * same burst with a rotating `X-Forwarded-For` gave ZERO 429s. Putting a proxy in front had
 * re-opened the exact bypass this function exists to close.
 *
 * The RIGHTMOST entry is the one the trusted proxy itself appended, so it is the only entry a
 * client cannot author. That is what is used, and it stays correct whether the proxy appends or
 * overwrites.
 */
export function clientIp(
  headers: Record<string, string | string[] | undefined>,
  socketAddr?: string,
  trusted: Set<string> = trustedProxies(),
): string {
  const peer = normaliseIp(socketAddr ?? 'unknown')
  if (!trusted.has(peer)) return peer

  const xff = headers['x-forwarded-for']
  const raw = Array.isArray(xff) ? xff.join(',') : xff
  const hops = (raw ?? '')
    .split(',')
    .map((h) => h.trim())
    .filter(Boolean)
  const nearest = hops[hops.length - 1]
  return nearest ? normaliseIp(nearest) : peer
}
