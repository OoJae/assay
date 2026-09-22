import { Agent } from '@openserv-labs/sdk'
import { z } from 'zod'
import { truePositionFor, checkSymbolSummary, auditContract } from '../lib/surface.js'

/**
 * The ASSAY agent as exposed on the OpenServ marketplace.
 *
 * It sells exactly one thing at the demo price point: the corrected position for a
 * Robinhood Chain Stock Token, together with the oracle-hygiene flags Robinhood's own
 * docs require and an explicit refusal when the reading is not safe to act on.
 *
 * Note on pricing: `payWorkflow()` in @openserv-labs/client enforces a hard, non-overridable
 * maxValue of $0.10 (it throws client-side before any network call). So the paid line here is
 * $0.01 — cheap enough that an agent can afford to call it before EVERY valuation, which is
 * the point. Higher tiers (evidence packs, monitoring, attestations) are roadmap and would
 * need an x402 client without that cap.
 */
export const assayAgent = new Agent({
  systemPrompt: [
    'You are ASSAY, an independent valuation-integrity service for agents operating on',
    'Robinhood Chain (EIP-155 chain 4663).',
    '',
    'Robinhood Stock Tokens implement ERC-8056 scaled UI amounts: a corporate action moves',
    'uiMultiplier(), not balances. Therefore balanceOf() is NOT a share count, and mixing an',
    'off-chain SHARE price with an on-chain TOKEN quantity produces an error equal to the',
    'multiplier. The Chainlink feed already returns a multiplier-adjusted TOKEN price, so',
    'balanceOf() * feedPrice is correct for token value and the multiplier must NOT be applied',
    'again.',
    '',
    'You never invent a number. Every value you report comes from a tool result. When a tool',
    'returns a refusalReason, you lead with it and you do not soften it: the caller is about to',
    'move money. Report values exactly as returned, including the confidence field.',
  ].join('\n'),
})

assayAgent.addCapability({
  name: 'true_position',
  description:
    'Return the corrected position for a holder of a Robinhood Chain Stock Token: raw balance, ' +
    'uiMultiplier, share-equivalents, the multiplier-adjusted Chainlink token price, the derived ' +
    'underlying share price, the correct position value, oracle-hygiene flags (feed age vs ' +
    'heartbeat, oraclePaused) and an explicit refusalReason when the reading is unsafe to act on.',
  inputSchema: z.object({
    symbol: z.string().describe('Stock Token ticker, e.g. NVDA, SPY, CRWD'),
    holder: z
      .string()
      .regex(/^0x[a-fA-F0-9]{40}$/)
      .describe('Holder address on Robinhood Chain'),
  }),
  async run({ args }) {
    const p = await truePositionFor(args.symbol, args.holder as `0x${string}`)
    return JSON.stringify(p, null, 2)
  },
})

assayAgent.addCapability({
  name: 'check_symbol',
  description:
    'Run a fresh, byte-verified integrity sweep for one Robinhood Chain Stock Token at the ' +
    'current block and return the published findings. Every citation is re-fetched and ' +
    'byte-compared before it is returned.',
  inputSchema: z.object({
    symbol: z.string().describe('Stock Token ticker'),
  }),
  async run({ args }) {
    return JSON.stringify(await checkSymbolSummary(args.symbol), null, 2)
  },
})

assayAgent.addCapability({
  name: 'check_contract',
  description:
    'Audit any address on Robinhood Chain 4663 that holds ERC-8056 Stock Tokens. Returns whether ' +
    'its deployed bytecode references uiMultiplier() — resolving EIP-1967, beacon and EIP-1167 ' +
    'proxies to the implementation before deciding — plus the divergent-multiplier tokens it holds ' +
    'and the share-equivalents unaccounted for if those balances are read as share counts. ' +
    'NOT_AWARE means the call cannot be made from this bytecode, NOT that the contract misvalues ' +
    'anything. An unresolvable proxy returns PROXY_UNRESOLVED and no verdict.',
  inputSchema: z.object({
    address: z
      .string()
      .regex(/^0x[a-fA-F0-9]{40}$/)
      .describe('0x-prefixed address on Robinhood Chain 4663'),
  }),
  async run({ args }) {
    return JSON.stringify(await auditContract(args.address as `0x${string}`), null, 2)
  },
})

