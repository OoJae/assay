import 'dotenv/config'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'

/**
 * Wallet B — the buyer agent.
 *
 * Deliberately a SEPARATE key from the service owner so the settled x402 payment has a
 * genuinely distinct payer address on-chain. Needs USDC only: x402 settles via an EIP-3009
 * signed authorization and a relayer submits the transaction, so the buyer never pays gas.
 */
const env = existsSync('.env') ? readFileSync('.env', 'utf8') : ''
let key = /^BUYER_PRIVATE_KEY=(0x[0-9a-fA-F]{64})$/m.exec(env)?.[1]

if (!key) {
  key = generatePrivateKey()
  writeFileSync('.env', `${env.trimEnd()}\nBUYER_PRIVATE_KEY=${key}\n`)
  console.log('generated a new buyer wallet and saved it to .env')
} else {
  console.log('reusing the existing buyer wallet from .env')
}

console.log('\n=== WALLET B (buyer agent) — fund with ~$0.50 USDC on Base 8453 ===')
console.log(privateKeyToAccount(key as `0x${string}`).address)
console.log('\nNo ETH needed: x402 uses an EIP-3009 signature and a relayer pays the gas.')
console.log('USDC on Base: 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 (6 decimals)')
