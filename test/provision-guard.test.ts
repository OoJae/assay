import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, rmSync, statSync, readdirSync, existsSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { privateKeyToAccount } from 'viem/accounts'
import { ENV_BACKUP_PATH } from '../src/lib/envfile.js'
import {
  backupOpenServState,
  provisionCredentials,
  OPENSERV_BACKUP_PATH,
} from '../src/lib/openserv-state.js'

/**
 * The credential behind both paid workflows must survive the scripts that touch it.
 *
 * .openserv.json's userApiKey is the only way into the OpenServ account that owns the $0.01 and
 * $0.25 triggers; the wallet that created that account is gone. `pnpm provision` and `pnpm serve`
 * used to call the vendor's provision() without it, and the vendor answers any API error by
 * signing in with the current wallet (a different account) and writing that account's key over
 * the saved one. These tests run the real scripts against a mocked vendor in a scratch directory,
 * so nothing here can reach OpenServ, the real .env or the real ~/.assay.
 */
const calls = vi.hoisted(() => ({
  provision: [] as Array<Record<string, unknown>>,
  order: [] as string[],
  onProvision: null as null | (() => void),
}))

vi.mock('@openserv-labs/client', () => ({
  provision: vi.fn(async (config: Record<string, unknown>) => {
    calls.provision.push(config)
    calls.order.push('provision')
    calls.onProvision?.()
    return { agentId: 1, workflowId: 2, triggerId: 't', paywallUrl: 'p', apiEndpoint: 'e' }
  }),
  triggers: { x402: (o: Record<string, unknown>) => ({ type: 'x402', ...o }) },
  // set-payto's view of a trigger already paying the current wallet, so it stops before any write.
  PlatformClient: class {
    triggers = {
      get: async () => ({ name: 'true-position', props: { x402WalletAddress: process.env.PAYTO_FIXTURE } }),
    }
  },
}))
vi.mock('@openserv-labs/sdk', () => ({
  run: vi.fn(async () => {
    calls.order.push('run')
    return {}
  }),
}))
vi.mock('../src/agent/assay-agent.js', () => ({ assayAgent: {} }))

const KEY = '0x' + 'a'.repeat(64)
const OTHER = '0x' + 'b'.repeat(64)
const THIRD = '0x' + 'c'.repeat(64)
const addr = (k: string) => privateKeyToAccount(k as `0x${string}`).address
const SCRIPT_VARS = ['WALLET_PRIVATE_KEY', 'BUYER_PRIVATE_KEY', 'BUYER_ADDRESS', 'PAYTO_FIXTURE'] as const

let dir: string
let home: string
let argv: string[]

beforeAll(() => {
  // Everything below writes backups through the default paths. Refuse to run at all if those are
  // not the suite's scratch location: the env backup was destroyed exactly this way once.
  if (!OPENSERV_BACKUP_PATH.startsWith(tmpdir()) || !ENV_BACKUP_PATH.startsWith(tmpdir())) {
    throw new Error('backup paths are not scratch paths — refusing to run')
  }
})

beforeEach(() => {
  home = process.cwd()
  argv = process.argv
  dir = mkdtempSync(join(tmpdir(), 'assay-provision-'))
  process.chdir(dir)
  for (const k of SCRIPT_VARS) delete process.env[k]
  calls.provision.length = 0
  calls.order.length = 0
  calls.onProvision = null
  vi.resetModules()
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new Error(`exit ${code}`)
  }) as never)
})

