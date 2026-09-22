import 'dotenv/config'
import * as dotenv from 'dotenv'
import { privateKeyToAccount } from 'viem/accounts'
import { createPublicClient, http, erc20Abi, formatUnits } from 'viem'
import { base } from 'viem/chains'
import { readFileSync } from 'node:fs'
// Deep import: the SDK vendors an x402 client but does not re-export it. The package has no
// `exports` map, so the path is reachable, and this is the same code payWorkflow() uses.
import { createSigner, wrapFetchWithPayment } from '@openserv-labs/client/dist/x402.js'

/**
 * Buy one named contract audit ($0.25) over x402.
 *
 * WHY NOT payWorkflow(). It calls wrapFetchWithPayment WITHOUT a maxValue, so it inherits the
 * default ceiling of 100000 atomic USDC — $0.10 — and throws client-side before any network call
 * on anything priced above that. That is a DEFAULT of the convenience wrapper, not a limit of the
 * protocol or the platform: the same vendored client accepts an explicit ceiling.
 *
 * THE CEILING IS SET TO EXACTLY THE TIER PRICE, read from the live 402 challenge and checked
 * against what this script expects. A client that will sign "up to" some generous amount is how a
 * repriced endpoint drains a wallet; this one signs the known price or nothing.
 *
 *   pnpm pay:contract [address]
 */
dotenv.config({ override: true })

const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as const
const EXPECTED_ATOMIC = 250_000n // $0.25

const buyerKey = process.env.BUYER_PRIVATE_KEY as `0x${string}` | undefined
if (!buyerKey) throw new Error('BUYER_PRIVATE_KEY missing — run pnpm wallets')
const buyer = privateKeyToAccount(buyerKey)

const st = JSON.parse(readFileSync('.openserv.json', 'utf8')) as {
  workflows: Record<string, Record<string, { triggerToken?: string }>>
}
const token = st.workflows.assay?.['ASSAY Contract Audit']?.triggerToken
if (!token) throw new Error('no ASSAY Contract Audit workflow — run scripts/provision-contract-audit.ts')
const url = `https://api.openserv.ai/webhooks/x402/trigger/${token}`

const target = (process.argv[2] ?? '0xfab520051f96f4d2a32c22b6a3dd7fffdf231bfe') as `0x${string}`
const body = JSON.stringify({ buyerAddress: buyer.address, payload: { address: target } })

// --- read the price BEFORE signing anything ---
const probe = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body })
if (probe.status !== 402) throw new Error(`expected a 402 challenge, got HTTP ${probe.status}`)
const challenge = (await probe.json()) as { accepts?: Array<{ maxAmountRequired: string; payTo: string; asset: string }> }
const req = challenge.accepts?.[0]
if (!req) throw new Error('402 challenge carried no payment requirements')
const price = BigInt(req.maxAmountRequired)

if (price !== EXPECTED_ATOMIC) {
  console.error(`REFUSING: the endpoint asks for ${formatUnits(price, 6)} USDC, this script expects ${formatUnits(EXPECTED_ATOMIC, 6)}.`)
  process.exit(1)
}
if (req.asset.toLowerCase() !== USDC.toLowerCase()) {
  console.error(`REFUSING: the endpoint asks for asset ${req.asset}, not Base USDC.`)
  process.exit(1)
}

const pub = createPublicClient({ chain: base, transport: http() })
const readBal = () => pub.readContract({ address: USDC, abi: erc20Abi, functionName: 'balanceOf', args: [buyer.address] })
const before = await readBal()

console.log(`buyer    ${buyer.address}`)
console.log(`balance  ${formatUnits(before, 6)} USDC`)
console.log(`price    ${formatUnits(price, 6)} USDC -> ${req.payTo}`)
console.log(`target   ${target}`)
if (before < price) throw new Error('insufficient USDC for this call')

const signer = createSigner('base', buyerKey)
const paidFetch = wrapFetchWithPayment(fetch, signer as never, price)

const t0 = Date.now()
const res = await paidFetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body })
const text = await res.text()
console.log(`\nHTTP ${res.status} in ${Date.now() - t0}ms`)

let out: { settleTxHash?: string; output?: { value?: string }; status?: string } = {}
try { out = JSON.parse(text) } catch { /* not JSON */ }
if (out.settleTxHash) console.log(`settled  https://basescan.org/tx/${out.settleTxHash}`)
console.log(`status   ${out.status ?? '(none)'}`)

const value = out.output?.value
if (value) {
  try {
    const r = JSON.parse(value) as { verdict?: string; conclusive?: boolean; holdings?: unknown[]; totalUsdHeld?: number; interpretation?: string }
    console.log(`\n--- the answer ---`)
    console.log(`verdict     ${r.verdict}  (conclusive: ${r.conclusive})`)
    console.log(`holdings    ${r.holdings?.length ?? 0} divergent token(s), $${Math.round(r.totalUsdHeld ?? 0).toLocaleString()} held`)
    console.log(`meaning     ${r.interpretation?.slice(0, 160)}…`)
  } catch {
    console.log(`\n${value.slice(0, 600)}`)
  }
} else {
  console.log(text.slice(0, 600))
}

const after = await readBal()
console.log(`\nbalance  ${formatUnits(after, 6)} USDC (spent ${formatUnits(before - after, 6)})`)
