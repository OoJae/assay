import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import {
  FINDINGS_PATH,
  checkSymbol,
  contractVerdict,
  findingsPayload,
  loadSnapshot,
  truePositionVerdictPayload,
  type SweepSnapshot,
} from '../lib/surface.js'
import { truePosition } from '../lib/position.js'
import { withoutNamedIntegrators } from '../lib/redact.js'
import { PAID_ENDPOINTS } from '../lib/endpoints.js'
import { sweepStatusPath, type SweepStatus } from '../sweep/guard.js'
import { describeRpcError, isTransient } from '../sweep/oracle.js'
import { HEAVY_TOOL_CONCURRENCY, HEAVY_TOOL_CONCURRENCY_PER_IP, InFlight } from './ratelimit.js'
import type { DefectClass } from '../sweep/types.js'

/**
 * ASSAY MCP server.
 *
 * Note on transport: OpenServ's own MCP support is SSE-only (docs: no-code/connect/mcps), so the
 * hosted deployment exposes SSE, and Streamable HTTP beside it for current clients. This module
 * builds the server; `stdio.ts` and `sse.ts` are the entrypoints. Every answer here comes from
 * lib/surface.ts, which is also what the AgentKit action provider and the OpenServ agent serve.
 *
 * FREE VERDICTS, PAID FIGURES. This server served the same auditContract() and TruePosition the
 * two x402 endpoints sell, free and at 60 calls a minute, so neither paid tier had anything in it.
 * The public tools now answer the question an agent needs before it acts — is this reading safe,
 * can this contract make the ERC-8056 correction — and say where the figures are sold.
 */

export const TOOLS = ['assay_true_position', 'assay_findings', 'assay_check_symbol', 'assay_check_contract'] as const

/**
 * Carried on every tool answer and the public feed.
 *
 * Robinhood Chain's terms (§5.7(b)(ii)) require community projects that use the name to say they
 * are not affiliated, and a tool that grades third parties and is called "before moving money" had
 * no statement of what its output is and is not.
 */
export const DISCLAIMER =
  'ASSAY is an independent project, not affiliated with or endorsed by Robinhood Markets, Inc. or ' +
  'Chainlink Labs. This is an automated, informational reading of public chain state at the cited ' +
  'block, provided as is: not investment, financial or legal advice, and not a security audit. ' +
  'Verify independently before acting.'

const NOT_ADVICE = ' Informational only, not advice; ASSAY is independent and not affiliated with Robinhood.'

/** Process-wide, so every session and every transport shares one cap. */
const inFlight = new InFlight(HEAVY_TOOL_CONCURRENCY)

/**
 * The sweep's publish cadence, and the age past which its board is not being refreshed.
 *
 * The timer fires 8 minutes after the previous run started and a run may take up to 7
 * (TimeoutStartSec in deploy/assay-sweep.service), so a healthy board is at most ~15 minutes old.
 */
export const SWEEP_CADENCE_SECONDS = 8 * 60
export const SWEEP_STALE_AFTER_SECONDS = 20 * 60

/**
 * One line, no internal paths, no upstream bodies.
 *
 * viem puts the RPC URL, the request body, the upstream response (a 5 KB Cloudflare page, once)
 * and its own version on the lines after the first, and a filesystem error names the file. None of
 * that is the caller's business, and the first line says what failed.
 */
export function publicText(s: string, max = 240): string {
  const first = (s.split('\n')[0] ?? '').trim()
  return first.replace(/\/(?:home|Users|root|private|tmp|var|opt|srv|etc)\/[^\s'")]*/g, '<path>').slice(0, max)
}

/** unavailableReason used to carry the artifact's path on this host, e.g. /home/ubuntu/assay-data/findings.json. */
export function publicUnavailableReason(reason: string): string {
  if (reason.startsWith('no sweep artifact at')) return 'no sweep artifact has been published on this host'
  if (reason.startsWith('sweep artifact unreadable')) return 'the sweep artifact could not be read'
  return publicText(reason)
}

/**
 * What a caller is told when a tool throws.
 *
 * The SDK returned `error.message` verbatim, so a failed chain read handed the caller viem's whole
 * message. Only the messages written for the caller about their own INPUT pass through; a chain
 * failure gets a fixed sentence and says it may be retried; anything else is an internal error.
 * The detail goes to the log under `ref`, so a report can still be traced.
 */
export function publicError(err: unknown): { error: string; retryable: boolean } {
  const msg = err instanceof Error ? err.message : String(err)
  if (/^unknown Robinhood Stock Token symbol: /.test(msg) || /^no chain-4663 deployment for /.test(msg)) {
    return { error: publicText(msg), retryable: false }
  }
  if (
    (err as { name?: string } | null)?.name === 'DeadlineExceededError' ||
    // surface.ts's wording when getCode itself failed; the OpenServ agent keys on the same text.
    /^could not read code at /.test(msg) ||
    isTransient(err)
  ) {
    return {
      error:
        'The Robinhood Chain RPC did not answer in time (rate-limited, challenged or down). Nothing ' +
        'was concluded; retry shortly.',
      retryable: true,
    }
  }
  return { error: 'Internal error; nothing was concluded.', retryable: false }
}

function reply(body: object, isError: boolean): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify({ ...body, disclaimer: DISCLAIMER }, null, 2) }],
    isError,
  }
}