afterEach(() => {
  process.chdir(home)
  process.argv = argv
  for (const k of SCRIPT_VARS) delete process.env[k]
  rmSync(dir, { recursive: true, force: true })
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

/** Unique per test, so one test's dated copy can never stand in for another's. */
const state = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({ userApiKey: 'fixture-user-api-key', agents: { assay: { id: 1 } }, workflows: {}, dir, ...extra })

const datedCopies = (to: string) =>
  existsSync(dirname(to)) ? readdirSync(dirname(to)).filter((f) => f.startsWith('openserv.json.backup.')) : []

describe('provisionCredentials', () => {
  it('passes the saved userApiKey with an explicit walletAddress, which skips SIWE', () => {
    writeFileSync('.openserv.json', state())
    expect(provisionCredentials(addr(KEY) as `0x${string}`)).toEqual({
      userApiKey: 'fixture-user-api-key',
      walletAddress: addr(KEY),
    })
  })

  it('leaves a genuine first run to SIWE', () => {
    expect(provisionCredentials(addr(KEY) as `0x${string}`)).toEqual({})
    writeFileSync('.openserv.json', JSON.stringify({ agents: {}, workflows: {} }))
    expect(provisionCredentials(addr(KEY) as `0x${string}`)).toEqual({})
  })

  it('REFUSES provisioned state with no userApiKey: SIWE would recreate it in another account', () => {
    writeFileSync('.openserv.json', JSON.stringify({ agents: { assay: { id: 1 } }, workflows: {} }))
    expect(() => provisionCredentials(addr(KEY) as `0x${string}`)).toThrow(/REFUSING.*no userApiKey/)
  })

  it('REFUSES a file it cannot parse, which the vendor would read as empty and overwrite', () => {
    writeFileSync('.openserv.json', '{"userApiKey": "trunc')
    expect(() => provisionCredentials(addr(KEY) as `0x${string}`)).toThrow(/REFUSING.*not valid JSON/)
  })
})

describe('backupOpenServState', () => {
  it('tightens the file to 600 and copies it byte for byte, owner-only', () => {
    const to = join(dir, 'backup', 'openserv.json.backup')
    writeFileSync('.openserv.json', state(), { mode: 0o644 })
    const copy = backupOpenServState('.openserv.json', to)!
    expect(statSync('.openserv.json').mode & 0o077).toBe(0)
    expect(statSync(copy).mode & 0o077).toBe(0)
    expect(readFileSync(copy, 'utf8')).toBe(state())
  })

  it('never overwrites a dated copy, and does not repeat an unchanged one', () => {
    const to = join(dir, 'backup', 'openserv.json.backup')
    writeFileSync('.openserv.json', state())
    const first = backupOpenServState('.openserv.json', to)!
    expect(backupOpenServState('.openserv.json', to)).toBe(first)
    expect(datedCopies(to)).toHaveLength(1)

    writeFileSync('.openserv.json', state({ userApiKey: 'a-different-account' }))
    const second = backupOpenServState('.openserv.json', to)!
    expect(second).not.toBe(first)
    expect(readFileSync(first, 'utf8')).toBe(state())          // the earlier credential survives
    expect(datedCopies(to)).toHaveLength(2)
  })

  it('has nothing to copy before a first run', () => {
    expect(backupOpenServState('.openserv.json', join(dir, 'b', 'openserv.json.backup'))).toBeNull()
  })

  it('writes under the suite\'s scratch path, never ~/.assay', () => {
    expect(OPENSERV_BACKUP_PATH.startsWith(join(homedir(), '.assay'))).toBe(false)
    expect(dirname(OPENSERV_BACKUP_PATH)).toBe(dirname(ENV_BACKUP_PATH))
  })
})

describe('scripts/provision.ts and scripts/serve.ts', () => {
  for (const script of ['provision', 'serve'] as const) {
    it(`${script}: hands provision() the saved userApiKey, so an API blip cannot trigger SIWE`, async () => {
      process.env.WALLET_PRIVATE_KEY = KEY
      writeFileSync('.openserv.json', state(), { mode: 0o644 })
      const before = datedCopies(OPENSERV_BACKUP_PATH).length

      await import(`../scripts/${script}.ts`)

      expect(calls.provision).toHaveLength(1)
      expect(calls.provision[0]!.userApiKey).toBe('fixture-user-api-key')
      expect(calls.provision[0]!.walletAddress).toBe(addr(KEY))
      expect(statSync('.openserv.json').mode & 0o077).toBe(0)
      expect(datedCopies(OPENSERV_BACKUP_PATH).length).toBe(before + 1)
      if (script === 'serve') expect(calls.order).toEqual(['provision', 'run'])
    })

    it(`${script}: refuses without WALLET_PRIVATE_KEY rather than let the vendor write .env`, async () => {
      writeFileSync('.openserv.json', state())
      await expect(import(`../scripts/${script}.ts`)).rejects.toThrow(/WALLET_PRIVATE_KEY missing/)
      expect(calls.provision).toHaveLength(0)
      expect(existsSync('.env')).toBe(false)
    })

    it(`${script}: refuses provisioned state that has lost its userApiKey`, async () => {
      process.env.WALLET_PRIVATE_KEY = KEY
      writeFileSync('.openserv.json', JSON.stringify({ agents: { assay: { id: 1 } }, workflows: {} }))
      await expect(import(`../scripts/${script}.ts`)).rejects.toThrow(/REFUSING/)
      expect(calls.provision).toHaveLength(0)
    })
  }

  it('a first run signs in, and the file the vendor creates at 644 ends up 600 and copied', async () => {
    process.env.WALLET_PRIVATE_KEY = KEY
    calls.onProvision = () =>
      writeFileSync('.openserv.json', state({ userApiKey: 'first-run-key' }), { mode: 0o644 })
    const before = datedCopies(OPENSERV_BACKUP_PATH).length

    await import('../scripts/provision.ts')

    expect(calls.provision[0]!.userApiKey).toBeUndefined()
    expect(statSync('.openserv.json').mode & 0o077).toBe(0)
    expect(datedCopies(OPENSERV_BACKUP_PATH).length).toBe(before + 1)
  })
})

describe('every script that loads a signing key tightens a loose .env first', () => {
  for (const script of ['provision', 'serve', 'provision-contract-audit', 'set-payto'] as const) {
    it(script, async () => {
      writeFileSync('.env', `WALLET_PRIVATE_KEY=${KEY}\n`, { mode: 0o644 })
      process.env.WALLET_PRIVATE_KEY = KEY
      process.env.PAYTO_FIXTURE = addr(KEY)
      writeFileSync('.openserv.json', state({ workflows: { assay: { 'ASSAY Valuation Integrity': { workspaceId: 2, triggerId: 't' } } } }))
      vi.spyOn(console, 'warn').mockImplementation(() => {})

      // set-payto exits 0 once it sees payTo is already right; the others run to completion.
      await import(`../scripts/${script}.ts`).catch((e: Error) => expect(e.message).toBe('exit 0'))
      expect(statSync('.env').mode & 0o077).toBe(0)
    })
  }
})

describe('scripts/provision-contract-audit.ts recovery message', () => {
  it('names the addresses to check a backup against instead of "restore NOW"', async () => {
    writeFileSync('.env', `WALLET_PRIVATE_KEY=${KEY}\nBUYER_PRIVATE_KEY=${OTHER}\n`, { mode: 0o600 })
    writeFileSync('.openserv.json', state())
    // Something inside provision() replaces the owner key: the case the tripwire exists for.
    calls.onProvision = () =>
      writeFileSync('.env', `WALLET_PRIVATE_KEY=${THIRD}\nBUYER_PRIVATE_KEY=${OTHER}\n`)
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})

    await expect(import('../scripts/provision-contract-audit.ts')).rejects.toThrow('exit 1')

    const said = err.mock.calls.flat().join('\n')
    expect(said).toContain(addr(KEY))
    expect(said).toContain(addr(OTHER))
    expect(said).toMatch(/dated copies/)
    expect(said).toMatch(/Never restore one blind/)
    expect(said).not.toMatch(/restore .* NOW/)
    for (const k of [KEY, OTHER, THIRD]) expect(said).not.toContain(k.slice(2))
  })
})

