import { customActionProvider, type WalletProvider } from '@coinbase/agentkit'
import { z } from 'zod3'
import { truePositionFor, checkSymbolSummary, auditContract } from '../lib/surface.js'

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
 * ── Two implementation notes, both forced by the toolchain ──
 *
 * 1. `customActionProvider` rather than the `@CreateAction` decorator. AgentKit's decorator reads
 *    `design:paramtypes`, which requires `emitDecoratorMetadata` — and esbuild (which tsx uses)
 *    does not implement it at all. Under tsx the decorator throws
 *    "Failed to get parameters for action method". The functional API has no such dependency.
 *
 * 2. `zod3`, an alias for zod@3. @coinbase/agentkit@0.10.4 types its schemas against zod v3 while
 *    this project is on v4; the zod-v4 upgrade only lands in the unreleased 0.11.0. Aliasing
 *    contains the split to this one file rather than downgrading the whole project.
 */

const TruePositionSchema = z.object({
  symbol: z.string().describe('Robinhood Chain Stock Token ticker, e.g. NVDA, SPY, CRWD'),
  holder: z
    .string()
    .regex(/^0x[a-fA-F0-9]{40}$/)
    .describe('Holder address on Robinhood Chain (4663)'),
})

const CheckSymbolSchema = z.object({
  symbol: z.string().describe('Robinhood Chain Stock Token ticker'),
})

export const assayTruePosition = customActionProvider<WalletProvider>({
  name: 'assay_true_position',
  description: `
Get the CORRECTED position for a holder of a Robinhood Chain Stock Token, plus the oracle-hygiene
checks Robinhood's own documentation requires. Call this before valuing, liquidating or
collateralising a tokenized equity position.

Robinhood Stock Tokens implement ERC-8056: a corporate action moves uiMultiplier(), NOT balances.
So balanceOf() is not a share count, and an off-chain SHARE price is not interchangeable with the
on-chain multiplier-adjusted TOKEN price returned by the Chainlink feed.

Returns raw balance, uiMultiplier, share-equivalents, token price, the derived underlying share
price, the correct position value, feed age against its published heartbeat, oraclePaused(), and a
refusalReason that is non-null when the reading is NOT safe to act on. When refusalReason is set,
do not trade on this position.
`.trim(),
  schema: TruePositionSchema,
  invoke: async (_wallet, args: z.infer<typeof TruePositionSchema>) => {
    const p = await truePositionFor(args.symbol, args.holder as `0x${string}`)
    return JSON.stringify(p, null, 2)
  },
})

export const assayCheckSymbol = customActionProvider<WalletProvider>({
  name: 'assay_check_symbol',
  description: `
Run a fresh valuation-integrity sweep for one Robinhood Chain Stock Token at the current block and
return the verified findings. Every citation is re-fetched from chain state and byte-compared
before it is returned; anything that does not reproduce is never published.

Use this to decide whether an asset is safe to price before taking a position in it.
`.trim(),
  schema: CheckSymbolSchema,
  invoke: async (_wallet, args: z.infer<typeof CheckSymbolSchema>) => {
    return JSON.stringify(await checkSymbolSummary(args.symbol), null, 2)
  },
})

/** Both ASSAY actions, ready to drop into an AgentKit config's `actionProviders`. */
const CheckContractSchema = z.object({
  address: z.string().regex(/^0x[a-fA-F0-9]{40}$/).describe('0x-prefixed address on Robinhood Chain 4663'),
})

export const assayCheckContract = customActionProvider<WalletProvider>({
  name: 'assay_check_contract',
  description: `
Audit a counterparty contract on Robinhood Chain before relying on its share accounting. Returns
whether its bytecode references uiMultiplier() (proxies resolved first), the divergent-multiplier
Stock Tokens it holds, and the share-equivalents unaccounted for. NOT_AWARE means the call cannot
be made, not that a mistake was made. PROXY_UNRESOLVED means no verdict — do not treat it as a pass.
`.trim(),
  schema: CheckContractSchema,
  invoke: async (_wallet, args: z.infer<typeof CheckContractSchema>) => {
    return JSON.stringify(await auditContract(args.address as `0x${string}`), null, 2)
  },
})

export const assayActionProviders = () => [assayTruePosition, assayCheckSymbol, assayCheckContract]
