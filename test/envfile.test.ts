import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { appendEnvSecret, hasEnvKey, hasEnvValue, readEnv } from '../src/lib/envfile.js'

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
