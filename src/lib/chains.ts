import { defineChain, createPublicClient, http, fallback, type Transport } from 'viem'

/** Robinhood Chain mainnet — Arbitrum Orbit rollup. Verified live: eth_chainId -> 0x1237 (4663). */
export const robinhoodChain = defineChain({
  id: 4663,
  name: 'Robinhood Chain',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: ['https://rpc.mainnet.chain.robinhood.com'] } },
  blockExplorers: {
    default: { name: 'Blockscout', url: 'https://robinhoodchain.blockscout.com' },
  },
})

/** Robinhood Chain testnet. Verified live: eth_chainId -> 0xb626 (46630). */
export const robinhoodTestnet = defineChain({
  id: 46630,
  name: 'Robinhood Chain Testnet',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: ['https://rpc.testnet.chain.robinhood.com'] } },
  blockExplorers: {
    default: { name: 'Blockscout', url: 'https://explorer.testnet.chain.robinhood.com' },
  },
})

export const bsc = defineChain({
  id: 56,
  name: 'BNB Smart Chain',
  nativeCurrency: { name: 'BNB', symbol: 'BNB', decimals: 18 },
  rpcUrls: { default: { http: ['https://bsc-dataseed.bnbchain.org'] } },
  blockExplorers: { default: { name: 'BscScan', url: 'https://bscscan.com' } },
})

export const avalanche = defineChain({
  id: 43114,
  name: 'Avalanche C-Chain',
  nativeCurrency: { name: 'AVAX', symbol: 'AVAX', decimals: 18 },
  rpcUrls: { default: { http: ['https://api.avax.network/ext/bc/C/rpc'] } },
  blockExplorers: { default: { name: 'Snowtrace', url: 'https://snowtrace.io' } },
})

/**
 * Where reads go when the public RPC will not answer.
 *
 * The public endpoint sits behind Cloudflare, and about three times a day it serves the whole host
 * a "Just a moment..." challenge (HTTP 403) for several minutes. Every paid call in that window
 * failed, and the sweep refused its board. No retry on the SAME endpoint outlasts a multi-minute
 * episode inside x402's 60s window, so the fix is a second endpoint, not a slower retry.
 *
 * Checked 2026-09-23 from chainlist's entries for 4663: each answers eth_chainId with 0x1237,
 * serves state 200,000 blocks deep, and tracked the official head within a few blocks. publicnode
 * was dropped because it refuses state older than ~100 blocks without a token, which a pinned
 * sweep block outlives; bloXroute was dropped because chainlist lists it as tracking.
 */
export const RH_RPC_URL = robinhoodChain.rpcUrls.default.http[0]
export const RH_RPC_FALLBACK_URLS = ['https://robinhood.drpc.org', 'https://robinhood.api.pocket.network']

/**
 * Per endpoint: one retry 300ms later, 6s per attempt.
 *
 * A Cloudflare 403 comes back in ~0.3s, so moving on to the next endpoint costs about a second. A
 * hung endpoint costs 6 + 0.3 + 6 = ~12.3s before the next one is tried. viem's default (3 retries,
 * 10s each) spent 40s on one dead endpoint, and on a 403 it spent ~1.5s and then gave up.
 */
const RH_HTTP = { retryCount: 1, retryDelay: 300, timeout: 6_000 } as const

/**
 * Faults that are the same on every node, so moving to the next endpoint only repeats them.
 *
 * The pruning phrases matter most. Citation retention is measured against the PUBLIC RPC (the
 * same patterns as isPrunedError in verify/index.ts), and both fallbacks are archive nodes. If a
 * pruned read fell through, the verifier would quietly re-fetch a citation that no reader of the
 * public RPC can reproduce, and "unverifiable here" would stop meaning what it says.
 */
function sameOnEveryNode(err: Error): boolean {
  return /execution reverted|historical state|missing trie node|state not available/i.test(err.message)
}

export function robinhoodTransport(urls: string[] = [RH_RPC_URL, ...RH_RPC_FALLBACK_URLS]): Transport {
  return fallback(
    urls.map((u) => http(u, RH_HTTP)),
    // Official first, always. retryCount 0 because each endpoint already retries once; left at
    // viem's default of 3, the whole chain of endpoints would be walked four times.
    { rank: false, retryCount: 0, shouldThrow: sameOnEveryNode },
  )
}

export const rhClient = createPublicClient({ chain: robinhoodChain, transport: robinhoodTransport() })
export const bscClient = createPublicClient({ chain: bsc, transport: http() })
export const avaxClient = createPublicClient({ chain: avalanche, transport: http() })
