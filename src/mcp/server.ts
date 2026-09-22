import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { checkSymbol, findingsPayload, truePositionFor } from '../lib/surface.js'
import type { DefectClass } from '../sweep/types.js'

/**
 * ASSAY MCP server.
 *
 * Note on transport: OpenServ's own MCP support is SSE-only (docs: no-code/connect/mcps), so the
 * hosted deployment exposes SSE. This module builds the server; `stdio.ts` and `sse.ts` are the
 * entrypoints. Every answer here comes from lib/surface.ts, which is also what the AgentKit
 * action provider and the OpenServ agent serve — so a buyer can use one endpoint to check another.
 */

export function buildServer(): McpServer {
  const server = new McpServer({ name: 'assay', version: '0.1.0' })

  server.registerTool(
    'assay_true_position',
    {
      title: 'True position for a Robinhood Chain Stock Token',
      description:
        'Return the corrected position for a holder of a Robinhood Chain Stock Token. ' +
        'Robinhood Stock Tokens implement ERC-8056: a corporate action moves uiMultiplier(), not balances, ' +
        'so balanceOf() is NOT a share count. This tool returns raw balance, uiMultiplier, share-equivalents, ' +
        'the multiplier-adjusted Chainlink TOKEN price, the derived underlying SHARE price, the correct position ' +
        'value, oracle-hygiene flags (feed age vs heartbeat, oraclePaused), and an explicit refusalReason when ' +
        'the reading is not safe to act on. Call this before valuing, liquidating or collateralising a Stock Token.',
      inputSchema: {
        symbol: z.string().describe('Stock Token ticker, e.g. NVDA, SPY, CRWD'),
        holder: z.string().regex(/^0x[a-fA-F0-9]{40}$/).describe('Holder address'),
      },
    },
    async ({ symbol, holder }) => {
      const p = await truePositionFor(symbol, holder as `0x${string}`)
      return { content: [{ type: 'text', text: JSON.stringify(p, null, 2) }] }
    },
  )

  server.registerTool(
    'assay_findings',
    {
      title: 'Published valuation-integrity findings',
      description:
        'List verified findings from the latest ASSAY sweep of Robinhood Chain. Every citation in ' +
        'every finding was re-fetched from chain state and byte-compared before publication. The ' +
        'reply also carries snapshotAgeSeconds, because cited blocks stop being re-fetchable on ' +
        'this RPC within roughly half an hour. Filter by symbol, defect class or minimum severity.',
      inputSchema: {
        symbol: z.string().optional().describe('Filter to one ticker'),
        // Typed to the real union rather than a free string: the description used to name
        // STALE_ORACLE_PAST_HEARTBEAT, a class that does not exist, so a caller filtering by the
        // documented value got an empty list and no error.
        defectClass: z
          .enum([
            'CROSS_SURFACE_PRICE_MIX',
            'ORACLE_STALE_MARKET_CLOSED',
            'ORACLE_STALE_UNEXPECTED',
            'ORACLE_STALE_INDETERMINATE',
            'NO_PRICE_FEED',
            'SHARE_COUNT_MISREAD_RISK',
            'ORACLE_PAUSED',
            'SEQUENCER_FEED_UNAVAILABLE',
            'PENDING_CORPORATE_ACTION',
            'VAULT_DECIMAL_SCALE',
            'VAULT_WHITELIST',
            'VAULT_ASYNC_SETTLEMENT',
          ])
          .optional()
          .describe('Exact defect class'),
        minSeverity: z.enum(['critical', 'high', 'medium', 'low', 'info']).optional(),
        limit: z.number().int().min(1).max(100).optional(),
      },
    },
    async ({ symbol, defectClass, minSeverity, limit }) => {
      const payload = findingsPayload({
        symbol,
        defectClass: defectClass as DefectClass | undefined,
        minSeverity,
        limit,
      })
      return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] }
    },
  )

  server.registerTool(
    'assay_check_symbol',
    {
      title: 'Live integrity check for one Stock Token',
      description:
        'Run a fresh, live sweep for a single Robinhood Chain Stock Token and return verified findings ' +
        'at the current block. Slower than assay_findings but always current. Use before acting on an asset.',
      inputSchema: { symbol: z.string().describe('Stock Token ticker') },
    },
    async ({ symbol }) => {
      const r = await checkSymbol(symbol)
      return {
        content: [{ type: 'text', text: JSON.stringify(r, null, 2) }],
        // An unknown ticker is an error, not a clean bill of health. CRWDD is one keystroke from
        // the only 4.0x asset on the chain, and it used to come back as {published: 0}.
        isError: Boolean(r.error),
      }
    },
  )

  return server
}
