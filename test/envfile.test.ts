import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, rmSync, statSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import {
  appendEnvSecret,
  assertNoSecretLoss,
  backupEnv,
  ENV_BACKUP_PATH,
  hasEnvKey,
  hasEnvValue,
  populatedSecretCount,
  readEnv,
} from '../src/lib/envfile.js'

/**
 * The setup path a judge follows verbatim.
 *
 * README says `cp .env.example .env`, and .env.example ships every variable as a bare `NAME=`
 * placeholder. That made every key EXIST with an empty value, so the "refuse to append a second
 * assignment" guard fired on a fresh clone and `pnpm buyer` threw for anyone who followed the
 * instructions. Two correct behaviours fought each other and the setup lost.
 */
let dir: string
let env: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'assay-env-'))
  env = join(dir, '.env')
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const KEY = '0x' + 'a'.repeat(64)
const OTHER = '0x' + 'b'.repeat(64)

describe('appendEnvSecret', () => {
  it('FILLS an empty placeholder copied from .env.example instead of refusing', () => {
    writeFileSync(env, '# a comment\nBUYER_PRIVATE_KEY=\nWALLET_PRIVATE_KEY=\n')
    expect(hasEnvKey('BUYER_PRIVATE_KEY', env)).toBe(true)
    expect(hasEnvValue('BUYER_PRIVATE_KEY', env)).toBe(false)

    expect(() => appendEnvSecret('BUYER_PRIVATE_KEY', KEY, env)).not.toThrow()
    expect(readEnv(env).BUYER_PRIVATE_KEY).toBe(KEY)
  })

  it('fills in place, so the file never carries two assignments for one name', () => {
    writeFileSync(env, 'BUYER_PRIVATE_KEY=\n')
    appendEnvSecret('BUYER_PRIVATE_KEY', KEY, env)
    const body = readFileSync(env, 'utf8')
    expect(body.match(/BUYER_PRIVATE_KEY=/g)).toHaveLength(1)
  })

  it('keeps the surrounding comments attached to the variable', () => {
    writeFileSync(env, '# Wallet B - buyer agent\nBUYER_PRIVATE_KEY=\n# MCP settings below\n')
    appendEnvSecret('BUYER_PRIVATE_KEY', KEY, env)
    const body = readFileSync(env, 'utf8')
    expect(body).toContain('# Wallet B - buyer agent')
    expect(body).toContain('# MCP settings below')
    expect(body.indexOf('# Wallet B')).toBeLessThan(body.indexOf('BUYER_PRIVATE_KEY='))
  })

  it('still REFUSES when a real value exists — that is where the money is', () => {
    writeFileSync(env, `BUYER_PRIVATE_KEY=${KEY}\n`)
    expect(() => appendEnvSecret('BUYER_PRIVATE_KEY', OTHER, env)).toThrow(/already has a value/i)
    expect(readEnv(env).BUYER_PRIVATE_KEY).toBe(KEY)
  })

  it('appends when the name is absent entirely', () => {
    writeFileSync(env, 'SOMETHING_ELSE=1\n')
    appendEnvSecret('BUYER_PRIVATE_KEY', KEY, env)
    expect(readEnv(env).BUYER_PRIVATE_KEY).toBe(KEY)
    expect(readEnv(env).SOMETHING_ELSE).toBe('1')
  })

  it('handles the export and quoted spellings dotenv accepts', () => {
    writeFileSync(env, 'export BUYER_PRIVATE_KEY=\n')
    appendEnvSecret('BUYER_PRIVATE_KEY', KEY, env)
    expect(readEnv(env).BUYER_PRIVATE_KEY).toBe(KEY)
    expect(readFileSync(env, 'utf8').match(/BUYER_PRIVATE_KEY=/g)).toHaveLength(1)
  })

  it('writes the file owner-only, because it holds a signing key', () => {
    writeFileSync(env, 'BUYER_PRIVATE_KEY=\n', { mode: 0o644 })
    appendEnvSecret('BUYER_PRIVATE_KEY', KEY, env)
    expect(statSync(env).mode & 0o077).toBe(0)
  })
})

