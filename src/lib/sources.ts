/**
 * Off-chain data sources. Every value fetched here is treated as UNTRUSTED until
 * re-verified against chain state by the verifier — see src/verify.
 */

export const RH_ASSETS_URL = 'https://api.robinhood.com/rhj/assets'
export const RH_PRICES_URL = (symbol: string) => `https://api.robinhood.com/rhj/prices/${symbol}`
export const RH_CORPORATE_ACTIONS_URL = 'https://api.robinhood.com/rhj/corporate-actions'
export const CHAINLINK_FEEDS_URL =
  'https://reference-data-directory.vercel.app/feeds-robinhood-mainnet.json'
export const IXS_VAULTS_URL = 'https://api-v2.ixs.finance/vaults'
export const IXS_MCP_URL = 'https://api-v2.ixs.finance/mcp'

export interface RhDeployment {
  contractAddress: `0x${string}`
  chainId: number
  networkName?: string
}

export interface RhAsset {
  id: string
  tokenSymbol: string
  tokenName: string
  tokenDecimals: number
  isin?: string
  /** 18-dp decimal string, shares-per-token. THIS IS THE CORPORATE-ACTION MULTIPLIER. */
  currentMultiplier: string
  pendingMultiplier: string
  pendingMultiplierEffectiveTime?: string
  status: string
  deployments: RhDeployment[]
  tradingCapabilities?: Record<string, unknown> | null
}

export interface ChainlinkFeed {
  name: string
  proxyAddress: `0x${string}`
  decimals: number
  /** seconds; every Robinhood equity feed is 86400 */
  heartbeat: number
  feedType?: string
  assetName?: string
  /**
   * docs.marketHours is "us_equities_24/5" for all 35 Robinhood equity feeds and "Crypto"
   * for the 22 crypto feeds. This is the field that separates EXPECTED weekend staleness
   * from a genuine incident — and it exists only off-chain, which is precisely why a
   * contract-side heartbeat check cannot tell the difference.
   */
  docs?: { marketHours?: string; [k: string]: unknown }
}

/** True when this feed only updates during US equity market hours (24/5). */
export function is24x5(feed: ChainlinkFeed): boolean {
  return (feed.docs?.marketHours ?? '').toLowerCase().includes('equities')
}

/**
 * How far past its heartbeat a feed may be before it counts as stale.
 *
 * A heartbeat is when the node SENDS the update, not when it lands. SGOV only updates on its
 * heartbeat, and its consecutive rounds (52-64) are 86,400-86,426s apart: every day, for up to
 * ~26s around 00:00 UTC, a strict `age > heartbeat` called it stale. 00:00 UTC is inside the 24/5
 * session with the rest of the cohort fresh, so a sweep landing in that window published a
 * high-severity "stale DURING MARKET HOURS" incident against a feed that was on schedule.
 *
 * Ten minutes is over twenty times the worst overshoot measured and under 1% of the 86,400s
 * heartbeat every Robinhood feed publishes, so a feed that has genuinely stopped is still caught.
 */
export const HEARTBEAT_GRACE_SECONDS = 600

/** True when a feed's age is past its heartbeat by more than the delivery grace above. */
export function pastHeartbeat(ageSeconds: number, heartbeat: number): boolean {
  return ageSeconds > heartbeat + HEARTBEAT_GRACE_SECONDS
}

/**
 * The 24/5 US equity session, in New York time: it closes Friday 20:00 and reopens Sunday 20:00.
 *
 * The earlier window was fixed in UTC (Fri 22:00 -> Mon 02:00) because a calendar was only a
 * tiebreaker. Now that the clock decides (see `scheduledClosure`), its edges are visible: that
 * window opened two to three hours before the Friday close and ran one to two hours past the
 * Sunday reopen, depending on DST. Intl resolves America/New_York with its DST rules, so no
 * table is kept here.
 */
const NEW_YORK_CLOCK = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  weekday: 'short',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
})
const WEEKDAY: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }
const MINUTES_PER_DAY = 24 * 60
const SESSION_CLOSES = 5 * MINUTES_PER_DAY + 20 * 60 // Friday 20:00 New York
const SESSION_REOPENS = 0 * MINUTES_PER_DAY + 20 * 60 // Sunday 20:00 New York

