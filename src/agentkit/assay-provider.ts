import { ActionProvider, CreateAction, type Network } from '@coinbase/agentkit'
import { z } from 'zod'
import { truePosition } from '../lib/position.js'
import { sweep } from '../sweep/detect.js'

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

/**
 * ASSAY as a Coinbase AgentKit action provider.
 *
 * Why this exists: an AgentKit agent holds a wallet and takes onchain actions. If it touches a
 * Robinhood Chain Stock Token, it is exposed to ERC-8056 — a corporate action moves
 * uiMultiplier(), not balances — and to Chainlink feeds that keep returning a price long after
 * they go stale. These actions give that agent the corrected number and an explicit refusal
 * BEFORE it signs anything.
 *
 * Deliberately READ-ONLY. ASSAY audits; it has no control path over the agent that calls it and
 * never moves capital. `supportsNetwork` returns true everywhere because these are pure reads
 * against Robinhood Chain regardless of which network the calling agent's wallet is on — an
 * agent on Base can perfectly well hold a position on 4663.
 */
export class AssayActionProvider extends ActionProvider {
  constructor() {
    super('assay', [])
  }

  @CreateAction({
    name: 'true_position',
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
`,
    schema: TruePositionSchema,
  })
  async trueUsdPosition(args: z.infer<typeof TruePositionSchema>): Promise<string> {
    const p = await truePosition(args.symbol, args.holder as `0x${string}`)
    return JSON.stringify(p, null, 2)
  }

  @CreateAction({
    name: 'check_symbol',
    description: `
Run a fresh valuation-integrity sweep for one Robinhood Chain Stock Token at the current block and
return the verified findings. Every citation is re-fetched from chain state and byte-compared
before it is returned; anything that does not reproduce is never published.

Use this to decide whether an asset is safe to price before taking a position in it.
`,
    schema: CheckSymbolSchema,
  })
  async checkSymbol(args: z.infer<typeof CheckSymbolSchema>): Promise<string> {
    const r = await sweep({ symbols: [args.symbol] })
    return JSON.stringify(
      {
        block: r.blockNumber,
        observedAt: r.observedAt,
        marketClosed: r.marketClosed,
        published: r.findings.length,
        rejected: r.rejected.length,
        findings: r.findings.map((f) => ({
          severity: f.severity,
          defectClass: f.defectClass,
          title: f.title,
          impact: f.impact,
          citationsVerified: `${f.verification.reproduced}/${f.verification.checked}`,
        })),
      },
      null,
      2,
    )
  }

  supportsNetwork = (_network: Network): boolean => true
}

export const assayActionProvider = () => new AssayActionProvider()
