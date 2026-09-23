import 'dotenv/config'
import * as dotenv from 'dotenv'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { privateKeyToAccount } from 'viem/accounts'
import { createPublicClient, createWalletClient, http, formatEther, parseEventLogs } from 'viem'
import { base } from 'viem/chains'
import { mergeIdentityState, type Erc8004State } from '../src/attest/registry.js'

/**
 * Mint ASSAY's ERC-8004 identity DIRECTLY against the IdentityRegistry.
 *
 * Why not client.erc8004.registerOnChain()? When 95265 was minted the provisioned workflow carried
 * a PLACEHOLDER erc8004AgentId of 999999918. registerOnChain decides new-mint vs re-deploy from
 * that field, so it took the re-deploy path and reverted calling tokenURI(999999918) on a token
 * that does not exist. (By 2026-09-23 the platform reported another project's id, 8453:95396, for
 * nearly every listing.) Minting directly sidesteps the platform state entirely, and
 * registerOnChain must never be pointed at 95374: it would replace the self-hosted card.
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

/**
 * Decided BEFORE the mint, not discovered after it. A new owner freezes the previous identity, and
 * the record must say why; failing that check after an irreversible mint would leave a fourth
 * identity with no record at all.
 */
const frozenReason = process.argv.find((a) => a.startsWith('--frozen-reason='))?.split('=').slice(1).join('=')
if (previous && previous.owner.toLowerCase() !== account.address.toLowerCase() && !frozenReason) {
  console.error(`this key is not the recorded owner (${previous.owner}), so ${previous.agentId} would become FROZEN.`)
  console.error('pass --frozen-reason="…" to record why its key is no longer used.')
  process.exit(1)
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
 * A forced re-mint APPENDS to the record; it never erases it — see mergeIdentityState.
 *
 * The previous version wrote a fresh object, so `--force` silently dropped the `duplicates` and
 * `note` fields — the disclosure that two identities exist and why. Quietly deleting the record
 * of one's own mistake is precisely the behaviour this project grades other people for, and it
 * would have happened on the one code path taken while already knowing about the duplicate.
 */
const next = mergeIdentityState(
  previous,
  { agentId: agentId.toString(), agentURI: AGENT_URI, owner: account.address, txHash: hash },
  frozenReason,
)
writeFileSync(STATE, JSON.stringify(next, null, 2))
console.log(`\nrecorded in ${STATE}`)
if (next.duplicates?.length) console.log(`duplicate identities disclosed: ${next.duplicates.join(', ')}`)
if (next.frozen?.length) console.log(`frozen identities disclosed:    ${next.frozen.map((f) => f.agentId).join(', ')}`)
// The card names the canonical registration; a new canonical id makes it wrong until it is edited.
console.log(`\nNEXT: set registrations[0].agentId and erc8004.canonicalAgentId in web/public/agent-card.json to ${agentId}, then deploy.`)