/**
 * How long after the reopen the clock still says closed.
 *
 * The cohort does not refresh at 20:00:00. On Monday 2026-09-21 the 35 feeds made their first
 * post-weekend updates between 00:00:19 and 00:00:50 UTC, so a cohort measured inside those 31
 * seconds reads as half stale, below the 90% that corroborates a closure, and every feed not yet
 * refreshed would be published as an incident. Fifteen minutes covers that window with room to
 * spare, and it only delays an incident call; it never makes one.
 */
export const REOPEN_SETTLE_MINUTES = 15

/** Minutes since Sunday 00:00 in New York at this instant. */
function newYorkMinuteOfWeek(atSeconds: number): number {
  const parts = NEW_YORK_CLOCK.formatToParts(new Date(atSeconds * 1000))
  const part = (type: string) => parts.find((p) => p.type === type)?.value ?? ''
  return WEEKDAY[part('weekday')]! * MINUTES_PER_DAY + Number(part('hour')) * 60 + Number(part('minute'))
}

/**
 * Is the US equity market inside its scheduled weekend closure at this instant?
 *
 * Weekday market holidays are not in here. There is no holiday table to go stale; the cohort
 * covers them instead — see `scheduledClosure()`.
 */
export function isEquityMarketClosed(atSeconds: number): boolean {
  const m = newYorkMinuteOfWeek(atSeconds)
  return m >= SESSION_CLOSES || m < SESSION_REOPENS + REOPEN_SETTLE_MINUTES
}

/**
 * The stale fraction at which the cohort itself corroborates a closure.
 *
 * Exported because a closure the clock called is not one the cohort corroborated: on a Saturday
 * morning 1 of 35 feeds can be stale and the market is still closed. Anything that SAYS the cohort
 * corroborates the closure (a finding statement, the README line) has to test this, not
 * `marketClosed`, or it prints "1 of 35 stale, which corroborates a closure".
 */
export const COHORT_CLOSURE_FRACTION = 0.9

/**
 * Decide whether staleness across the 24/5 cohort is a SCHEDULED CLOSURE rather than an incident.
 *
 * The clock decides first. Inside the weekend closure, staleness is expected whatever fraction of
 * the cohort has gone stale so far, because the cohort does not go stale together: each feed's
 * last Friday update lands whenever its price last moved, and its heartbeat runs from there.
 * Measured on-chain for Saturday 2026-09-19: SPY last updated Fri 12:22 UTC and went stale Sat
 * 12:22, AAPL at 15:11, QQQ at 19:50, and SGOV not until Sun 00:01. The old rule called anything
 * at or below 20% stale an incident before it looked at the clock, so for about 7.5 hours that
 * Saturday it would have published seven named feeds as "stale DURING MARKET HOURS", the exact
 * accusation this product exists to prevent, while the wall said the market was open.
 *
 * Outside the weekend, the cohort covers what the clock cannot: on a weekday market holiday nearly
 * the whole cohort goes stale together, so 90% or more is read as a closure. One stale feed among
 * fresh peers on a weekday is still an incident.
 */
export function scheduledClosure(staleCount: number, cohortSize: number, clockHint: boolean): boolean {
  if (clockHint) return true
  if (cohortSize < 3) return false // too small to corroborate a holiday
  return staleCount / cohortSize >= COHORT_CLOSURE_FRACTION // the whole cohort is down together -> closed
}

/**
 * Every outbound fetch is bounded.
 *
 * undici's default leaves a hung connection open for ~300s. These calls sit in the PAID request
 * path — assay_true_position resolves the asset registry and the Chainlink directory before it
 * reads anything — so one slow upstream pinned a buyer's call and held an MCP session slot for
 * five minutes. A bounded failure the caller can see beats an unbounded wait it cannot.
 */
const FETCH_TIMEOUT_MS = 5_000

/**
 * One retry, and only on a transport failure.
 *
 * Measured: Robinhood's /rhj/assets returns 163KB in 1.2-2.8s normally, and its tail crossed the
 * 5s bound twice in one session — once failing a live sweep, once a test. Both directories are
 * memoised and served stale on error, so this only bites on a cold start, where there is nothing
 * stale to fall back to. A second bounded attempt covers that tail while keeping every individual
 * attempt capped; an HTTP error status is a real answer and is not retried.
 */
const FETCH_ATTEMPTS = 2

