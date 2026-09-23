/**
 * Per-IP rate limiting for the public MCP endpoint.
 *
 * The endpoint is unauthenticated by design — every tool is a public chain read and the host holds
 * no keys. The exposure that matters is not data, it is COST: assay_check_symbol runs a full live
 * sweep per call, so an unthrottled endpoint lets anyone burn Robinhood RPC quota and CPU. That RPC
 * and this host's egress IP are shared with the paid agent, so free load that draws a Cloudflare
 * challenge fails calls someone has already paid for.
 *
 * Per-IP limits, because the tools are not equally expensive, and one process-wide cap on how many
 * chain-reading calls run at once:
 *   - connections: how often an IP may open an SSE session
 *   - tool calls: a bucket per cost class (see TOOL_BUCKETS)
 *   - in flight: HEAVY_TOOL_CONCURRENCY, whoever is asking
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
  /** Cheap reads — true_position's verdict, findings — are a few chain reads or a cached file. */
  cheapCall: { max: 60, windowMs: 60_000 },
  /**
   * check_contract's free verdict: head, getCode and the proxy slots, about 3 to 7 reads.
   *
   * It sat in the 60/min cheap bucket while it was the full audit, a feed read and a balanceOf for
   * every divergent token on each call, so one IP could drive ~1,900 RPC reads a minute from the
   * paid agent's address. The verdict is lighter, but it is still the one free call that takes an
   * arbitrary address, so it is the one worth scripting over a list: its own, tighter bucket.
   */
  contractCall: { max: 10, windowMs: 60_000 },
  /** check_symbol runs a live sweep. This is the one that costs us. */
  expensiveCall: { max: 5, windowMs: 60_000 },
} as const satisfies Record<string, Limit>

/** Tools whose cost justifies the tightest bucket. */
export const EXPENSIVE_TOOLS = new Set(['assay_check_symbol'])

/** Which bucket a tools/call is metered in. Anything not named here is a cheap read. */
export const TOOL_BUCKETS: Record<string, { key: string; limit: Limit; label: string }> = {
  assay_check_symbol: { key: 'exp', limit: LIMITS.expensiveCall, label: 'sweep' },
  assay_check_contract: { key: 'contract', limit: LIMITS.contractCall, label: 'contract verdict' },
}

export function toolBucket(tool: string): { key: string; limit: Limit; label: string } {
  return TOOL_BUCKETS[tool] ?? { key: 'cheap', limit: LIMITS.cheapCall, label: 'read' }
}

/**
 * Hard ceiling on simultaneous SSE sessions, so a slow-loris cannot exhaust memory.
 *
 * 50 with 6 per IP meant nine addresses could hold every slot indefinitely. An idle session costs
 * a few KB, so the global ceiling is high and the per-IP one (sse.ts) is what bounds a caller.
 */
export const MAX_CONCURRENT_SESSIONS = 200

/**
 * How many calls of each chain-reading tool may run at once, across every session and transport.
 *
 * The per-IP buckets bound one caller; nothing bounded all of them together, so a handful of IPs
 * inside their own limits could still run dozens of sweeps against the RPC at the same moment. A
 * call over the cap is answered at once with a tool error rather than queued: a queue would hold
 * the caller's request for an unknown time and keep the load, where a refusal sheds it.
 */
export const HEAVY_TOOL_CONCURRENCY: Record<string, number> = {
  assay_check_symbol: 2,
  assay_check_contract: 4,
  assay_true_position: 8,
}

/**
 * How many of those slots one address may hold at once: half of each, so no caller holds them all.
 *
 * The process-wide cap alone let one address inside its own per-minute budget take every slot:
 * check_symbol allows 5 a minute and a one-symbol sweep runs for seconds to tens of seconds, and
 * true_position allows 60 a minute while a call through the RPC fallback can take 12s per endpoint.
 * Everyone else was then told "busy" by a single caller.
 */
export const HEAVY_TOOL_CONCURRENCY_PER_IP: Record<string, number> = {
  assay_check_symbol: 1,
  assay_check_contract: 2,
  assay_true_position: 4,
}

export class InFlight {
  private running = new Map<string, number>()

  constructor(
    private readonly caps: Record<string, number> = HEAVY_TOOL_CONCURRENCY,
    private readonly perIp: Record<string, number> = HEAVY_TOOL_CONCURRENCY_PER_IP,
  ) {}

  /**
   * A release function when the call may start, or null when the tool is at its cap, either this
   * address's share or the process's. Without an address only the process cap applies.
   */
  tryEnter(tool: string, ip?: string): (() => void) | null {
    const cap = this.caps[tool]
    if (cap === undefined) return () => {}
    const ipCap = ip === undefined ? undefined : this.perIp[tool]
    const mine = ipCap === undefined ? null : `${tool}\u0000${ip}`
    if (this.count(tool) >= cap) return null
    if (mine && this.count(tool, ip) >= ipCap!) return null
    this.bump(tool, 1)
    if (mine) this.bump(mine, 1)
    let released = false
    return () => {
      // Idempotent: a handler that releases on both its success and its error path must not
      // hand out a slot it never held.
      if (released) return
      released = true
      this.bump(tool, -1)
      if (mine) this.bump(mine, -1)
    }
  }

  /** Calls of `tool` running now: in total, or from one address. */
  count(tool: string, ip?: string): number {
    return this.running.get(ip === undefined ? tool : `${tool}\u0000${ip}`) ?? 0
  }

  private bump(key: string, by: number) {
    const n = Math.max(0, (this.running.get(key) ?? 0) + by)
    // Per-address keys are dropped at zero, so the map stays as small as what is running.
    if (n === 0) this.running.delete(key)
    else this.running.set(key, n)
  }
}

