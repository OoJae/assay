import 'dotenv/config'
import * as dotenv from 'dotenv'
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { createWalletClient, createPublicClient, http, formatEther, defineChain } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

/**
 * Deploy ERC8056Guard to Robinhood Chain 4663.
 *
 * The guard is free, ownerless, storage-free and view-only. Deploying it is the only write ASSAY
 * makes to the chain it audits, and it is deliberately a write that gives something away rather
 * than one that takes control: there is no owner, no upgrade path and no privileged caller, so
 * this transaction is the last one anybody ever needs to send to it.
 *
 * IDEMPOTENT. Minting a second copy would fragment the one thing whose value depends on everyone
 * using the same address, so a recorded deployment refuses to redeploy without --force.
 */
dotenv.config({ override: true })

const STATE = 'data/guard.json'
const force = process.argv.includes('--force')

if (existsSync(STATE) && !force) {
  const prev = JSON.parse(readFileSync(STATE, 'utf8')) as { address: string; txHash: string; blockNumber: string }
  console.log('already deployed — refusing to fragment the canonical address\n')
  console.log('address ', prev.address)
  console.log('tx      ', `https://robinhoodchain.blockscout.com/tx/${prev.txHash}`)
  console.log('\npass --force to deploy another copy anyway')
  process.exit(0)
}

const pk = process.env.WALLET_PRIVATE_KEY as `0x${string}` | undefined
if (!pk) throw new Error('WALLET_PRIVATE_KEY missing — run pnpm wallets')
const account = privateKeyToAccount(pk)

const robinhood = defineChain({
  id: 4663,
  name: 'Robinhood Chain',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: ['https://rpc.mainnet.chain.robinhood.com'] } },
  blockExplorers: { default: { name: 'Blockscout', url: 'https://robinhoodchain.blockscout.com' } },
})

// Compile here rather than trusting a checked-in artifact: the bytecode that goes on-chain must
// come from the source in this commit.
console.log('compiling contracts/ERC8056Guard.sol…')
execFileSync('solc', ['--optimize', '--optimize-runs', '200', '--combined-json', 'abi,bin', '--overwrite', '-o', 'build', 'contracts/ERC8056Guard.sol'], { stdio: 'inherit' })
const combined = JSON.parse(readFileSync('build/combined.json', 'utf8')) as {
  contracts: Record<string, { abi: unknown; bin: string }>
}
const entry = combined.contracts['contracts/ERC8056Guard.sol:ERC8056Guard']
if (!entry?.bin) throw new Error('ERC8056Guard did not compile')
const bytecode = `0x${entry.bin}` as `0x${string}`
const abi = (typeof entry.abi === 'string' ? JSON.parse(entry.abi) : entry.abi) as unknown[]
console.log(`  bytecode ${bytecode.length / 2 - 1} bytes`)

const pub = createPublicClient({ chain: robinhood, transport: http() })
const wallet = createWalletClient({ account, chain: robinhood, transport: http() })

const balance = await pub.getBalance({ address: account.address })
console.log(`\ndeployer ${account.address}`)
console.log(`balance  ${formatEther(balance)} ETH on chain 4663`)
if (balance === 0n) {
  console.error('\nno gas on 4663 — fund the deployer before deploying')
  process.exit(1)
}

const hash = await wallet.deployContract({ abi: abi as never, bytecode, args: [] })
console.log(`\ntx ${hash}\nwaiting…`)
const rc = await pub.waitForTransactionReceipt({ hash })
if (rc.status !== 'success' || !rc.contractAddress) {
  console.error(`deployment failed: ${rc.status}`)
  process.exit(1)
}

console.log(`\n=== DEPLOYED ===`)
console.log(`address  ${rc.contractAddress}`)
console.log(`block    ${rc.blockNumber}`)
console.log(`gas used ${rc.gasUsed}`)
console.log(`explorer https://robinhoodchain.blockscout.com/address/${rc.contractAddress}`)

writeFileSync(
  STATE,
  JSON.stringify(
    {
      address: rc.contractAddress,
      chainId: 4663,
      txHash: hash,
      blockNumber: rc.blockNumber.toString(),
      deployer: account.address,
      bytecodeBytes: bytecode.length / 2 - 1,
      note: 'Free, ownerless, storage-free, view-only. No upgrade path — this address is permanent.',
    },
    null,
    2,
  ),
)
console.log(`\nrecorded in ${STATE}`)
