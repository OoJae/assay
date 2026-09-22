import { readFileSync, writeFileSync, existsSync, statSync, chmodSync, renameSync, unlinkSync } from 'node:fs'
import { parse } from 'dotenv'

/**
 * Handling for the one file in this repo that holds signing keys.
 *
 * Two defects motivated this. First, `.env` was created with a bare writeFileSync, so under the
 * usual umask 022 it landed world-readable (-rw-r--r--) — a private key any local account could
 * read. Second, the "does a key already exist" check was a single anchored regex,
 * `/^BUYER_PRIVATE_KEY=(0x[0-9a-fA-F]{64})$/m`, which misses every spelling dotenv itself
 * accepts: quoted values, `export` prefixes, surrounding spaces, CRLF endings. On a miss it
 * APPENDED a second assignment, and dotenv takes the last one — so the scripts would sign with a
 * freshly generated empty wallet while the funded key sat orphaned two lines above it in the
 * same file.
 */

export const ENV_PATH = '.env'

/** Parse with the same parser that will later load it, so "does it exist" cannot disagree. */
export function readEnv(path = ENV_PATH): Record<string, string> {
  if (!existsSync(path)) return {}
  return parse(readFileSync(path))
}

/** True when the key is present in ANY spelling dotenv would honour, even if empty. */
export function hasEnvKey(name: string, path = ENV_PATH): boolean {
  return Object.prototype.hasOwnProperty.call(readEnv(path), name)
}

/** Restrict to owner-only, and say so loudly if it was not. */
export function secureEnv(path = ENV_PATH): void {
  if (!existsSync(path)) return
  const mode = statSync(path).mode & 0o777
  if (mode & 0o077) {
    chmodSync(path, 0o600)
    console.warn(
      `${path} was mode ${mode.toString(8)} (readable beyond its owner) — tightened to 600.`,
    )
  }
}

/**
 * Append a secret, atomically and privately.
 *
 * Refuses when the name already exists, because a duplicate assignment in a dotenv file is not an
 * error the parser reports — it is a silent last-wins that can strand a funded wallet.
 */
export function appendEnvSecret(name: string, value: string, path = ENV_PATH): void {
  if (hasEnvKey(name, path)) {
    throw new Error(
      `${name} already exists in ${path}. Refusing to append a second assignment: dotenv takes ` +
        `the LAST one, which would silently orphan the existing value.`,
    )
  }
  const prev = existsSync(path) ? readFileSync(path, 'utf8') : ''
  const body = (prev.trimEnd() + (prev.trim() ? '\n' : '') + `${name}=${value}\n`).replace(/^\n+/, '')
  const tmp = `${path}.tmp`
  writeFileSync(tmp, body, { mode: 0o600 })
  renameSync(tmp, path)
  if (existsSync(tmp)) unlinkSync(tmp)
  secureEnv(path)
}

/**
 * Startup assertion for anything that will load signing keys. Warns rather than exits: the
 * vendor's own provision() writes this file too, so a process that legitimately inherited a loose
 * mode should tighten it and continue, not refuse to run.
 */
export function assertEnvPrivate(path = ENV_PATH): void {
  if (!existsSync(path)) return
  secureEnv(path)
  const mode = statSync(path).mode & 0o777
  if (mode & 0o077) {
    console.error(`${path} is still mode ${mode.toString(8)} after chmod — refusing to load secrets.`)
    process.exit(1)
  }
}