/**
 * Run one tool call under the in-flight caps, with errors made safe to return.
 *
 * `ip` is the caller's address as the transport resolved it; each SSE session and each /mcp POST
 * builds its own server with it. Without one (stdio) only the process-wide cap applies.
 */
async function guarded(tool: string, ip: string | undefined, work: () => Promise<CallToolResult>): Promise<CallToolResult> {
  const release = inFlight.tryEnter(tool, ip)
  if (!release) {
    const ipCap = HEAVY_TOOL_CONCURRENCY_PER_IP[tool]
    const yours = ip !== undefined && ipCap !== undefined && inFlight.count(tool, ip) >= ipCap
    return reply(
      {
        error: 'busy',
        detail: yours
          ? `${tool} is already running ${ipCap} concurrent call${ipCap === 1 ? '' : 's'} from your address, ` +
            `its share of the server. Nothing was checked; retry when one finishes.`
          : `${tool} is already running its limit of ${HEAVY_TOOL_CONCURRENCY[tool]} concurrent calls ` +
            `across all callers. Nothing was checked; retry in a few seconds.`,
        retryable: true,
        retryAfterSeconds: 5,
      },
      true,
    )
  }
  try {
    return await work()
  } catch (err) {
    const ref = randomBytes(4).toString('hex')
    console.error(`[mcp] ${tool} failed ref=${ref}: ${describeRpcError(err)}`)
    return reply({ ...publicError(err), ref }, true)
  } finally {
    release()
  }
}

/** The sweep's own account of its last run, from the sidecar scripts/sweep.ts writes beside the board. */
export function readSweepStatus(findingsPath = FINDINGS_PATH): SweepStatus | null {
  const path = sweepStatusPath(findingsPath)
  try {
    if (!existsSync(path)) return null
    const s = JSON.parse(readFileSync(path, 'utf8')) as Partial<SweepStatus>
    if (typeof s.lastRunAt !== 'string' || (s.outcome !== 'published' && s.outcome !== 'refused')) return null
    return s as SweepStatus
  } catch {
    return null
  }
}

export interface SweepHealth {
  /** False when the board is not being refreshed or the last run refused to publish. */
  healthy: boolean
  /** Why not, in words. Empty when healthy. */
  problems: string[]
  cadenceSeconds: number
  staleAfterSeconds: number
  boardObservedAt: string | null
  boardBlock: string | null
  boardAgeSeconds: number | null
  /** null when no sweep has recorded a status on this host yet. */
  lastRun: (SweepStatus & { ageSeconds: number | null }) | null
}

const secondsSince = (iso: string, now: number): number | null => {
  const t = Date.parse(iso)
  return Number.isFinite(t) ? Math.round((now - t) / 1000) : null
}

/**
 * Whether the sweep is publishing, for /health, /findings.json and assay_findings.
 *
 * NOTHING SAID WHEN IT STOPPED. /health answered `ok: true` whatever the board's age, and a
 * refusal exits 2, which the unit counts as success and which leaves the board untouched, so a
 * sweep that had refused for hours looked exactly like one that had just published. A judge or a
 * paying buyer would have been the first to notice.
 */
export function sweepHealth(snap: SweepSnapshot, status: SweepStatus | null, now = Date.now()): SweepHealth {
  const boardAgeSeconds = snap.observedAt ? secondsSince(snap.observedAt, now) : null
  const problems: string[] = []
  if (snap.available === false) problems.push('no published board could be read')
  else if (boardAgeSeconds === null) problems.push('the published board carries no timestamp')
  else if (boardAgeSeconds > SWEEP_STALE_AFTER_SECONDS) {
    problems.push(
      `the published board is ${Math.round(boardAgeSeconds / 60)} minutes old; the sweep publishes ` +
        `every ${SWEEP_CADENCE_SECONDS / 60} minutes`,
    )
  }
  const lastRun = status
    ? { ...status, reason: publicText(String(status.reason ?? '')), ageSeconds: secondsSince(status.lastRunAt, now) }
    : null
  if (lastRun?.outcome === 'refused') {
    problems.push(`the last sweep (${lastRun.lastRunAt}) refused to publish: ${lastRun.reason}`)
  }
  return {
    healthy: problems.length === 0,
    problems,
    cadenceSeconds: SWEEP_CADENCE_SECONDS,
    staleAfterSeconds: SWEEP_STALE_AFTER_SECONDS,
    boardObservedAt: snap.observedAt ?? null,
    boardBlock: snap.blockNumber ?? null,
    boardAgeSeconds,
    lastRun,
  }
}

