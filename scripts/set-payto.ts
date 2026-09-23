import 'dotenv/config'
import * as dotenv from 'dotenv'
import { PlatformClient } from '@openserv-labs/client'
import { privateKeyToAccount } from 'viem/accounts'
import { readFileSync } from 'node:fs'
import { assertEnvPrivate } from '../src/lib/envfile.js'

/**
 * Point an x402 trigger's payTo at the wallet ASSAY actually controls.
 *
 * WHY THIS EXISTS. The original service-owner key was lost when the local .env was overwritten.
 * The live trigger's `x402WalletAddress` still named that wallet, so every payment to ASSAY —
 * including any from a real customer — was settling into an address nobody can ever spend from.
 * A paid endpoint that silently burns its revenue is worse than one that is offline.
 *
 * Authenticates with the user API key from .openserv.json rather than via provision(), which
 * signs in with WALLET_PRIVATE_KEY: with a new key that would sign in as a DIFFERENT OpenServ
 * account and lose sight of every workflow the original one owns.
 *
 * MERGES props rather than replacing them, so pricing, timeout, input schema and
 * waitForCompletion are carried over untouched.
 *
 *   pnpm payto [triggerId]      (defaults to the provisioned true-position trigger)
 */
dotenv.config({ override: true })
assertEnvPrivate()

const pk = process.env.WALLET_PRIVATE_KEY as `0x${string}` | undefined
if (!pk) throw new Error('WALLET_PRIVATE_KEY missing — run pnpm wallets')
const payTo = privateKeyToAccount(pk).address

const st = JSON.parse(readFileSync('.openserv.json', 'utf8')) as {
  userApiKey: string
  workflows: Record<string, Record<string, { workspaceId: number; triggerId: string }>>
}
const wf = st.workflows.assay!['ASSAY Valuation Integrity']!
const triggerId = process.argv[2] ?? wf.triggerId

const client = new PlatformClient({ apiKey: st.userApiKey })
const before = await client.triggers.get({ workflowId: wf.workspaceId, id: triggerId })
const props = (before.props ?? {}) as Record<string, unknown>
const was = props.x402WalletAddress

console.log(`trigger   ${triggerId} (${before.name})`)
console.log(`price     $${props.x402Pricing}`)
console.log(`payTo was ${was}`)
console.log(`payTo now ${payTo}`)

if (typeof was === 'string' && was.toLowerCase() === payTo.toLowerCase()) {
  console.log('\nalready pointing at the controlled wallet — nothing to do')
  process.exit(0)
}

await client.triggers.update({
  workflowId: wf.workspaceId,
  id: triggerId,
  props: { ...props, x402WalletAddress: payTo },
})

const after = await client.triggers.get({ workflowId: wf.workspaceId, id: triggerId })
const afterProps = (after.props ?? {}) as Record<string, unknown>
const lost = Object.keys(props).filter((k) => k !== 'x402WalletAddress' && !(k in afterProps))
console.log(`\nupdated   x402WalletAddress = ${afterProps.x402WalletAddress}`)
console.log(`carried   ${Object.keys(afterProps).length} props${lost.length ? ` — LOST: ${lost.join(', ')}` : ', none lost'}`)
console.log(`active    ${(after as { is_active?: boolean }).is_active}`)
