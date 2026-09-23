import { ActionProvider, CreateAction, type Network, type WalletProvider } from '@coinbase/agentkit'
import { z } from 'zod3'
import { truePositionFor, checkSymbolSummary, auditContract } from '../lib/surface.js'
import { isNamedIntegrator } from '../lib/redact.js'

/**
 * ASSAY as a Coinbase AgentKit action provider.
 *
 * Why this exists: an AgentKit agent holds a wallet and takes onchain actions. If it touches a
 * Robinhood Chain Stock Token it is exposed to ERC-8056 — a corporate action moves
 * uiMultiplier(), not balances — and to Chainlink feeds that keep returning a price long after
 * they pass their heartbeat. These actions give that agent the corrected number and an explicit
 * refusal BEFORE it signs anything.
 *
 * Deliberately READ-ONLY. ASSAY audits; it has no control path over the agent that calls it and
 * never moves capital.
 *
 * ── Three implementation notes, all forced by the toolchain ──
 *
 * 1. No `@CreateAction` decorator syntax. AgentKit's decorator reads `design:paramtypes`, which
 *    requires `emitDecoratorMetadata` — and esbuild (which tsx uses) does not implement it at all.
 *    Under tsx the decorator throws "Failed to get parameters for action method". The metadata is
 *    written by hand below instead, exactly as emitDecoratorMetadata would have.
 *
 * 2. Not `customActionProvider` either, which is what this used before. AgentKit 0.10.4 defines
 *    every custom action on the SHARED CustomActionProvider prototype and records its metadata on
 *    that one class, so each of the three providers this file exported carried all three actions:
 *    AgentKit.getActions() returned 9, three per name, and the Anthropic and OpenAI APIs reject
 *    duplicate tool names. It also leaked the other way, into any customActionProvider the host
 *    defined for its own tools. A class of our own keeps the metadata on our own constructor.
 *
 * 3. `zod3`, an alias for zod@3. @coinbase/agentkit@0.10.4 types its schemas against zod v3 while
 *    this project is on v4; the zod-v4 upgrade only lands in the unreleased 0.11.0. Aliasing
 *    contains the split to this one file rather than downgrading the whole project.
 */
export class AssayActionProvider extends ActionProvider<WalletProvider> {
  constructor() {
    super('assay', [])
  }

  /** Every network: the actions read Robinhood Chain themselves and never touch the wallet. */
  supportsNetwork(_network: Network): boolean {
    return true
  }
}

type Metadata = { defineMetadata(key: string, value: unknown, target: object, property: string): void }

function defineAction<S extends z.ZodTypeAny>(
  name: string,
  description: string,
  schema: S,
  invoke: (args: z.infer<S>) => Promise<string>,
) {
  const descriptor: PropertyDescriptor = {
    value: async function (args: unknown) {
      return invoke(schema.parse(args))
    },
    configurable: true,
    writable: true,
    enumerable: true,
  }
  // One non-wallet parameter, so AgentKit neither passes a wallet nor asks it for telemetry.
  ;(Reflect as unknown as Metadata).defineMetadata('design:paramtypes', [Object], AssayActionProvider.prototype, name)
  CreateAction({ name, description, schema })(AssayActionProvider.prototype, name, descriptor)
  Object.defineProperty(AssayActionProvider.prototype, name, descriptor)
}

const TruePositionSchema = z.object({
  symbol: z.string().describe('Robinhood Chain Stock Token ticker, e.g. NVDA, SPY, CRWD'),
  holder: z
    .string()
    .regex(/^0x[a-fA-F0-9]{40}$/)
    .describe('Holder address on Robinhood Chain (4663)'),
})

defineAction(
  'assay_true_position',
  `
Get the CORRECTED position for a holder of a Robinhood Chain Stock Token, plus the oracle-hygiene
checks Robinhood's own documentation requires. Call this before valuing, liquidating or
collateralising a Stock Token position.

Robinhood Stock Tokens implement ERC-8056: a corporate action moves uiMultiplier(), NOT balances.
So balanceOf() is not a share count, and an off-chain SHARE price is not interchangeable with the
on-chain multiplier-adjusted TOKEN price returned by the Chainlink feed.

Returns raw balance, token decimals, uiMultiplier, share-equivalents, token price, the derived
underlying share price, the correct position value, feed age against its published heartbeat,
oraclePaused(), any scheduled multiplier change with a warning, and a refusalReason that is
non-null when the reading is NOT safe to act on. When refusalReason is set, do not trade on this
position. Every read is taken at the blockNumber it reports.
`.trim(),
  TruePositionSchema,
  async (args) => JSON.stringify(await truePositionFor(args.symbol, args.holder as `0x${string}`), null, 2),
)

const CheckSymbolSchema = z.object({
  symbol: z.string().describe('Robinhood Chain Stock Token ticker'),
})

defineAction(
  'assay_check_symbol',
  `
Run a fresh valuation-integrity sweep for one Robinhood Chain Stock Token at the current block and
return the verified findings. Every citation is re-fetched from chain state and byte-compared
before it is returned; anything that does not reproduce is never published. Findings that name a
third-party contract are withheld; use assay_check_contract for one address.

Use this to decide whether an asset is safe to price before taking a position in it.
`.trim(),
  CheckSymbolSchema,
  async (args) => {
    const s = await checkSymbolSummary(args.symbol)
    // The same rule as every other unpaid surface (lib/redact.ts).
    if (!('findings' in s) || !s.findings) return JSON.stringify(s, null, 2)
    const findings = s.findings.filter((f) => !isNamedIntegrator(f))
    return JSON.stringify({ ...s, published: findings.length, findings }, null, 2)
  },
)

const CheckContractSchema = z.object({
  address: z.string().regex(/^0x[a-fA-F0-9]{40}$/).describe('0x-prefixed address on Robinhood Chain 4663'),
})

defineAction(
  'assay_check_contract',
  `
Audit a counterparty contract on Robinhood Chain before relying on its share accounting. Returns
whether its bytecode references uiMultiplier() (proxies resolved first), the divergent-multiplier
Stock Tokens it holds, and the share-equivalents unaccounted for. NOT_AWARE means the call cannot
be made, not that a mistake was made. NOT_APPLICABLE means a pool, pool manager or custody-type
contract that holds Stock Tokens without valuing them. PROXY_UNRESOLVED means no verdict — do not
treat it as a pass.
`.trim(),
  CheckContractSchema,
  async (args) => JSON.stringify(await auditContract(args.address as `0x${string}`), null, 2),
)

/** One provider carrying all three ASSAY actions, ready for an AgentKit config's `actionProviders`. */
export const assayActionProvider = () => new AssayActionProvider()

/** Kept for existing callers: a list holding the single provider above. */
export const assayActionProviders = () => [assayActionProvider()]
