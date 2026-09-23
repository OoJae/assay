/**
 * Which Stock Tokens the $0.01 call can value.
 *
 * assay_true_position prices a holding only through the token's Chainlink feed on chain 4663. With
 * no feed it still returns the corrected share-equivalents, but it refuses a USD value, and 160 of
 * 195 tokens have none, CRWD among them. A buyer could not find that out before paying, so the
 * wall lists the priced tickers from the same directory the paid call reads.
 */
export const CHAINLINK_FEEDS_URL = 'https://reference-data-directory.vercel.app/feeds-robinhood-mainnet.json'

/**
 * The ticker a directory feed prices, or null for a feed that is not a Robinhood Stock Token feed.
 *
 * The same parse as feedForSymbol in src/lib/sources.ts (web/ cannot import src/), because the
 * directory names are inconsistent: "Robinhood NVDA / USD", "Robinhood SGOV-USD".
 */
export function tickerOfFeed(name: string | undefined): string | null {
  const n = (name ?? '').toUpperCase()
  if (!n.startsWith('ROBINHOOD')) return null
  const token = n
    .replace(/^ROBINHOOD/, '')
    .replace(/USD$/, '')
    .replace(/[/\-]/g, ' ')
    .trim()
    .split(/\s+/)[0]
  return token ? token : null
}

export function pricedSymbols(feeds: Array<{ name?: string }>): string[] {
  const out = new Set<string>()
  for (const f of feeds) {
    const t = tickerOfFeed(f.name)
    if (t) out.add(t)
  }
  return [...out].sort()
}

/**
 * The directory changes when Chainlink adds a feed, not per sweep, so an hour of reuse is enough.
 * A failure returns `ok: false` and the page says it could not list them, rather than an empty
 * list that would read as "nothing is priced".
 */
export async function loadPricedSymbols(): Promise<{ ok: boolean; symbols: string[] }> {
  try {
    const res = await fetch(CHAINLINK_FEEDS_URL, {
      next: { revalidate: 3600 },
      signal: AbortSignal.timeout(4000),
    })
    if (!res.ok) return { ok: false, symbols: [] }
    const feeds = (await res.json()) as unknown
    if (!Array.isArray(feeds)) return { ok: false, symbols: [] }
    const symbols = pricedSymbols(feeds as Array<{ name?: string }>)
    return symbols.length ? { ok: true, symbols } : { ok: false, symbols: [] }
  } catch {
    return { ok: false, symbols: [] }
  }
}
