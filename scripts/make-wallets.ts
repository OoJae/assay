import 'dotenv/config'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import {
  readEnv,
  appendEnvSecret,
  assertEnvPrivate,
  backupEnv,
  populatedSecretCount,
  ENV_PATH,
  ENV_BACKUP_PATH,
} from '../src/lib/envfile.js'

/**
 * Generate the signing wallets, once, safely.
 *
 * Replaces the pair lost when `.env` was overwritten with a copy of `.env.example`. Every write
 * goes through appendEnvSecret, which now refuses any change that would reduce the number of
 * populated secrets and mirrors the result outside the working tree — the guard that did not
 * exist when the originals were destroyed.
 *
 *   WALLET_PRIVATE_KEY  service owner. Deploys ERC8056Guard on chain 4663, mints the ERC-8004
 *                       identity on Base 8453, and receives x402 payments.
 *   BUYER_PRIVATE_KEY   the counterparty, so a settled payment has a genuinely distinct payer.
 *                       Needs USDC only: x402 settles by EIP-3009 signature and a relayer pays gas.
 */
assertEnvPrivate()

const before = populatedSecretCount()
const env = readEnv()
const made: string[] = []

for (const name of ['WALLET_PRIVATE_KEY', 'BUYER_PRIVATE_KEY'] as const) {
  const existing = env[name]?.trim()
  if (existing && /^0x[0-9a-fA-F]{64}$/.test(existing)) {
    console.log(`${name}: already present — ${privateKeyToAccount(existing as `0x${string}`).address}`)
    continue
  }
  appendEnvSecret(name, generatePrivateKey())
  made.push(name)
}

const after = readEnv()
const owner = privateKeyToAccount(after.WALLET_PRIVATE_KEY as `0x${string}`)
const buyer = privateKeyToAccount(after.BUYER_PRIVATE_KEY as `0x${string}`)
const backup = backupEnv()

console.log(`\ngenerated: ${made.length ? made.join(', ') : 'nothing (both already existed)'}`)
console.log(`secrets in ${ENV_PATH}: ${before} -> ${populatedSecretCount()}`)
console.log(`backup: ${backup ?? 'FAILED — save these keys yourself'}`)

console.log('\n=== FUND THESE ===')
console.log(`Wallet A · service owner  ${owner.address}`)
console.log('   Robinhood Chain 4663 : a little native gas, to deploy ERC8056Guard')
console.log('   Base 8453            : ~0.001 ETH, to mint the ERC-8004 identity')
console.log(`Wallet B · buyer agent    ${buyer.address}`)
console.log('   Base 8453            : ~$0.50 USDC. NO ETH needed — a relayer pays the gas.')
console.log(`\nRPC 4663: https://rpc.mainnet.chain.robinhood.com   USDC on Base: 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`)
console.log(`\nThese keys exist in ${ENV_PATH}, ${ENV_BACKUP_PATH}, and a dated copy beside it.`)
console.log('Neither is in git. Copy them somewhere durable now.')
