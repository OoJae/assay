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

async function getJson<T>(url: string, label: string): Promise<T> {
  const res = await fetch(url, { headers: { accept: 'application/json' } })
  if (!res.ok) throw new Error(`${label}: HTTP ${res.status} from ${url}`)
  return (await res.json()) as T
}

export async function fetchRhAssets(): Promise<RhAsset[]> {
  const raw = await getJson<unknown>(RH_ASSETS_URL, 'rh/assets')
  const list = Array.isArray(raw)
    ? raw
    : ((raw as Record<string, unknown>).assets as unknown[]) ?? []
  return list as RhAsset[]
}

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

export async function fetchChainlinkFeeds(): Promise<ChainlinkFeed[]> {
  const feeds = await getJson<ChainlinkFeed[]>(CHAINLINK_FEEDS_URL, 'chainlink/feeds')
  return feeds
}

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
