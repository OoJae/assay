import 'dotenv/config'
import { run } from '@openserv-labs/sdk'
import { assayAgent } from '../src/agent/assay-agent.js'
import { truePosition } from '../src/lib/position.js'

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

/**
 * ENFORCED, not advised.
 *
 * This used to warn and then carry on, which meant the stated security posture — "the VPS holds
 * only the agent's own scoped credentials" — was a code comment rather than a property of the
 * running system. A key present on an internet-facing box is a key present on an internet-facing
 * box regardless of whether anything logged about it, and the log line would scroll past unread.
 */
const leaked = ['WALLET_PRIVATE_KEY', 'BUYER_PRIVATE_KEY'].filter((k) => process.env[k])
if (leaked.length) {
  console.error(
    `REFUSING TO START: ${leaked.join(', ')} present in this environment.\n` +
      `The remote runtime serves read-only chain queries and does not need any signing key. ` +
      `Remove ${leaked.length > 1 ? 'them' : 'it'} from the unit's environment so a compromise of ` +
      `this host cannot reach funds or the ERC-8004 identity, then restart.`,
  )
  process.exit(1)
}

assayAgent.setCredentials({ apiKey, authToken })

console.log('ASSAY agent starting (read-only capabilities, no wallet key present)')
const { tunnel } = await run(assayAgent)

/**
 * THE FAILURE THIS GUARDS AGAINST, which shipped and was invisible.
 *
 * run() returns a tunnel whose state machine has a TERMINAL 'failed' state: after roughly 151s of
 * backoff and MAX_RETRIES it stops trying and there is no path back to 'connected'. The return
 * value was being discarded, so nothing noticed. Meanwhile the agent's own express listener keeps
 * the event loop alive, so the process stays up, the port stays open, and systemd's
 * Restart=always never fires. Every check reports green.
 *
 * From that moment the agent is unreachable through OpenServ while still advertised as live — and
 * per this project's own comment in serve.ts, "the buyer is charged and the workflow times out
 * with no result." Exiting non-zero is what converts a silent permanent outage into a restart.
 */
const TUNNEL_POLL_MS = 15_000
const TERMINAL: string[] = ['failed', 'stopped']

if (tunnel) {
  let lastState = tunnel.getState()
  console.log(`tunnel state: ${lastState}`)
  const poll = setInterval(() => {
    const state = tunnel.getState()
    if (state !== lastState) {
      console.log(`tunnel state: ${lastState} -> ${state}`)
      lastState = state
    }
    if (TERMINAL.includes(state)) {
      console.error(
        `tunnel reached terminal state '${state}' — it will not reconnect on its own. ` +
          `Exiting so the supervisor restarts a process that can.`,
      )
      clearInterval(poll)
      process.exit(1)
    }
  }, TUNNEL_POLL_MS)
  poll.unref()
} else {
  console.warn('tunnel is disabled (DISABLE_TUNNEL) — no connectivity watchdog is running')
}

/**
 * Liveness that exercises what is actually sold.
 *
 * A port check proves the listener is bound, which was true throughout the outage above. This
 * runs the same read path a paid call runs and requires it to produce a coherent answer, so a
 * wedged RPC client or an upstream that has started timing out shows up as a log line with a
 * timestamp rather than as a buyer's silence.
 */
const HEALTH_EVERY_MS = 5 * 60_000
const HEALTH_SYMBOL = 'NVDA'
const HEALTH_HOLDER = '0x8366a39CC670B4001A1121B8F6A443A643e40951' as const

async function healthProbe() {
  const started = Date.now()
  try {
    const p = await truePosition(HEALTH_SYMBOL, HEALTH_HOLDER)
    const ms = Date.now() - started
    console.log(
      `health ok  ${HEALTH_SYMBOL} block=${p.blockNumber} confidence=${p.confidence} ` +
        `checks=${Object.values(p.checks).filter(Boolean).length}/4 ${ms}ms`,
    )
  } catch (err) {
    console.error(`health FAILED after ${Date.now() - started}ms: ${(err as Error).message}`)
  }
}

void healthProbe()
setInterval(() => void healthProbe(), HEALTH_EVERY_MS).unref()