const TP = PAID_ENDPOINTS.truePosition
const CC = PAID_ENDPOINTS.checkContract

export function buildServer(opts: { ip?: string } = {}): McpServer {
  const server = new McpServer(
    { name: 'assay', version: '0.2.0' },
    {
      instructions:
        'ASSAY reads Robinhood Chain (chainId 4663) Stock Tokens, which implement ERC-8056: a ' +
        'corporate action moves uiMultiplier(), not balances. These tools are free and rate-limited ' +
        'per IP. assay_true_position and assay_check_contract return VERDICTS only; the figures behind ' +
        `them are sold over x402 (USDC on Base): $${TP.priceUsd} at ${TP.trigger} and $${CC.priceUsd} ` +
        `at ${CC.trigger}. ${DISCLAIMER}`,
    },
  )

  server.registerTool(
    'assay_true_position',
    {
      title: 'Is a Stock Token position safe to value right now? (free verdict)',
      description:
        'FREE VERDICT ONLY. Says whether a reading of this holder\'s Robinhood Chain Stock Token ' +
        'position is safe to act on at the current block: confidence (high | degraded | refuse), ' +
        'refusalReason, which safety checks completed (oraclePaused read, feed read, price sane, round ' +
        'complete, multiplier sane), and any scheduled uiMultiplier() change. Stock Tokens implement ' +
        'ERC-8056, so balanceOf() is NOT a share count. This tool does NOT return the position: the ' +
        'share-equivalent count, the multiplier-adjusted token price, the underlying share price and ' +
        `the position value are the paid answer, $${TP.priceUsd} over x402 at ${TP.trigger} ` +
        `(paywall: ${TP.paywall}). Call this before valuing, liquidating or collateralising a Stock ` +
        'Token.' +
        NOT_ADVICE,
      inputSchema: {
        symbol: z.string().describe('Stock Token ticker, e.g. NVDA, SPY, CRWD'),
        holder: z.string().regex(/^0x[a-fA-F0-9]{40}$/).describe('Holder address'),
      },
    },
    ({ symbol, holder }) =>
      guarded('assay_true_position', opts.ip, async () => {
        const p = await truePosition(symbol, holder as `0x${string}`)
        // `warning` names a scheduled multiplier change for the TOKEN (values and a time), nothing
        // about this holder, and it is a reason not to act on a verdict read just before it.
        return reply({ ...truePositionVerdictPayload(p), warning: p.warning }, false)
      }),
  )

  server.registerTool(
    'assay_findings',
    {
      title: 'Published valuation-integrity findings',
      description:
        'List verified findings from the latest ASSAY sweep of Robinhood Chain, which runs every 8 ' +
        'minutes. Every citation in every finding was re-fetched from chain state and byte-compared ' +
        'before publication. The reply carries snapshotAgeSeconds, because cited blocks stop being ' +
        're-fetchable on this RPC about 8-17 minutes after the sweep (citationLifetimeSeconds), and ' +
        'sweepHealth, which says whether the sweep is still publishing and why not. Contracts that ' +
        'hold a token are counted, never named. Filter by symbol, defect class or minimum severity.' +
        NOT_ADVICE,
      inputSchema: {
        symbol: z.string().optional().describe('Filter to one ticker'),
        // Typed to the real union rather than a free string: the description used to name
        // STALE_ORACLE_PAST_HEARTBEAT, a class that does not exist, so a caller filtering by the
        // documented value got an empty list and no error.
        defectClass: z
          // Exactly the classes a detector can actually emit. Five values that no detector
          // produces were removed: a filter that silently answers "none" to a question it cannot
          // answer is worse than one that rejects it.
          .enum([
            'CROSS_SURFACE_PRICE_MIX',
            'ORACLE_STALE_MARKET_CLOSED',
            'ORACLE_STALE_UNEXPECTED',
            'ORACLE_STALE_INDETERMINATE',
            'SHARE_COUNT_MISREAD_RISK',
            'INTEGRATOR_NOT_MULTIPLIER_AWARE',
            'ORACLE_PAUSED',
            'PENDING_CORPORATE_ACTION',
          ])
          .optional()
          .describe('Exact defect class'),
        minSeverity: z.enum(['critical', 'high', 'medium', 'low', 'info']).optional(),
        limit: z.number().int().min(1).max(100).optional(),
      },
    },
    ({ symbol, defectClass, minSeverity, limit }) =>
      guarded('assay_findings', opts.ip, async () => {
        const snap = loadSnapshot()
        const payload = findingsPayload(
          { symbol, defectClass: defectClass as DefectClass | undefined, minSeverity, limit },
          snap,
        )
        // The board on disk is redacted at source, so subtracting finding counts now gives 0. The
        // sweep records how many it removed.
        const withheld = (snap as { withheld?: { namedIntegrators?: number } }).withheld?.namedIntegrators
        return reply(
          {
            ...payload,
            ...(payload.unavailableReason
              ? { unavailableReason: publicUnavailableReason(payload.unavailableReason) }
              : {}),
            namedIntegratorsWithheld: withheld ?? payload.namedIntegratorsWithheld,
            sweepHealth: sweepHealth(snap, readSweepStatus()),
          },
          false,
        )
      }),
  )

  server.registerTool(
    'assay_check_symbol',
    {
      title: 'Live integrity check for one Stock Token',
      description:
        'Run a fresh, live sweep for a single Robinhood Chain Stock Token and return verified ' +
        'asset-level findings at the current block. Slower than assay_findings but always current. ' +
        'Contracts that hold the token are never named here; ask about one address you already have ' +
        'with assay_check_contract. Use before acting on an asset.' +
        NOT_ADVICE,
      inputSchema: { symbol: z.string().describe('Stock Token ticker') },
    },
    ({ symbol }) =>
      guarded('assay_check_symbol', opts.ip, async () => {
        const r = await checkSymbol(symbol)
        return reply(
          {
            ...r,
            // checkSymbol already runs without the integrator pass and filters; this is the last
            // door before the public, so it filters again.
            ...(r.findings ? { findings: withoutNamedIntegrators(r.findings) } : {}),
            ...(r.errors ? { errors: r.errors.map((e) => ({ ...e, error: publicText(e.error) })) } : {}),
            ...(r.notAssessed ? { notAssessed: r.notAssessed.map((e) => publicText(e)) } : {}),
          },
          // An unknown ticker is an error, not a clean bill of health. CRWDD is one keystroke from
          // the only 4.0x asset on the chain, and it used to come back as {published: 0}.
          // An asset that could not be READ is the same category: nothing was checked, so the caller
          // must not be able to mistake it for a pass.
          Boolean(r.error) || r.assessed === false,
        )
      }),
  )

  server.registerTool(
    'assay_check_contract',
    {
      title: 'Can this contract make the ERC-8056 correction? (free verdict)',
      description:
        'FREE VERDICT ONLY, for any address on Robinhood Chain 4663. Says whether its deployed ' +
        'bytecode references uiMultiplier(), resolving EIP-1967, beacon and EIP-1167 proxies to the ' +
        'implementation first: verdict AWARE | NOT_AWARE | NOT_APPLICABLE (with role AMM_POOL, ' +
        'AMM_POOL_MANAGER, CUSTODY or DISTRIBUTOR: contracts that never turn a balance into shares) | ' +
        'PROXY_UNRESOLVED | EOA | TOO_SMALL, plus codeHash, blockNumber and conclusive. It says ' +
        'nothing about what the address holds. The paid audit, ' +
        `$${CC.priceUsd} over x402 at ${CC.trigger} (paywall: ${CC.paywall}), adds every Stock Token ` +
        'whose on-chain multiplier is not 1.0 that the address holds, the share-equivalents and ' +
        'dollars at stake on each, which reads were incomplete, and evidence[] citations re-runnable ' +
        'at the block. A NOT_AWARE verdict establishes the ABSENCE OF A CALL, not the presence of a ' +
        'mistake. PROXY_UNRESOLVED makes no claim at all.' +
        NOT_ADVICE,
      inputSchema: {
        address: z
          .string()
          .regex(/^0x[a-fA-F0-9]{40}$/)
          .describe('Any address on Robinhood Chain 4663 — it need not already be on the findings wall'),
      },
    },
    ({ address }) =>
      guarded('assay_check_contract', opts.ip, async () => {
        const v = await contractVerdict(address as `0x${string}`)
        // An unresolved proxy is not a pass. The caller must not read it as one.
        return reply(v, !v.conclusive)
      }),
  )

  return server
}
