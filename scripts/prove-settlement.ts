import 'dotenv/config'
import { privateKeyToAccount } from 'viem/accounts'

/**
 * Prove the x402 payment actually settled on Base.
 *
 * payWorkflow() returns an empty txHash, so we ask Blockscout for ERC-20 transfers into the
 * payTo address and match on the buyer address and the exact atomic amount. A settled x402
 * payment shows up as a `transferWithAuthorization` call (EIP-3009), submitted by a relayer
 * rather than by the buyer — which is why the buyer needs no ETH.
 */
const payTo = process.argv[2]
if (!payTo) {
  console.error('usage: tsx scripts/prove-settlement.ts <payToAddress>')
  process.exit(1)
}
const buyerKey = process.env.BUYER_PRIVATE_KEY!
const buyer = privateKeyToAccount(buyerKey as `0x${string}`).address.toLowerCase()

const url = `https://base.blockscout.com/api/v2/addresses/${payTo}/token-transfers?type=ERC-20`
const res = await fetch(url, { headers: { accept: 'application/json' } })
if (!res.ok) throw new Error(`blockscout: HTTP ${res.status}`)
const data = (await res.json()) as {
  items?: Array<{
    transaction_hash: string
    method?: string
    from: { hash: string }
    to: { hash: string }
    total: { value: string; decimals: string }
    timestamp: string
  }>
}

const mine = (data.items ?? []).filter((i) => i.from.hash.toLowerCase() === buyer)
if (!mine.length) {
  console.log(`no settled transfers yet from buyer ${buyer} into ${payTo}`)
  process.exit(0)
}
console.log(`SETTLED PAYMENTS from buyer ${buyer} -> ${payTo}\n`)
for (const i of mine) {
  const amt = Number(i.total.value) / 10 ** Number(i.total.decimals)
  console.log(`  ${i.timestamp}`)
  console.log(`  amount   ${amt} USDC  (${i.total.value} atomic)`)
  console.log(`  method   ${i.method ?? '(unknown)'}`)
  console.log(`  tx       https://basescan.org/tx/${i.transaction_hash}`)
  console.log()
}