async function getJson<T>(url: string, label: string): Promise<T> {
  let lastErr = ''
  for (let attempt = 1; attempt <= FETCH_ATTEMPTS; attempt++) {
    let res: Response
    try {
      res = await fetch(url, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      })
    } catch (err) {
      const e = err as Error
      lastErr =
        e.name === 'TimeoutError' || e.name === 'AbortError'
          ? `${label}: timed out after ${FETCH_TIMEOUT_MS}ms fetching ${url}`
          : `${label}: ${e.message} fetching ${url}`
      continue
    }
    if (!res.ok) throw new Error(`${label}: HTTP ${res.status} from ${url}`)
    return (await res.json()) as T
  }
  throw new Error(`${lastErr} (after ${FETCH_ATTEMPTS} attempts)`)
}

/**
 * Memoised directory fetches.
 *
 * These two are ~238 KB combined and effectively static — the asset registry changes on corporate
 * actions, the Chainlink directory on a new feed listing. Re-fetching both on every paid call put
 * a ~1.5s floor under a request that is otherwise a handful of eth_calls. The TTL is short enough
 * that a newly listed feed or a changed multiplier is picked up within the minute.
 *
 * In-flight requests are shared rather than duplicated, so a burst of concurrent calls after a
 * cold start makes one request, not one per caller.
 */
const DIRECTORY_TTL_MS = 60_000

function memoise<T>(fetcher: () => Promise<T>): () => Promise<T> {
  let at = 0
  let value: T | null = null
  let inFlight: Promise<T> | null = null
  return async () => {
    if (value !== null && Date.now() - at < DIRECTORY_TTL_MS) return value
    if (inFlight) return inFlight
    inFlight = fetcher()
      .then((v) => {
        value = v
        at = Date.now()
        return v
      })
      .finally(() => {
        inFlight = null
      })
    try {
      return await inFlight
    } catch (err) {
      // Serve a stale directory rather than failing the call outright: a 10-minute-old feed list
      // is far better than refusing to price anything because a CDN blipped.
      if (value !== null) return value
      throw err
    }
  }
}

async function fetchRhAssetsUncached(): Promise<RhAsset[]> {
  const raw = await getJson<unknown>(RH_ASSETS_URL, 'rh/assets')
  const list = Array.isArray(raw)
    ? raw
    : ((raw as Record<string, unknown>).assets as unknown[]) ?? []
  return list as RhAsset[]
}

export const fetchRhAssets = memoise(fetchRhAssetsUncached)

/** Raw UNDERLYING equity bid/ask. NOT multiplier-adjusted — this is the whole point. */
export async function fetchRhUnderlyingPrice(
  symbol: string,
): Promise<{ bid: number; ask: number; mid: number; isTradingHalt: boolean; generatedAt: string } | null> {
  try {
    const raw = await getJson<{ quotes?: Array<Record<string, string | boolean>> }>(
      RH_PRICES_URL(symbol),
      'rh/prices',
    )
    const q = raw.quotes?.[0]
    if (!q) return null
    const bid = Number(q.bid)
    const ask = Number(q.ask)
    return {
      bid,
      ask,
      mid: (bid + ask) / 2,
      isTradingHalt: Boolean(q.isTradingHalt),
      generatedAt: String(q.generatedAt ?? ''),
    }
  } catch {
    return null
  }
}

export const fetchChainlinkFeeds = memoise(() =>
  getJson<ChainlinkFeed[]>(CHAINLINK_FEEDS_URL, 'chainlink/feeds'),
)

/**
 * Map a Robinhood ticker to its Chainlink feed. Feed names in the directory are
 * inconsistent: "Robinhood NVDA / USD", "Robinhood SGOV-USD", "Robinhood DELL-USD".
 * Returns null when no feed exists — which is itself a finding (only ~40 of 194
 * assets have a feed; CRWD, the 4.0x token, has none).
 */
export function feedForSymbol(feeds: ChainlinkFeed[], symbol: string): ChainlinkFeed | null {
  const want = symbol.toUpperCase()
  for (const f of feeds) {
    const n = (f.name ?? '').toUpperCase()
    if (!n.startsWith('ROBINHOOD')) continue
    const token = n
      .replace(/^ROBINHOOD/, '')
      .replace(/USD$/, '')
      .replace(/[/\-]/g, ' ')
      .trim()
      .split(/\s+/)[0]
    if (token === want) return f
  }
  return null
}
