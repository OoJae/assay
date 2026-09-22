import {
  readFileSync,
  writeFileSync,
  existsSync,
  statSync,
  chmodSync,
  renameSync,
  unlinkSync,
  mkdirSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
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

/**
 * Where live secrets are mirrored, OUTSIDE the working tree.
 *
 * This exists because the working copy was destroyed. `.env` was overwritten with a byte-for-byte
 * copy of `.env.example`, and with it went WALLET_PRIVATE_KEY — the key that owned ERC-8004
 * identity 95265 and received every x402 payment — and BUYER_PRIVATE_KEY. Both unrecoverable: 97
 * stored 64-hex values across every artifact were tested and none was a key for those wallets.
 *
 * A single copy of an unrecoverable secret, inside a directory full of test fixtures and template
 * files with nearly the same name, is not storage. It is a countdown.
 */
export const ENV_BACKUP_PATH = join(homedir(), '.assay', 'env.backup')

/** A value that looks like a real secret rather than a placeholder. */
function isPopulated(v: string | undefined): boolean {
  const t = (v ?? '').trim()
  return t !== '' && !t.endsWith('...') && !t.startsWith('<')
}

/** How many secrets a file currently holds. The quantity the guard below refuses to reduce. */
export function populatedSecretCount(path = ENV_PATH): number {
  if (!existsSync(path)) return 0
  return Object.values(readEnv(path)).filter(isPopulated).length
}

/**
 * Refuse any write that would DESTROY secrets.
 *
 * The guard is deliberately crude — it counts populated values — because the failure it prevents
 * was crude: something copied a template over a live file. A write that reduces the count is
 * either a mistake or needs `{ allowSecretLoss: true }` said out loud.
 */
export function assertNoSecretLoss(path: string, nextBody: string, allowSecretLoss = false): void {
  if (allowSecretLoss || !existsSync(path)) return
  const before = populatedSecretCount(path)
  const after = Object.values(parse(nextBody)).filter(isPopulated).length
  if (after < before) {
    throw new Error(
      `REFUSING to write ${path}: it currently holds ${before} populated secret(s) and the new ` +
        `content holds ${after}. This is how the previous WALLET_PRIVATE_KEY was lost — a template ` +
        `overwrote a live file. Pass allowSecretLoss to override, and back up first.`,
    )
  }
}

/** Mirror the current secrets outside the working tree. Best effort; never blocks the caller. */
export function backupEnv(path = ENV_PATH, to = ENV_BACKUP_PATH): string | null {
  if (!existsSync(path) || populatedSecretCount(path) === 0) return null
  try {
    mkdirSync(dirname(to), { recursive: true, mode: 0o700 })
    writeFileSync(to, readFileSync(path, 'utf8'), { mode: 0o600 })
    return to
  } catch {
    return null
  }
}

/** Parse with the same parser that will later load it, so "does it exist" cannot disagree. */
export function readEnv(path = ENV_PATH): Record<string, string> {
  if (!existsSync(path)) return {}
  return parse(readFileSync(path))
}

/** True when the key is present in ANY spelling dotenv would honour, even if empty. */
export function hasEnvKey(name: string, path = ENV_PATH): boolean {
  return Object.prototype.hasOwnProperty.call(readEnv(path), name)
}

/**
 * True when the key exists AND carries a value.
 *
 * The distinction matters because `.env.example` ships every variable as a bare `NAME=`
 * placeholder, and the README tells you to `cp .env.example .env`. So on a fresh clone every key
 * EXISTS with an empty value — which made `hasEnvKey` true and `appendEnvSecret` refuse, so
 * `pnpm buyer` threw for anyone who followed the setup instructions exactly. An empty placeholder
 * is a slot to fill, not a value to protect.
 */
export function hasEnvValue(name: string, path = ENV_PATH): boolean {
  const v = readEnv(path)[name]
  return typeof v === 'string' && v.trim() !== ''
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
  if (hasEnvValue(name, path)) {
    throw new Error(
      `${name} already has a value in ${path}. Refusing to overwrite or append: dotenv takes the ` +
        `LAST assignment, so appending would silently orphan the existing key — and if that key is ` +
        `funded, the orphan is where the money is.`,
    )
  }

  const prev = existsSync(path) ? readFileSync(path, 'utf8') : ''
  // An EMPTY placeholder (from .env.example) is filled in place rather than appended to, so the
  // file keeps one assignment per name and the surrounding comments stay attached to it.
  const placeholder = new RegExp(`^(\\s*(?:export\\s+)?${name}\\s*=)\\s*(?:""|'')?\\s*$`, 'm')
  const body = placeholder.test(prev)
    ? prev.replace(placeholder, `$1${value}`)
    : (prev.trimEnd() + (prev.trim() ? '\n' : '') + `${name}=${value}\n`).replace(/^\n+/, '')

  assertNoSecretLoss(path, body)

  const tmp = `${path}.tmp`
  writeFileSync(tmp, body, { mode: 0o600 })
  renameSync(tmp, path)
  if (existsSync(tmp)) unlinkSync(tmp)
  secureEnv(path)
  backupEnv(path)
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
