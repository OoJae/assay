import 'dotenv/config'
import * as dotenv from 'dotenv'
import { PlatformClient } from '@openserv-labs/client'
import { privateKeyToAccount } from 'viem/accounts'
import { createPublicClient, http, formatEther } from 'viem'
import { base } from 'viem/chains'
import { existsSync, readFileSync } from 'node:fs'

/**
 * STALE. Refuses unless --force-stale-path is passed. `pnpm mint` (scripts/mint-8004.ts) is the
 * mint path, and data/erc8004.json records the canonical identity it produced.
 *
 * Why this still exists but refuses: it is a SECOND mint path with no idempotence guard. It hands
 * the first provisioned workflow to registerOnChain(), which mints a NEW identity when the platform
 * wallet has no agent id, and otherwise calls setAgentURI to a platform-generated IPFS card that
 * carries none of the canonical/frozen/duplicate disclosures. A duplicate identity already came
 * from one accidental re-run of a mint; a command named `register` looks harmless enough to be the
 * next one. Kept, not deleted, because package.json still names it.
 *
 * What follows is the original description.
 *
 * Mint ASSAY's ERC-8004 identity on Base mainnet (8453).
 *
 * registerOnChain() calls register(string agentURI) on the IdentityRegistry at
 * 0x8004A169FB4a3325136EB29fA0ceB6D2e539a432, after pinning an agent card to IPFS.
 *
 * Two things that matter:
 *  - The NFT is minted by THIS private key, while the agent card advertises the platform
 *    workspace wallet. Keep them the same key, or later setAgentURI calls revert "Not authorized".
 *  - An unchanged re-run is a free no-op: if the card serialises identically to what is already
 *    on IPFS, it returns early with an empty txHash and sends no transaction.
 */
dotenv.config({ override: true })

if (!process.argv.includes('--force-stale-path')) {
  const canonical = existsSync('data/erc8004.json')
    ? (JSON.parse(readFileSync('data/erc8004.json', 'utf8')) as { agentId?: string }).agentId
    : undefined
  console.error('register-8004 is a stale second mint path and refuses by default.')
  console.error(canonical ? `The canonical identity is 8453:${canonical} (data/erc8004.json).` : 'No identity is recorded in data/erc8004.json.')
  console.error('It could mint another identity, or repoint the agent URI to a card without the')
  console.error('frozen/duplicate disclosures. Use `pnpm mint` instead; it refuses to mint twice.')
  console.error('\nIf you really mean this path: pass --force-stale-path.')
  process.exit(1)
}
if (existsSync('data/erc8004.json')) {
  console.error('WARNING: data/erc8004.json already records an identity; this path does not update it.\n')
}

const pk = process.env.WALLET_PRIVATE_KEY
if (!pk) throw new Error('WALLET_PRIVATE_KEY missing — run pnpm provision first')
const account = privateKeyToAccount(pk as `0x${string}`)

interface WorkflowEntry {
  workspaceId: number
  triggerId?: string
  triggerToken?: string
}
const state = JSON.parse(readFileSync('.openserv.json', 'utf8')) as {
  workflows?: Record<string, Record<string, WorkflowEntry>>
  userApiKey?: string
}
const wf = Object.values(state.workflows ?? {})
  .flatMap((byName) => Object.values(byName))
  .find((w) => w.triggerToken)
if (!wf) throw new Error('no provisioned workflow — run pnpm provision')

const pub = createPublicClient({ chain: base, transport: http() })
const bal = await pub.getBalance({ address: account.address })
console.log(`signer  ${account.address}`)
console.log(`balance ${formatEther(bal)} ETH on Base`)
if (bal === 0n) {
  console.error('\nsigner has no ETH — fund it before minting')
  process.exit(1)
}

const client = new PlatformClient({ apiKey: state.userApiKey })

console.log(`\nminting ERC-8004 identity for workflow ${wf.workspaceId}…`)
const res = await client.erc8004.registerOnChain({
  workflowId: wf.workspaceId,
  privateKey: pk,
  name: 'ASSAY Valuation Integrity',
  description:
    'Independent valuation-integrity audit for agents on Robinhood Chain. Detects ERC-8056 ' +
    'corporate-action multiplier defects, missing and stale Chainlink feeds, and cross-surface ' +
    'price mixing. Every published citation is re-fetched from chain state and byte-compared.',
})

console.log('\n=== REGISTERED ===')
console.log('agentId      ', res.agentId)
console.log('ipfsCid      ', res.ipfsCid)
console.log('txHash       ', res.txHash || '(no transaction — agent card unchanged)')
console.log('agentCard    ', res.agentCardUrl)
console.log('explorer     ', res.blockExplorerUrl)
console.log('8004scan     ', res.scanUrl)
