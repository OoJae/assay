import { readFileSync, writeFileSync, existsSync, chmodSync, mkdirSync, readdirSync } from 'node:fs'
import { join, dirname, basename } from 'node:path'
import { ENV_BACKUP_PATH } from './envfile.js'

/**
 * Handling for .openserv.json, which holds the only way back into the OpenServ account.
 *
 * That account owns both paid workflows, and it was created by SIWE with the service-owner wallet
 * whose key went down with the old .env. Signing in with the current WALLET_PRIVATE_KEY reaches a
 * DIFFERENT, empty account, so the userApiKey saved here is the only credential that can reprice,
 * repoint payTo or switch off either trigger. It sat at mode 644 and nothing copied it anywhere.
 */
export const OPENSERV_STATE_PATH = '.openserv.json'

/** Beside the env backups, so the suite's scratch ASSAY_ENV_BACKUP_PATH redirects both. */
export const OPENSERV_BACKUP_PATH = join(dirname(ENV_BACKUP_PATH), 'openserv.json.backup')

interface OpenServState {
  userApiKey?: string
  agents?: Record<string, unknown>
  workflows?: Record<string, unknown>
}

/**
 * How provision() may authenticate, decided before the vendor gets to decide.
 *
 * Called without userApiKey, provision() checks the saved key with one agents.list() and, on ANY
 * error (a timeout, a 5xx or a rate limit, not only a 401), signs in by SIWE with
 * WALLET_PRIVATE_KEY and writes that account's key over the saved one. With the current wallet
 * that is the wrong account, where the saved agent 404s, so it would also delete agents.assay and
 * register a new agent over the stored apiKey and authToken. One API blip during `pnpm serve`
 * would cost the only admin credential. Passing the saved key with a walletAddress skips SIWE.
 *
 * Empty only for a genuine first run, the one time SIWE is the point.
 */
export function provisionCredentials(
  walletAddress: `0x${string}`,
  path = OPENSERV_STATE_PATH,
): { userApiKey: string; walletAddress: `0x${string}` } | Record<string, never> {
  if (!existsSync(path)) return {}

  let st: OpenServState
  try {
    st = JSON.parse(readFileSync(path, 'utf8')) as OpenServState
  } catch {
    // The vendor reads an unparseable file as empty state and then writes a fresh sign-in over it.
    throw new Error(
      `REFUSING to provision: ${path} is not valid JSON, and provision() would write a new ` +
        `sign-in over it. Restore it from a dated copy ${OPENSERV_BACKUP_PATH}.<time> first.`,
    )
  }
  if (st.userApiKey) return { userApiKey: st.userApiKey, walletAddress }

  const agents = Object.keys(st.agents ?? {})
  const workflows = Object.keys(st.workflows ?? {})
  if (agents.length || workflows.length) {
    throw new Error(
      `REFUSING to provision: ${path} records agents [${agents}] and workflows [${workflows}] but ` +
        `holds no userApiKey. Signing in with WALLET_PRIVATE_KEY may reach a different account, ` +
        `where those ids 404 and are recreated over the stored credentials. Restore userApiKey ` +
        `from a dated copy ${OPENSERV_BACKUP_PATH}.<time> first.`,
    )
  }
  return {}
}

/**
 * Owner-only, and a dated copy under ~/.assay that is never overwritten.
 *
 * Run before provision() and again after it. The vendor rewrites this file several times a run
 * with a plain truncating writeFileSync, and creates it at the umask default (644) when it is new.
 * Throws rather than returning null the way backupEnv does: the caller is about to hand the file
 * to that writer, and a run with no copy is the state that already lost one credential.
 */
export function backupOpenServState(
  path = OPENSERV_STATE_PATH,
  to = OPENSERV_BACKUP_PATH,
): string | null {
  if (!existsSync(path)) return null
  chmodSync(path, 0o600)
  mkdirSync(dirname(to), { recursive: true, mode: 0o700 })

  const body = readFileSync(path)
  // An unchanged file needs no second copy: `pnpm serve` rewrites it identically on every start.
  const latest = readdirSync(dirname(to))
    .filter((f) => f.startsWith(`${basename(to)}.`))
    .sort()
    .at(-1)
  if (latest && readFileSync(join(dirname(to), latest)).equals(body)) return join(dirname(to), latest)

  // 'wx' is the never-overwrite guarantee; two versions in one millisecond get a counter instead.
  const stamp = `${to}.${new Date().toISOString().replace(/[:.]/g, '-')}`
  let dated = stamp
  for (let n = 1; existsSync(dated); n++) dated = `${stamp}-${n}`
  writeFileSync(dated, body, { mode: 0o600, flag: 'wx' })
  chmodSync(dated, 0o600)
  return dated
}
