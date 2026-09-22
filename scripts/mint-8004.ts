import 'dotenv/config'
import * as dotenv from 'dotenv'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
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
/**
 * Resolved against THIS FILE, not the process cwd.
 *
 * The idempotence guard below is the only thing standing between a re-run and a fourth mainnet
 * identity NFT — two already exist because of one accidental re-run. A cwd-relative path means
 * running `tsx assay/scripts/mint-8004.ts` from the parent directory finds no state file,
 * concludes nothing has been minted, and mints. The guard has to be anchored to the repo.
 */
const STATE = join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'erc8004.json')
interface Erc8004State {
  agentId: string
  agentURI: string
  owner: string
  txHash: string
  chainId: number
  duplicates?: string[]
  note?: string
}
const previous: Erc8004State | null = existsSync(STATE)
  ? (JSON.parse(readFileSync(STATE, 'utf8')) as Erc8004State)
  : null

if (previous && !process.argv.includes('--force')) {
  const prev = previous
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

/**
 * A forced re-mint APPENDS to the duplicate record; it never erases it.
 *
 * The previous version wrote a fresh object, so `--force` silently dropped the `duplicates` and
 * `note` fields — the disclosure that two identities exist and why. Quietly deleting the record
 * of one's own mistake is precisely the behaviour this project grades other people for, and it
 * would have happened on the one code path taken while already knowing about the duplicate.
 */
const duplicates = previous
  ? [...(previous.duplicates ?? []), previous.agentId].filter((id) => id !== agentId.toString())
  : []

writeFileSync(
  STATE,
  JSON.stringify(
    {
      agentId: agentId.toString(),
      agentURI: AGENT_URI,
      owner: account.address,
      txHash: hash,
      chainId: 8453,
      ...(duplicates.length ? { duplicates } : {}),
      ...(previous?.note || duplicates.length
        ? {
            note:
              previous?.note ??
              `${agentId} is canonical. ${duplicates.join(', ')} ${duplicates.length > 1 ? 'were' : 'was'} ` +
                `minted earlier by this script; all are owned by the same wallet and carry the same ` +
                `agentURI. Recorded rather than hidden.`,
          }
        : {}),
    },
    null,
    2,
  ),
)
console.log(`\nrecorded in ${STATE}`)
if (duplicates.length) console.log(`duplicate identities disclosed: ${duplicates.join(', ')}`)
