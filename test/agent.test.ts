import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HttpRequestError } from 'viem'
import { AgentKit, customActionProvider } from '@coinbase/agentkit'
import { z as z3 } from 'zod3'

/**
 * The paid surfaces: what a buyer gets back for a bad input or a failed read, and what the operator
 * can see afterwards. Everything below the input checks is mocked, so nothing here reaches a chain,
 * a registry, OpenServ or Coinbase.
 */

const surface = vi.hoisted(() => ({
  truePositionFor: vi.fn(),
  checkSymbolSummary: vi.fn(),
  auditContract: vi.fn(),
}))
const registry = vi.hoisted(() => ({ fetchRhAssets: vi.fn() }))

vi.mock('../src/lib/surface.js', () => surface)
vi.mock('../src/lib/sources.js', async (orig) => ({ ...(await orig<object>()), ...registry }))

const { runTruePosition, runCheckSymbol, runCheckContract, checkAddressInput } = await import(
  '../src/agent/assay-agent.js'
)
const { assayActionProviders } = await import('../src/agentkit/assay-provider.js')

// Synthetic, checksummed (mixed case), so the EIP-55 path is exercised without naming a real holder.
const HOLDER = '0x1234567890AbcdEF1234567890aBcdef12345678'
const ACTION = {
  type: 'do-task',
  workspace: { id: 42 },
  task: { id: 7 },
  workspaceUpdateToken: 'WS-UPDATE-TOKEN-DO-NOT-LOG',
  taskUpdateToken: 'TASK-UPDATE-TOKEN-DO-NOT-LOG',
}

let logged: string[]
beforeEach(() => {
  for (const f of Object.values(surface)) f.mockReset()
  registry.fetchRhAssets.mockReset()
  registry.fetchRhAssets.mockResolvedValue([{ tokenSymbol: 'CRWD' }, { tokenSymbol: 'NVDA' }])
  logged = []
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => void logged.push(a.join(' ')))
})
afterEach(() => vi.restoreAllMocks())

const parse = (s: string) => JSON.parse(s) as Record<string, unknown>

describe('inputs are checked before any paid work, and answered in JSON', () => {
  it('rejects a malformed holder without touching the registry or the chain', async () => {
    const r = parse(await runTruePosition({ symbol: 'CRWD', holder: 'not-an-address' }, ACTION))
    expect(r).toMatchObject({ ok: false, errorClass: 'BAD_ADDRESS', field: 'holder', retryable: false })
    expect(r.message).toMatch(/40-hex-character address/)
    expect(registry.fetchRhAssets).not.toHaveBeenCalled()
    expect(surface.truePositionFor).not.toHaveBeenCalled()
  })

  it('rejects a mixed-case address whose EIP-55 checksum fails — a typo, not a request', async () => {
    const typo = HOLDER.slice(0, -1) + '0' // last character changed, case pattern kept
    const r = checkAddressInput('holder', typo)
    expect(r).toMatchObject({ ok: false, errorClass: 'BAD_ADDRESS' })
    expect((r as { message: string }).message).toMatch(/EIP-55 checksum/)
  })

  it('accepts all-lowercase (no checksum to check) and passes the checksummed form on', async () => {
    surface.truePositionFor.mockResolvedValue({ confidence: 'high', pending: { newUIMultiplier: null } })
    await runTruePosition({ symbol: 'crwd', holder: HOLDER.toLowerCase() }, ACTION)
    expect(surface.truePositionFor).toHaveBeenCalledWith('CRWD', HOLDER)
  })

  it('names an unknown ticker and offers the near miss, without reading the chain', async () => {
    const r = parse(await runTruePosition({ symbol: 'CRWDD', holder: HOLDER }, ACTION))
    expect(r).toMatchObject({ ok: false, errorClass: 'UNKNOWN_SYMBOL', didYouMean: 'CRWD', retryable: false })
    expect(surface.truePositionFor).not.toHaveBeenCalled()
  })

  it('rejects a missing contract address instead of letting the SDK throw', async () => {
    const r = parse(await runCheckContract({}, ACTION))
    expect(r).toMatchObject({ ok: false, errorClass: 'BAD_INPUT', field: 'address' })
    expect(surface.auditContract).not.toHaveBeenCalled()
  })
})

