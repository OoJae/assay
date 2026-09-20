import { defineChain, createPublicClient, http } from 'viem'

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

export const rhClient = createPublicClient({ chain: robinhoodChain, transport: http() })
export const bscClient = createPublicClient({ chain: bsc, transport: http() })
export const avaxClient = createPublicClient({ chain: avalanche, transport: http() })
