import 'dotenv/config'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { readEnv, appendEnvSecret, assertEnvPrivate, backupEnv, ENV_PATH } from '../src/lib/envfile.js'

/**
 * Wallet B — the buyer agent.
 *
 * Deliberately a SEPARATE key from the service owner so the settled x402 payment has a
 * genuinely distinct payer address on-chain. Needs USDC only: x402 settles via an EIP-3009
 * signed authorization and a relayer submits the transaction, so the buyer never pays gas.
 */
assertEnvPrivate()

const env = readEnv()
const existing = env.BUYER_PRIVATE_KEY?.trim()

let key: string
if (existing) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(existing)) {
    console.error(
      `BUYER_PRIVATE_KEY exists in ${ENV_PATH} but is not a 32-byte hex key. Fix or remove it by ` +
        `hand — generating another one here would append a second assignment, and dotenv takes ` +
        `the last, which would strand whatever is funded.`,
    )
    process.exit(1)
  }
  key = existing
  console.log(`reusing the existing buyer wallet from ${ENV_PATH}`)
  // appendEnvSecret backs up on every write, but a reused key is never written, so a backup taken
  // before it existed never gains it. That was the state found in audit: the buyer key in .env and
  // nowhere else. Re-running this puts it in ~/.assay without touching .env.
  console.log(`backup: ${backupEnv() ?? 'FAILED — save this key yourself'}`)
} else {
  key = generatePrivateKey()
  appendEnvSecret('BUYER_PRIVATE_KEY', key)
  console.log(`generated a new buyer wallet and saved it to ${ENV_PATH} (mode 600)`)
}

console.log('\n=== WALLET B (buyer agent) — fund with ~$0.50 USDC on Base 8453 ===')
console.log(privateKeyToAccount(key as `0x${string}`).address)
console.log('\nNo ETH needed: x402 uses an EIP-3009 signature and a relayer pays the gas.')
console.log('USDC on Base: 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 (6 decimals)')