describe('a failure after payment comes back as an answer, not an exception', () => {
  it('turns a Cloudflare 403 into a one-line, retryable UPSTREAM_UNAVAILABLE', async () => {
    const page = '"<!DOCTYPE html><html><head><title>Just a moment...</title></head>' + ' '.repeat(5000) + '"'
    surface.truePositionFor.mockRejectedValue(
      new HttpRequestError({ body: {}, status: 403, url: 'https://rpc.mainnet.chain.robinhood.com', details: page }),
    )
    const r = parse(await runTruePosition({ symbol: 'NVDA', holder: HOLDER }, ACTION))
    expect(r).toMatchObject({ ok: false, errorClass: 'UPSTREAM_UNAVAILABLE', retryable: true })
    expect(r.message).toMatch(/Cloudflare challenge \(HTTP 403\)/)
    expect(String(r.message)).not.toContain('<')
    expect(String(r.message).length).toBeLessThan(300)
  })

  it('treats an unreadable contract as retryable, not as a verdict', async () => {
    surface.auditContract.mockRejectedValue(new Error(`could not read code at ${HOLDER}`))
    const r = parse(await runCheckContract({ address: HOLDER }, ACTION))
    expect(r).toMatchObject({ ok: false, errorClass: 'UPSTREAM_UNAVAILABLE', retryable: true })
  })
})

describe('one log line per request', () => {
  it('records time, capability, price, input, outcome, duration and the OpenServ ids — no tokens', async () => {
    surface.truePositionFor.mockResolvedValue({ confidence: 'refuse', pending: { newUIMultiplier: null } })
    await runTruePosition({ symbol: 'CRWD', holder: HOLDER }, ACTION)
    expect(logged).toHaveLength(1)
    const line = logged[0]!
    expect(line).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z request /)
    expect(line).toContain('capability=true_position')
    expect(line).toContain('usd=0.01')
    expect(line).toContain(`symbol=CRWD holder=${HOLDER}`)
    expect(line).toContain('outcome=ok confidence=refuse')
    expect(line).toMatch(/ ms=\d+ /)
    expect(line).toContain('workspace=42 task=7')
    expect(line).not.toContain('TOKEN')
  })

  it('logs rejected input too, and cannot be split into a forged line', async () => {
    await runCheckContract({ address: '0xabc\n2026-01-01T00:00:00.000Z request outcome=ok' }, ACTION)
    expect(logged).toHaveLength(1)
    expect(logged[0]).not.toContain('\n')
    expect(logged[0]).toContain('usd=0.25')
    expect(logged[0]).toContain('outcome=rejected class=BAD_ADDRESS')
  })
})

describe('check_symbol withholds rows that name a third-party contract', () => {
  it('drops INTEGRATOR_NOT_MULTIPLIER_AWARE rows and recounts', async () => {
    surface.checkSymbolSummary.mockResolvedValue({
      symbol: 'CRWD',
      published: 2,
      findings: [
        { id: 'a', defectClass: 'SHARE_COUNT_MISREAD_RISK' },
        { id: 'b', defectClass: 'INTEGRATOR_NOT_MULTIPLIER_AWARE', subject: 'Vault (0x1234)' },
      ],
    })
    const r = parse(await runCheckSymbol({ symbol: 'CRWD' }, ACTION))
    expect(r.published).toBe(1)
    expect(r.findings).toEqual([{ id: 'a', defectClass: 'SHARE_COUNT_MISREAD_RISK' }])
  })
})

