import 'dotenv/config'
import { run } from '@openserv-labs/sdk'
import { assayAgent } from '../src/agent/assay-agent.js'

/**
 * Always-on agent runtime, for a VPS.
 *
 * DELIBERATELY MINIMAL PRIVILEGE. This does NOT call provision(), because provision() needs
 * WALLET_PRIVATE_KEY — the key that owns the ERC-8004 identity and receives every x402 payment.
 * Putting that on an internet-facing box to answer read-only queries would be a poor trade.
 *
 * It also needs no SERV_API_KEY: the two capabilities this agent serves (true_position,
 * check_symbol) are pure Robinhood Chain reads. The SERV adjudicator runs offline, in the
 * research harness, not in the paid request path.
 *
 * So the VPS holds only the agent's own scoped credentials, which can receive and answer tasks
 * and nothing else. If the box is compromised the attacker can serve audit answers; they cannot
 * move funds, cannot touch the identity NFT, and cannot spend inference credits.
 *
 * Required env:
 *   OPENSERV_API_KEY     agent API key   (.openserv.json -> agents.assay.apiKey)
 *   OPENSERV_AUTH_TOKEN  agent authToken (.openserv.json -> agents.assay.authToken)
 */
const apiKey = process.env.OPENSERV_API_KEY
const authToken = process.env.OPENSERV_AUTH_TOKEN
if (!apiKey || !authToken) {
  console.error('OPENSERV_API_KEY and OPENSERV_AUTH_TOKEN are required')
  process.exit(1)
}

for (const leaked of ['WALLET_PRIVATE_KEY', 'BUYER_PRIVATE_KEY']) {
  if (process.env[leaked]) {
    console.warn(
      `WARNING: ${leaked} is set in this environment. The remote runtime does not need it — ` +
        `remove it so a compromise of this host cannot reach funds or the agent identity.`,
    )
  }
}

assayAgent.setCredentials({ apiKey, authToken })

console.log('ASSAY agent starting (read-only capabilities, no wallet key present)')
await run(assayAgent)