describe('scripts/prove-settlement.ts', () => {
  const PAYTO = '0x' + '3'.repeat(40)
  const BUYER = '0x' + '2'.repeat(40)
  const STRANGER = '0x' + '1'.repeat(40)
  const transfer = (from: string, tx: string) => ({
    transaction_hash: tx,
    method: 'transferWithAuthorization',
    from: { hash: from },
    to: { hash: PAYTO },
    total: { value: '10000', decimals: '6' },
    timestamp: '2026-09-22T00:00:00Z',
  })

  it('needs no private key: the buyer address is enough', async () => {
    const fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ items: [transfer(BUYER, '0xmine'), transfer(STRANGER, '0xtheirs')] }),
    }))
    vi.stubGlobal('fetch', fetch)
    process.argv = ['node', 'prove-settlement.ts', PAYTO, BUYER]

    await import('../scripts/prove-settlement.ts')

    expect(fetch.mock.calls[0]![0]).toContain(`/addresses/${PAYTO}/token-transfers`)
    const said = vi.mocked(console.log).mock.calls.flat().join('\n')
    expect(said).toContain('0xmine')
    expect(said).not.toContain('0xtheirs')
  })

  it('takes BUYER_ADDRESS from the environment', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ items: [transfer(BUYER, '0xmine')] }) })))
    process.env.BUYER_ADDRESS = BUYER
    process.argv = ['node', 'prove-settlement.ts', PAYTO]

    await import('../scripts/prove-settlement.ts')
    expect(vi.mocked(console.log).mock.calls.flat().join('\n')).toContain('0xmine')
  })

  it('without a buyer, exits naming the variable, before any request', async () => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    process.argv = ['node', 'prove-settlement.ts', PAYTO]

    await expect(import('../scripts/prove-settlement.ts')).rejects.toThrow('exit 1')
    expect(err.mock.calls.flat().join('\n')).toMatch(/BUYER_ADDRESS/)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('never echoes a rejected buyer, since the likeliest mistake is pasting a key there', async () => {
    vi.stubGlobal('fetch', vi.fn())
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    process.argv = ['node', 'prove-settlement.ts', PAYTO, KEY]

    await expect(import('../scripts/prove-settlement.ts')).rejects.toThrow('exit 1')
    const said = err.mock.calls.flat().join('\n')
    expect(said).toMatch(/buyer argument is not a 0x address/)
    expect(said).not.toContain(KEY.slice(2))
  })
})

describe('scripts/make-buyer.ts', () => {
  it('re-running with an existing key refreshes the backup, which never gained it', async () => {
    writeFileSync('.env', `BUYER_PRIVATE_KEY=${OTHER}\n`, { mode: 0o600 })
    const envCopies = () => readdirSync(dirname(ENV_BACKUP_PATH)).filter((f) => f.startsWith('env.backup.'))
    const before = existsSync(dirname(ENV_BACKUP_PATH)) ? envCopies() : []

    await import('../scripts/make-buyer.ts')

    const added = envCopies().filter((f) => !before.includes(f))
    expect(added).toHaveLength(1)
    expect(readFileSync(join(dirname(ENV_BACKUP_PATH), added[0]!), 'utf8')).toContain(OTHER)
    expect(readFileSync('.env', 'utf8')).toBe(`BUYER_PRIVATE_KEY=${OTHER}\n`)   // untouched
  })
})