describe('secret-loss guard — the thing that would have saved WALLET_PRIVATE_KEY', () => {
  it('REFUSES a write that reduces the number of populated secrets', () => {
    // The exact incident: `.env` held live keys and was replaced by a byte-for-byte copy of
    // `.env.example`. Both files parse fine, both are valid dotenv, and the destructive one looks
    // entirely reasonable — which is why the guard counts VALUES rather than inspecting content.
    writeFileSync(env, `WALLET_PRIVATE_KEY=${KEY}\nBUYER_PRIVATE_KEY=${OTHER}\nSERV_API_KEY=real\n`)
    expect(populatedSecretCount(env)).toBe(3)

    const template = 'WALLET_PRIVATE_KEY=\nBUYER_PRIVATE_KEY=\nSERV_API_KEY=serv_...\n'
    expect(() => assertNoSecretLoss(env, template)).toThrow(/REFUSING to write/)
  })

  it('treats placeholder spellings as empty, not as secrets', () => {
    writeFileSync(env, 'SERV_API_KEY=serv_...\nWALLET_PRIVATE_KEY=\n')
    expect(populatedSecretCount(env)).toBe(0)
  })

  it('allows a write that keeps or adds secrets', () => {
    writeFileSync(env, `WALLET_PRIVATE_KEY=${KEY}\n`)
    expect(() => assertNoSecretLoss(env, `WALLET_PRIVATE_KEY=${KEY}\nBUYER_PRIVATE_KEY=${OTHER}\n`)).not.toThrow()
    expect(() => assertNoSecretLoss(env, `WALLET_PRIVATE_KEY=${OTHER}\n`)).not.toThrow()
  })

  it('can be overridden deliberately, but only by saying so', () => {
    writeFileSync(env, `WALLET_PRIVATE_KEY=${KEY}\n`)
    expect(() => assertNoSecretLoss(env, '', true)).not.toThrow()
  })

  it('appendEnvSecret cannot be used to destroy an existing secret', () => {
    writeFileSync(env, `WALLET_PRIVATE_KEY=${KEY}\nBUYER_PRIVATE_KEY=\n`)
    appendEnvSecret('BUYER_PRIVATE_KEY', OTHER, env)
    const after = readEnv(env)
    expect(after.WALLET_PRIVATE_KEY).toBe(KEY)   // untouched
    expect(after.BUYER_PRIVATE_KEY).toBe(OTHER)  // filled
    expect(populatedSecretCount(env)).toBe(2)
  })

  it('backupEnv mirrors outside the working tree and refuses to back up nothing', () => {
    const dest = join(dir, 'backup', 'env.backup')
    writeFileSync(env, 'WALLET_PRIVATE_KEY=\n')
    expect(backupEnv(env, dest)).toBeNull()      // no secrets: nothing worth copying

    writeFileSync(env, `WALLET_PRIVATE_KEY=${KEY}\n`)
    expect(backupEnv(env, dest)).toBe(dest)
    expect(readFileSync(dest, 'utf8')).toContain(KEY)
    expect(statSync(dest).mode & 0o077).toBe(0)
  })
})

describe('template placeholders are slots, not values', () => {
  it('replaces a serv_... placeholder in place with the real key', () => {
    // The .env.example line is `SERV_API_KEY=serv_...`. It is non-empty, and the old definition of
    // "has a value" refused to overwrite it — so the real key could not be installed through the
    // guarded path at all.
    writeFileSync(env, `WALLET_PRIVATE_KEY=${KEY}\nSERV_API_KEY=serv_...\n`)
    expect(hasEnvValue('SERV_API_KEY', env)).toBe(false)

    appendEnvSecret('SERV_API_KEY', 'serv_' + 'x'.repeat(40), env)
    const body = readFileSync(env, 'utf8')
    expect(readEnv(env).SERV_API_KEY).toBe('serv_' + 'x'.repeat(40))
    expect(body.match(/SERV_API_KEY=/g)).toHaveLength(1)
    expect(readEnv(env).WALLET_PRIVATE_KEY).toBe(KEY)
  })
})

describe('the real backup is out of the suite\'s reach', () => {
  it('the suite runs against a scratch backup path, never ~/.assay/env.backup', () => {
    expect(ENV_BACKUP_PATH).not.toBe(join(homedir(), '.assay', 'env.backup'))
    expect(ENV_BACKUP_PATH.startsWith(tmpdir())).toBe(true)
  })

  it('appendEnvSecret on any file but the project .env backs up nothing', () => {
    // The regression: fixture files were backed up over the real key backup on every run.
    rmSync(ENV_BACKUP_PATH, { force: true })
    appendEnvSecret('WALLET_PRIVATE_KEY', KEY, env)
    expect(existsSync(ENV_BACKUP_PATH)).toBe(false)
  })

  it('a write after an incident cannot destroy the surviving backup', () => {
    const dest = join(dir, 'backup', 'env.backup')
    writeFileSync(env, `WALLET_PRIVATE_KEY=${KEY}\nBUYER_PRIVATE_KEY=${OTHER}\n`)
    backupEnv(env, dest)

    // .env wiped to the template, then a fresh key generated: the scenario that froze 95265.
    writeFileSync(env, `WALLET_PRIVATE_KEY=0x${'c'.repeat(64)}\nBUYER_PRIVATE_KEY=\n`)
    backupEnv(env, dest)

    expect(readEnv(dest).WALLET_PRIVATE_KEY).toBe(KEY)   // rolling copy kept the old keys
    expect(readEnv(dest).BUYER_PRIVATE_KEY).toBe(OTHER)
    const dated = readdirSync(join(dir, 'backup')).filter((f) => f.startsWith('env.backup.'))
    expect(dated).toHaveLength(2)                          // and both states are on disk
  })
})