interface Bucket {
  count: number
  resetAt: number
}

/** Hard ceiling on tracked identities, so bucket growth is bounded even under a key-churn attack. */
export const MAX_TRACKED_CLIENTS = 10_000

export class RateLimiter {
  /** Insertion order is recency order: every check moves its key to the end. */
  private buckets = new Map<string, Bucket>()

  constructor(private readonly maxTracked = MAX_TRACKED_CLIENTS) {}

  /** Returns null when allowed, or seconds-until-reset when the caller should back off. */
  check(key: string, limit: Limit, now = Date.now()): number | null {
    const bucket = this.buckets.get(key)
    if (bucket) {
      this.buckets.delete(key)
      this.buckets.set(key, bucket)
    }
    if (!bucket || now >= bucket.resetAt) {
      if (!bucket && this.buckets.size >= this.maxTracked) {
        /**
         * EVICT THE LEAST RECENTLY USED, never refuse the newcomer.
         *
         * A full map used to fail CLOSED for every new key. About 3,300 rotating addresses a
         * minute filled it, and from then on every new client got a 429 — including the wall,
         * whose server-side fetches of /findings.json arrive from a different Vercel address
         * almost every render (69 distinct IPs in 113 fetches) and fall back to the committed
         * copy when refused. Evicting the key touched longest ago cannot help a caller who is
         * being limited, because a limited caller keeps touching its own bucket: it is always
         * among the most recent, and only an address that has gone quiet loses its count.
         */
        const oldest = this.buckets.keys().next().value
        if (oldest !== undefined) this.buckets.delete(oldest)
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
      .filter(Boolean)
      // NORMALISED, because that is what the peer address is compared as.
      //
      // The peer went through normaliseIp() and the configured entries did not, so `::1` — which
      // deploy/assay-mcp.service actually ships — could never match: the peer normalises to
      // `0:0:0:0::/64` and the literal `::1` does not. With nginx connecting over IPv6 loopback
      // the proxy would never be trusted, X-Forwarded-For would be ignored, and EVERY client
      // would share the proxy's single bucket — turning a per-IP limit into a global one and
      // letting one caller lock out all the others.
      .map(normaliseIp),
  )
}

/**
 * Expand a compressed IPv6 address to its eight full groups.
 *
 * Required because the /64 collapse below is only meaningful on a canonical form. Returns null for
 * anything that is not parseable as IPv6, so the caller can fall back rather than invent a bucket.
 */
function expandIpv6(a: string): string[] | null {
  // Strip a zone index (fe80::1%eth0) and any brackets.
  const bare = a.replace(/^\[|\]$/g, '').split('%')[0] ?? ''
  if (!bare.includes(':')) return null

  // A trailing dotted-quad (::ffff:1.2.3.4, 64:ff9b::1.2.3.4) becomes two hex groups.
  let head = bare
  const v4 = head.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/)
  if (v4?.[1]) {
    const o = v4[1].split('.').map(Number)
    if (o.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null
    const hi = ((o[0]! << 8) | o[1]!).toString(16)
    const lo = ((o[2]! << 8) | o[3]!).toString(16)
    head = head.slice(0, -v4[1].length) + `${hi}:${lo}`
  }

  const halves = head.split('::')
  if (halves.length > 2) return null
  const left = (halves[0] ?? '').split(':').filter((x) => x !== '')
  const right = halves.length === 2 ? (halves[1] ?? '').split(':').filter((x) => x !== '') : []
  if (halves.length === 1 && left.length !== 8) return null

  const fill = 8 - left.length - right.length
  if (fill < 0) return null
  const groups = [...left, ...Array(halves.length === 2 ? fill : 0).fill('0'), ...right]
  if (groups.length !== 8) return null
  if (!groups.every((g) => /^[0-9a-f]{1,4}$/.test(g))) return null
  return groups.map((g) => g.replace(/^0+(?=.)/, ''))
}

/**
 * Normalise so ::ffff:1.2.3.4 and 1.2.3.4 are one identity, and collapse IPv6 to its /64.
 *
 * THE /64 COLLAPSE MUST HAPPEN ON AN EXPANDED ADDRESS. This was a bare `split(':').slice(0, 4)`,
 * which only works on fully-written forms. Measured against the real function: `2001:db8::1` and
 * `2001:db8:0:0:0:0:0:2` are the SAME /64 and produced DIFFERENT buckets, as did `::1` and `::2`.
 * So an IPv6 caller could mint a fresh rate-limit bucket per request just by varying how it
 * compressed its own address — which is the exact bypass the collapse exists to close.
 */
export function normaliseIp(addr: string): string {
  const a = addr.trim().toLowerCase()
  if (!a.includes(':')) return a

  const groups = expandIpv6(a)
  // Unparseable: use the literal rather than guessing a prefix that might collide with real clients.
  if (!groups) return a

  // An IPv4-mapped address is that IPv4 address, not a /64 of its own.
  const mapped = a.startsWith('::ffff:') ? a.slice(7) : null
  if (mapped && !mapped.includes(':')) return mapped
  if (groups.slice(0, 5).every((g) => g === '0') && groups[5] === 'ffff') {
    const h = parseInt(groups[6]!, 16)
    const l = parseInt(groups[7]!, 16)
    return `${h >> 8}.${h & 255}.${l >> 8}.${l & 255}`
  }

  // An IPv6 client trivially has a /64 to itself, so limiting per-address is no limit at all.
  return groups.slice(0, 4).join(':') + '::/64'
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
