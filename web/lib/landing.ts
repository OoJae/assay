import { SNAPSHOT_FRESH_MS, divergentTokens, symbolOf, type Finding, type SweepData } from './findings'

/**
 * What the landing shows, derived from one board. The CONTRACT is fixed here; the derivation is
 * implemented and tested in test/landing-data.test.ts. Every value that the landing paints in the
 * streak colour must be one the board byte-verified, under the call it was actually read with.
 */
export interface LandingBar {
  findingId: string
  symbol: string
  /** The Stock Token contract the citations were read from. */
  token: string
  /** The block the citations were read at. */
  block: string
  /** totalSupply() as cited: raw return hex and the decoded token amount (4 dp, the finding's own format). */
  supply: { raw: string; tokens: string }
  /** uiMultiplier() as cited: raw return hex and the decoded multiplier (9 dp). */
  multiplier: { raw: string; value: string }
  /** Derived share-equivalents, supply × multiplier (4 dp). Not itself a cited value. */
  shares: string
  /** How many pieces the bar divides into: the multiplier when it is an integer 2..8, else null. */
  segments: number | null
  verified: { checked: number; reproduced: number }
}

export interface LandingFacts {
  source: 'live' | 'committed'
  blockNumber: string
  observedAt: string
  /** When the board stops counting as fresh (ISO). */
  staleAfter: string
  findings: number
  critical: number
  citations: { ok: number; total: number }
  withheld: number
  mismatched: number
  /** Stock Tokens whose multiplier is not 1. */
  divergent: number
  bar: LandingBar | null
}

/** The finding the landing's bar is struck from when the board has it: the largest gap on chain. */
export const PREFERRED_BAR_FINDING = 'CRWD-share-count'

const SHARE_COUNT = 'SHARE_COUNT_MISREAD_RISK'
const ONE_E18 = 10n ** 18n

/** One ABI-encoded uint256 return: exactly 32 bytes. Anything else is not a value we can print. */
const UINT256_HEX = /^0x[0-9a-fA-F]{64}$/

/**
 * A non-negative fixed-point integer printed with `dp` decimals. `value` is already scaled by
 * 10^dp, so there is no float anywhere between the return bytes and the digits on the page.
 */
function fixed(value: bigint, dp: number): string {
  const unit = 10n ** BigInt(dp)
  return `${value / unit}.${(value % unit).toString().padStart(dp, '0')}`
}

/**
 * The supply in whole tokens at 4 dp, truncated: the sweep's own arithmetic in src/sweep/detect.ts
 * (`totalSupply * 10_000n / 10n ** decimals`), so the landing prints the finding's own digits.
 */
function tokensAt(raw: bigint, decimals: number): string {
  return fixed((raw * 10_000n) / 10n ** BigInt(decimals), 4)
}

/**
 * The token's decimals, which no citation carries.
 *
 * The sweep scales by each token's own decimals() but does not cite that read, so the bytes alone
 * cannot say whether 14187500000000000000 is 14.1875 tokens. The finding's note can: it prints the
 * supply the sweep computed ("totalSupply raw 14.1875 tokens vs …"). Every Stock Token read so far
 * uses 18; any other count is accepted only when it reproduces the note's figure exactly, and a note
 * that no decimals reproduce rules the finding out rather than letting a guessed scale be painted
 * as verified.
 */
function decimalsFor(f: Finding, raw: bigint): number | null {
  const quoted = /totalSupply raw (\d+\.\d{4}) tokens/.exec(f.impact?.note ?? '')?.[1]
  if (!quoted) return 18
  if (tokensAt(raw, 18) === quoted) return 18
  for (let d = 0; d <= 36; d++) if (tokensAt(raw, d) === quoted) return d
  return null
}

/**
 * The bar for one finding, or null when it cannot be drawn truthfully: both citations must be
 * present as clean uint256 returns from the same contract at the same block, every citation of the
 * finding must have re-fetched byte-for-byte, and the multiplier must be positive.
 */
