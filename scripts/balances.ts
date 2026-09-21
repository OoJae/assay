import 'dotenv/config'
import { createPublicClient, http, formatEther, formatUnits, erc20Abi } from 'viem'
import { base } from 'viem/chains'
import { privateKeyToAccount } from 'viem/accounts'
import { readFileSync, existsSync } from 'node:fs'

const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as const

function ownerAddress(): `0x${string}` | null {
  const k = process.env.WALLET_PRIVATE_KEY
  return k ? privateKeyToAccount(k as `0x${string}`).address : null
}
function buyerAddress(): `0x${string}` | null {
  const k = process.env.BUYER_PRIVATE_KEY
  return k ? privateKeyToAccount(k as `0x${string}`).address : null
}

const c = createPublicClient({ chain: base, transport: http() })

async function show(label: string, addr: `0x${string}` | null, need: { eth?: bigint; usdc?: bigint }) {
  if (!addr) return console.log(`${label}: (no key in .env)`)
  const [eth, usdc] = await Promise.all([
    c.getBalance({ address: addr }),
    c.readContract({ address: USDC, abi: erc20Abi, functionName: 'balanceOf', args: [addr] }),
  ])
  const okEth = need.eth === undefined || eth >= need.eth
  const okUsdc = need.usdc === undefined || usdc >= need.usdc
  console.log(`${label}  ${addr}`)
  console.log(`   ETH   ${formatEther(eth).padEnd(12)} ${need.eth !== undefined ? (okEth ? '✓' : `need ${formatEther(need.eth)}`) : ''}`)
  console.log(`   USDC  ${formatUnits(usdc, 6).padEnd(12)} ${need.usdc !== undefined ? (okUsdc ? '✓' : `need ${formatUnits(need.usdc, 6)}`) : ''}`)
  return okEth && okUsdc
}

console.log('Base mainnet (8453)\n')
const a = await show('Wallet A · service owner · ERC-8004 mint gas', ownerAddress(), { eth: 200_000_000_000_000n })
const b = await show('Wallet B · buyer agent · x402 payer (no ETH needed)', buyerAddress(), { usdc: 10_000n })

if (existsSync('.openserv.json')) {
  const s = JSON.parse(readFileSync('.openserv.json', 'utf8')) as {
    workflows?: Array<{ id: number; triggerToken?: string }>
  }
  const wf = s.workflows?.[0]
  if (wf?.triggerToken) {
    console.log(`\npaywall  https://platform.openserv.ai/workspace/paywall/${wf.triggerToken}`)
  }
}
console.log(`\nready to pay: ${b ? 'YES — run pnpm pay' : 'no'}`)
console.log(`ready to mint ERC-8004: ${a ? 'YES' : 'no'}`)
