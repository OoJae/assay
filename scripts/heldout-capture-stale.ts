import { readFileSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import type { VerifiedFinding } from '../src/verify/index.js'

/**
 * Capture the STALE fixture for the held-out set, under the rule PROTOCOL.md fixed in advance:
 *
 *   the first ORACLE_STALE_MARKET_CLOSED finding, in board order, on the first public board whose
 *   observedAt is at or after 2026-09-26T20:00:00Z, copied verbatim; if none exists by
 *   2026-09-27T12:00:00Z, the STALE cases are not run and are reported as not run.
 *
 * The rule exists so the fixture is not chosen after looking at how the model might answer it. This
 * script applies it mechanically and refuses outside the window rather than let a convenient board
 * be picked by hand. It never touches the SHARE or CROSS fixtures: it refuses to write if
 * re-serialising the file would change a byte of them.
 *
 *   npx tsx scripts/heldout-capture-stale.ts            then commit fixtures.json, then
 *   npx tsx scripts/heldout-trials.ts --fixtures=STALE
 */
// Not imported from heldout-trials.ts: that module loads .env, and this one needs no secret.
export const FIXTURES_FILE = 'src/adjudicate/heldout/fixtures.json'
export const BOARD_URL = 'https://sonar.my.id/assay-mcp/findings.json'
export const WINDOW_OPENS = '2026-09-26T20:00:00Z'
export const WINDOW_CLOSES = '2026-09-27T12:00:00Z'
const CLASS = 'ORACLE_STALE_MARKET_CLOSED'

export type Selection =
  | { ok: true; finding: VerifiedFinding; observedAt: string; blockNumber: string }
  | { ok: false; reason: string; retry: boolean }

/** The protocol's rule, as a pure function of one board. */
export function selectStale(board: { observedAt?: string; blockNumber?: string | number; findings?: VerifiedFinding[] }): Selection {
  const at = board.observedAt ? Date.parse(board.observedAt) : NaN
  if (!Number.isFinite(at)) return { ok: false, reason: 'the board carries no observedAt', retry: true }
  if (at < Date.parse(WINDOW_OPENS)) {
    return { ok: false, reason: `board observed ${board.observedAt}, before the window opens at ${WINDOW_OPENS}`, retry: true }
  }
  if (at >= Date.parse(WINDOW_CLOSES)) {
    return {
      ok: false,
      reason: `board observed ${board.observedAt}, after ${WINDOW_CLOSES}: under PROTOCOL.md the STALE cases are not run and are reported as not run`,
      retry: false,
    }
  }
  const finding = (board.findings ?? []).find((f) => f.defectClass === CLASS)
  if (!finding) return { ok: false, reason: `no ${CLASS} finding on the board observed ${board.observedAt}`, retry: true }
  return { ok: true, finding, observedAt: board.observedAt!, blockNumber: String(board.blockNumber) }
}

/**
 * The byte format fixtures.json was first written in (Python's json.dumps, indent 2, non-ASCII
 * escaped). Reproducing it keeps the SHARE and CROSS entries byte-identical in the diff.
 */
export function serialise(value: unknown): string {
  return JSON.stringify(value, null, 2).replace(/[\u007f-\uffff]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`) + '\n'
}

async function main() {
  const original = readFileSync(FIXTURES_FILE, 'utf8')
  const file = JSON.parse(original)
  if (file.fixtures?.STALE) {
    console.error(`${FIXTURES_FILE} already holds a STALE fixture (${file.fixtures.STALE.id}); refusing to replace it`)
    process.exit(1)
  }
  if (serialise(file) !== original) {
    console.error(`re-serialising ${FIXTURES_FILE} would change existing bytes; refusing rather than touch the frozen fixtures`)
    process.exit(1)
  }

  const res = await fetch(BOARD_URL, { signal: AbortSignal.timeout(30_000) })
  if (!res.ok) {
    console.error(`${BOARD_URL} returned HTTP ${res.status}; try again`)
    process.exit(1)
  }
  const sel = selectStale(await res.json())
  if (!sel.ok) {
    console.error(`${sel.reason}${sel.retry ? '; try again on a later board' : ''}`)
    process.exit(sel.retry ? 1 : 3)
  }

  file.fixtures.STALE = sel.finding
  file.staleCapture = { rule: 'PROTOCOL.md, STALE fixture: capture rule', boardObservedAt: sel.observedAt, blockNumber: sel.blockNumber, capturedAt: new Date().toISOString() }
  writeFileSync(FIXTURES_FILE, serialise(file))
  console.log(`captured ${sel.finding.id} (${sel.finding.defectClass}) from the board observed ${sel.observedAt}, block ${sel.blockNumber}`)
  console.log(`next: commit ${FIXTURES_FILE}, then npx tsx scripts/heldout-trials.ts --fixtures=STALE`)
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main()