function barFrom(f: Finding): LandingBar | null {
  const v = f.verification
  if (!v || !(v.checked > 0) || v.reproduced !== v.checked) return null
  const mult = f.evidence?.find((e) => e.call === 'uiMultiplier()')
  const supply = f.evidence?.find((e) => e.call === 'totalSupply()')
  if (!mult || !supply) return null
  if (!UINT256_HEX.test(mult.rawReturn) || !UINT256_HEX.test(supply.rawReturn)) return null
  if (mult.contract.toLowerCase() !== supply.contract.toLowerCase()) return null
  if (mult.blockNumber !== supply.blockNumber) return null

  const m = BigInt(mult.rawReturn)
  const s = BigInt(supply.rawReturn)
  if (m === 0n) return null
  const decimals = decimalsFor(f, s)
  if (decimals === null) return null

  // uiMultiplier() is 1e18-scaled. 9 dp, rounded half up: the sweep prints Number(m / 1e18).toFixed(9).
  const multiplier9 = (m * 10n ** 9n + ONE_E18 / 2n) / ONE_E18
  // share-equivalents = supply × multiplier / 1e18, in tokens, truncated at 4 dp as the sweep does.
  const shares4 = (s * m * 10_000n) / (10n ** BigInt(decimals) * ONE_E18)
  const whole = m % ONE_E18 === 0n ? Number(m / ONE_E18) : null

  return {
    findingId: f.id,
    symbol: symbolOf(f.subject ?? ''),
    token: supply.contract,
    block: supply.blockNumber,
    supply: { raw: supply.rawReturn, tokens: tokensAt(s, decimals) },
    multiplier: { raw: mult.rawReturn, value: fixed(multiplier9, 9) },
    shares: fixed(shares4, 4),
    segments: whole !== null && whole >= 2 && whole <= 8 ? whole : null,
    verified: { checked: v.checked, reproduced: v.reproduced },
  }
}

/**
 * The candidates in order: CRWD-share-count first, then every other share-count finding by the
 * wall's own ranking of "the largest gap on the board" (impact.percent, descending; a stable sort,
 * so ties keep board order). The first that yields a truthful bar is struck.
 */
function pickBar(findings: Finding[]): LandingBar | null {
  const shareCount = findings.filter((f) => f.defectClass === SHARE_COUNT)
  const preferred = shareCount.filter((f) => f.id === PREFERRED_BAR_FINDING)
  const rest = shareCount
    .filter((f) => f.id !== PREFERRED_BAR_FINDING)
    .sort((a, b) => (b.impact?.percent ?? 0) - (a.impact?.percent ?? 0))
  for (const f of [...preferred, ...rest]) {
    const bar = barFrom(f)
    if (bar) return bar
  }
  return null
}

function staleAfter(observedAt: string): string {
  const t = new Date(observedAt).getTime()
  // An unreadable timestamp is already stale, as snapshotAge() treats it.
  return new Date(Number.isFinite(t) ? t + SNAPSHOT_FRESH_MS : 0).toISOString()
}

/**
 * The landing's facts from one board. Pure: no clock, no I/O, so the ISR page and the tests
 * compute the same thing from the same board. Relative times ("3m ago") are for the client to
 * derive after mount from `observedAt`, because ISR HTML can be minutes old when it is read.
 */
export function landingFacts(d: SweepData & { source?: 'live' | 'committed' }): LandingFacts {
  const findings = d.findings ?? []
  const rejected = d.rejected ?? []
  return {
    // A board no loader labelled is not claimed to be live.
    source: d.source === 'live' ? 'live' : 'committed',
    blockNumber: d.blockNumber,
    observedAt: d.observedAt,
    staleAfter: staleAfter(d.observedAt),
    findings: findings.length,
    critical: findings.filter((f) => f.severity === 'critical').length,
    citations: {
      ok: findings.reduce((n, f) => n + (f.verification?.reproduced ?? 0), 0),
      total: findings.reduce((n, f) => n + (f.verification?.checked ?? 0), 0),
    },
    withheld: rejected.length,
    mismatched: rejected.filter((r) => r.reason === 'mismatch').length,
    divergent: divergentTokens({ findings }).length,
    bar: pickBar(findings),
  }
}
