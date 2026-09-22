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
 * Is the US equity market plausibly closed at this instant?
 *
 * Used only as a WEAK HINT. A hardcoded calendar gets DST and market holidays wrong, and
 * mislabelling a scheduled closure as an incident is the failure mode that would discredit
 * this whole product. The primary signal is cohort corroboration — see `scheduledClosure()`.
 *
 * Window is deliberately GENEROUS (Fri 22:00 UTC -> Mon 02:00 UTC) so that we err toward
 * "expected" rather than toward accusing anyone.
 */
export function isEquityMarketClosed(atSeconds: number): boolean {
  const d = new Date(atSeconds * 1000)
  const day = d.getUTCDay() // 0 Sun .. 6 Sat
  const hour = d.getUTCHours()
  if (day === 6 || day === 0) return true // all of Saturday and Sunday UTC
  if (day === 5 && hour >= 22) return true // Friday evening
  if (day === 1 && hour < 2) return true // early Monday, before the EST/EDT open settles
  return false
}

/**
 * Decide whether staleness across the 24/5 cohort is a SCHEDULED CLOSURE rather than an incident.
 *
 * All 35 Robinhood equity feeds share one publication schedule. If nearly all of them are stale
 * at the same instant, the overwhelmingly likelier explanation is that the market is shut — not
 * 35 simultaneous independent oracle failures. Conversely, one stale feed among fresh peers is a
 * genuine incident regardless of what any calendar says.
 *
 * This is more robust than a hardcoded calendar: it needs no DST handling and no holiday table.
 */
export function scheduledClosure(staleCount: number, cohortSize: number, clockHint: boolean): boolean {
  if (cohortSize < 3) return clockHint // too small to corroborate; fall back to the clock
  const fraction = staleCount / cohortSize
  if (fraction >= 0.9) return true // the whole cohort is down together -> closed
  if (fraction <= 0.2) return false // isolated -> incident
  return clockHint // ambiguous middle -> defer to the clock
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
