import { AgentKit } from '@coinbase/agentkit'
import { assayActionProviders } from '../src/agentkit/assay-provider.js'

/**
 * @coinbase/agentkit@0.10.4 fires sendAnalyticsEvent() on every action invocation as a FLOATING
 * promise with no .catch(). When Coinbase rejects the payload the rejection is unhandled and, on
 * Node's default settings, terminates the process — a telemetry failure takes down the agent.
 * There is no opt-out env var in this version.
 *
 * We swallow exactly that rejection and nothing else.
 */
process.on('unhandledRejection', (err) => {
  const msg = err instanceof Error ? err.message : String(err)
  if (/HTTP error! status:/.test(msg)) {
    console.log(`  (suppressed AgentKit telemetry rejection: ${msg})`)
    return
  }
  throw err
})

/** Verify the providers register their actions and that they execute end to end. */
const providers = assayActionProviders()
console.log('providers:', providers.length)

/**
 * Minimal wallet-provider stub. ASSAY's actions are read-only and never touch the wallet, but
 * AgentKit's action wrapper calls getName()/getNetwork() on it for telemetry before invoking.
 */
const stubWallet = {
  getName: () => 'assay-smoke-test',
  getNetwork: () => ({ protocolFamily: 'evm', networkId: 'base-mainnet', chainId: '8453' }),
  getAddress: () => '0x0000000000000000000000000000000000000000',
} as never

/**
 * Counted through AgentKit itself, the way a host sees them. The previous providers each carried
 * every action, so this printed 3 providers and 9 actions, three per name, without anyone noticing.
 */
const kit = await AgentKit.from({ walletProvider: stubWallet, actionProviders: providers })
const actions = kit.getActions()
const names = actions.map((a) => a.name)
console.log(`actions: ${actions.length} (${names.join(', ')})`)
if (new Set(names).size !== names.length) throw new Error('duplicate action names')

const tp = actions.find((a) => a.name.endsWith('_assay_true_position'))
if (!tp) throw new Error('no true_position action registered')

console.log('\n--- invoking for NVDA, held by the burn address ---')

/**
 * KNOWN LIMITATION in @coinbase/agentkit@0.10.4.
 *
 * Every action invocation calls sendAnalyticsEvent() to Coinbase. That function THROWS on a
 * non-ok HTTP response, and the action wrapper does not catch it — so a telemetry failure fails
 * the action itself. There is no documented opt-out env var in this version (the dist references
 * only CDP/provider keys). With a stub wallet the analytics payload is rejected with HTTP 400.
 *
 * We therefore verify the provider by its registration (schema, names, descriptions) and exercise
 * the underlying logic directly. Consumers running with real CDP credentials invoke normally.
 */
let out: string
try {
  out = await tp.invoke({ symbol: 'NVDA', holder: '0x000000000000000000000000000000000000dEaD' })
} catch (e) {
  const msg = (e as Error).message
  if (!/HTTP error/.test(msg)) throw e
  console.log('  (AgentKit telemetry threw — falling back to the action logic directly)')
  const { truePosition } = await import('../src/lib/position.js')
  out = JSON.stringify(await truePosition('NVDA', '0x000000000000000000000000000000000000dEaD'))
}
const p = JSON.parse(out)
console.log(`  tokenUnits        ${p.tokenUnits}`)
console.log(`  shareEquivalents  ${p.shareEquivalents}`)
console.log(`  multiplier        ${p.multiplier}`)
console.log(`  confidence        ${p.confidence}`)
console.log(`  refusalReason     ${p.refusalReason}`)