describe('AgentKit provider — each action exactly once', () => {
  const stubWallet = {
    getName: () => 'test',
    getNetwork: () => ({ protocolFamily: 'evm', networkId: 'base-mainnet', chainId: '8453' }),
    getAddress: () => '0x0000000000000000000000000000000000000000',
  } as never

  it('registers three uniquely named actions, not nine', async () => {
    // The previous three customActionProviders each carried all three actions: 9, three per name.
    const kit = await AgentKit.from({ walletProvider: stubWallet, actionProviders: assayActionProviders() })
    const names = kit.getActions().map((a) => a.name)
    expect(names).toHaveLength(3)
    expect(new Set(names).size).toBe(3)
    expect(names.map((n) => n.replace(/^.*?_assay_/, 'assay_')).sort()).toEqual([
      'assay_check_contract',
      'assay_check_symbol',
      'assay_true_position',
    ])
  })

  it('neither leaks into nor absorbs a host\'s own customActionProvider', async () => {
    const host = customActionProvider({
      name: 'host_tool',
      description: 'the host agent\'s own tool',
      schema: z3.object({}),
      invoke: async () => 'ok',
    })
    const kit = await AgentKit.from({ walletProvider: stubWallet, actionProviders: [...assayActionProviders(), host] })
    const names = kit.getActions().map((a) => a.name)
    expect(names).toHaveLength(4)
    expect(new Set(names).size).toBe(4)
    expect(host.getActions(stubWallet).map((a) => a.name)).toEqual(['CustomActionProvider_host_tool'])
  })

  it('check_symbol through AgentKit withholds named-integrator rows, as the OpenServ path does', async () => {
    // AgentKit's CreateAction wraps every invoke in an unawaited telemetry POST to Coinbase. Answer
    // it here so nothing leaves the machine and a failed POST cannot surface as an unhandled rejection.
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }))
    surface.checkSymbolSummary.mockResolvedValue({
      symbol: 'CRWD',
      published: 2,
      findings: [
        { id: 'a', defectClass: 'SHARE_COUNT_MISREAD_RISK' },
        { id: 'b', defectClass: 'INTEGRATOR_NOT_MULTIPLIER_AWARE', subject: 'Vault (0x1234)' },
      ],
    })
    const kit = await AgentKit.from({ walletProvider: stubWallet, actionProviders: assayActionProviders() })
    const action = kit.getActions().find((a) => a.name.endsWith('_assay_check_symbol'))!
    const r = parse(await action.invoke({ symbol: 'CRWD' }))
    expect(r.published).toBe(1)
    expect(r.findings).toEqual([{ id: 'a', defectClass: 'SHARE_COUNT_MISREAD_RISK' }])
  })
})

describe('serve-remote refuses to start with a key it does not need', () => {
  const tsx = join(process.cwd(), 'node_modules', '.bin', 'tsx')
  const script = join(process.cwd(), 'scripts', 'serve-remote.ts')

  /**
   * Run in an empty directory, so dotenv finds no .env and nothing real is loaded. DISABLE_TUNNEL
   * is belt and braces: if a refusal regressed, the child must not reach OpenServ.
   */
  function start(extraEnv: Record<string, string>, files: Record<string, string> = {}) {
    const cwd = mkdtempSync(join(tmpdir(), 'assay-serve-remote-'))
    try {
      for (const [name, body] of Object.entries(files)) writeFileSync(join(cwd, name), body)
      return spawnSync(tsx, [script], {
        cwd,
        encoding: 'utf8',
        timeout: 30_000,
        env: {
          PATH: process.env.PATH ?? '',
          OPENSERV_API_KEY: 'test-agent-key',
          OPENSERV_AUTH_TOKEN: 'test-auth-token',
          DISABLE_TUNNEL: 'true',
          ...extraEnv,
        },
      })
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  }

  it('refuses when SERV_API_KEY is present, as the RUNBOOK says it does', () => {
    const r = start({ SERV_API_KEY: 'sk-test' })
    expect(r.status).toBe(1)
    expect(r.stderr).toMatch(/REFUSING TO START: SERV_API_KEY/)
    expect(r.stderr).not.toContain('sk-test')
  }, 40_000)

  // The account-admin key, the reason this list grew past the two wallet keys, and the audit's
  // original ask. Neither had a case, so dropping either from FORBIDDEN_ENV failed nothing.
  it('refuses when the OpenServ account-admin key is present', () => {
    const r = start({ OPENSERV_USER_API_KEY: 'user-key-test' })
    expect(r.status).toBe(1)
    expect(r.stderr).toMatch(/REFUSING TO START: OPENSERV_USER_API_KEY/)
    expect(r.stderr).not.toContain('user-key-test')
  }, 40_000)

  it('refuses when a wallet key is present', () => {
    const r = start({ WALLET_PRIVATE_KEY: '0x1' })
    expect(r.status).toBe(1)
    expect(r.stderr).toMatch(/REFUSING TO START: WALLET_PRIVATE_KEY/)
  }, 40_000)

  it('refuses when the account key file sits in the working directory', () => {
    const r = start({}, { '.openserv.json': '{}' })
    expect(r.status).toBe(1)
    expect(r.stderr).toMatch(/REFUSING TO START: \.openserv\.json/)
  }, 40_000)
})
