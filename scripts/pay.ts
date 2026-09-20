import 'dotenv/config'
import { PlatformClient } from '@openserv-labs/client'
import { privateKeyToAccount } from 'viem/accounts'
import { createPublicClient, http, erc20Abi, formatUnits } from 'viem'
import { base } from 'viem/chains'
import { readFileSync } from 'node:fs'

/**
 * Wallet B buys one true_position call from the ASSAY workflow over x402.
 *
 * Two things the SDK will NOT do for you, both verified in its source:
 *  - payWorkflow() enforces a hard, non-overridable maxValue of $0.10 and throws
 *    client-side before any network call if the price exceeds it.
 *  - payWorkflow() returns txHash: "" and price: "" — they are hardcoded empty strings.
 *    Settlement must therefore be proven against the chain; see scripts/prove-settlement.ts.
 */
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as const

const buyerKey = process.env.BUYER_PRIVATE_KEY
if (!buyerKey) throw new Error('BUYER_PRIVATE_KEY missing — run scripts/make-buyer.ts')
const buyer = privateKeyToAccount(buyerKey as `0x${string}`)

const state = JSON.parse(readFileSync('.openserv.json', 'utf8')) as {
  workflows?: Array<{ id: number; triggerToken?: string }>
}
const wf = state.workflows?.[0]
if (!wf) throw new Error('no workflow in .openserv.json — run scripts/provision.ts')

const pub = createPublicClient({ chain: base, transport: http() })
const bal = await pub.readContract({
  address: USDC,
  abi: erc20Abi,
  functionName: 'balanceOf',
  args: [buyer.address],
})
console.log(`buyer ${buyer.address}`)
console.log(`USDC balance: ${formatUnits(bal, 6)}`)
if (bal < 10_000n) {
  console.error(`\nInsufficient USDC. Need at least 0.01 USDC (10000 atomic). Fund ${buyer.address} on Base.`)
  process.exit(1)
}

const client = new PlatformClient()
const before = Date.now()
const res = await client.payments.payWorkflow({
  workflowId: wf.id,
  privateKey: buyerKey,
  input: { symbol: 'CRWD', holder: '0x8366a39CC670B4001A1121B8F6A443A643e40951' },
  network: 'base',
})
console.log(`\npaid in ${Date.now() - before}ms`)
console.log('success:', res.success, '| chainId:', res.chainId)
console.log('note: txHash/price come back empty by design — prove settlement on-chain instead')
console.log('\n--- workflow response ---')
console.log(typeof res.response === 'string' ? res.response : JSON.stringify(res.response, null, 2))

const after = await pub.readContract({
  address: USDC,
  abi: erc20Abi,
  functionName: 'balanceOf',
  args: [buyer.address],
})
console.log(`\nUSDC balance after: ${formatUnits(after, 6)}  (spent ${formatUnits(bal - after, 6)})`)
