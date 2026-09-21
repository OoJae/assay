import 'dotenv/config'
import * as dotenv from 'dotenv'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { privateKeyToAccount } from 'viem/accounts'
import { createPublicClient, createWalletClient, http, formatEther, parseEventLogs } from 'viem'
import { base } from 'viem/chains'

/**
 * Mint ASSAY's ERC-8004 identity DIRECTLY against the IdentityRegistry.
 *
 * Why not client.erc8004.registerOnChain()? The provisioned workflow carries a PLACEHOLDER
 * erc8004AgentId of 999999918. registerOnChain decides new-mint vs re-deploy from that field, so
 * it takes the re-deploy path and reverts calling tokenURI(999999918) on a token that does not
 * exist. Minting directly sidesteps the stale platform state entirely.
 *
 * The agent card is self-hosted rather than pinned to IPFS through the platform: one less
 * dependency, and the URI resolves to a domain we control and can update.
 *
 * Verified addresses (read on-chain, Base 8453):
 *   IdentityRegistry 0x8004A169FB4a3325136EB29fA0ceB6D2e539a432
 *     name() = "AgentIdentity", symbol() = "AGENT"
 */
dotenv.config({ override: true })

const IDENTITY_REGISTRY = '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432' as const
const AGENT_URI = 'https://assay-steel.vercel.app/agent-card.json'

const abi = [
  {
    type: 'function',
    name: 'register',
    inputs: [{ name: 'agentURI', type: 'string' }],
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'tokenURI',
    inputs: [{ name: 'tokenId', type: 'uint256' }],
    outputs: [{ name: '', type: 'string' }],
    stateMutability: 'view',
  },
  {
    type: 'event',
    name: 'Registered',
    inputs: [
      { indexed: true, name: 'agentId', type: 'uint256' },
      { indexed: false, name: 'agentURI', type: 'string' },
      { indexed: true, name: 'owner', type: 'address' },
    ],
  },
] as const

const pk = process.env.WALLET_PRIVATE_KEY
if (!pk) throw new Error('WALLET_PRIVATE_KEY missing')
const account = privateKeyToAccount(pk as `0x${string}`)

const pub = createPublicClient({ chain: base, transport: http() })
const wallet = createWalletClient({ account, chain: base, transport: http() })

/**
 * IDEMPOTENCE. Minting is irreversible and this script has no way to ask the registry
 * "do I already own an agent for this URI" — there is no owner index. Re-running it once by
 * accident minted a duplicate identity (95265 then 95266). So the canonical id is recorded
 * locally and re-runs refuse unless --force is passed.
 */
const STATE = 'data/erc8004.json'
interface Erc8004State {
  agentId: string
  agentURI: string
  owner: string
  txHash: string
  chainId: number
  duplicates?: string[]
}
if (existsSync(STATE) && !process.argv.includes('--force')) {
  const prev = JSON.parse(readFileSync(STATE, 'utf8')) as Erc8004State
  console.log('already registered — refusing to mint a duplicate\n')
  console.log('agentId  ', `${prev.chainId}:${prev.agentId}`)
  console.log('agentURI ', prev.agentURI)
  console.log('owner    ', prev.owner)
  console.log('tx       ', `https://basescan.org/tx/${prev.txHash}`)
  console.log('8004scan ', `https://www.8004scan.io/agents/base/${prev.agentId}`)
  if (prev.duplicates?.length) console.log('duplicates', prev.duplicates.join(', '))
  console.log('\npass --force to mint anyway')
  process.exit(0)
}

console.log(`signer   ${account.address}`)
console.log(`balance  ${formatEther(await pub.getBalance({ address: account.address }))} ETH`)
console.log(`agentURI ${AGENT_URI}`)

// Confirm the card actually resolves before committing it on-chain forever.
const probe = await fetch(AGENT_URI)
if (!probe.ok) throw new Error(`agent card is not reachable: HTTP ${probe.status}`)
const card = (await probe.json()) as { name?: string; type?: string }
console.log(`card ok  "${card.name}"\n`)

const gas = await pub.estimateContractGas({
  address: IDENTITY_REGISTRY,
  abi,
  functionName: 'register',
  args: [AGENT_URI],
  account,
})
console.log(`estimated gas ${gas}`)

const hash = await wallet.writeContract({
  address: IDENTITY_REGISTRY,
  abi,
  functionName: 'register',
  args: [AGENT_URI],
})
console.log(`tx ${hash}\nwaiting for confirmation…`)

const receipt = await pub.waitForTransactionReceipt({ hash })
console.log(`status ${receipt.status} in block ${receipt.blockNumber}, gas used ${receipt.gasUsed}`)

const logs = parseEventLogs({ abi, logs: receipt.logs, eventName: 'Registered' })
const agentId = logs[0]?.args?.agentId
if (agentId === undefined) throw new Error('could not decode the Registered event')

console.log('\n=== REGISTERED ===')
console.log('agentId    ', `8453:${agentId}`)
console.log('tx         ', `https://basescan.org/tx/${hash}`)
console.log('8004scan   ', `https://www.8004scan.io/agents/base/${agentId}`)

// Read back with retries: the node can lag the receipt, which made an earlier run look like it
// had failed when the mint had in fact succeeded.
let uri = ''
for (let i = 0; i < 5; i++) {
  try {
    uri = (await pub.readContract({
      address: IDENTITY_REGISTRY,
      abi,
      functionName: 'tokenURI',
      args: [agentId],
    })) as string
    break
  } catch {
    await new Promise((r) => setTimeout(r, 1500 * (i + 1)))
  }
}
console.log('tokenURI   ', uri || '(not yet readable — state lag, retry shortly)')

writeFileSync(
  STATE,
  JSON.stringify(
    { agentId: agentId.toString(), agentURI: AGENT_URI, owner: account.address, txHash: hash, chainId: 8453 },
    null,
    2,
  ),
)
console.log(`\nrecorded in ${STATE}`)
