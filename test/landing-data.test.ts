import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { PREFERRED_BAR_FINDING, landingFacts } from '../web/lib/landing.js'
import {
  SNAPSHOT_FRESH_MS,
  divergentTokens,
  loadSweep,
  symbolOf,
  type Evidence,
  type Finding,
  type SweepData,
} from '../web/lib/findings.js'

/**
 * The landing's numbers, offline.
 *
 * The landing paints a handful of values in the streak colour, which on this site means "re-fetched
 * from chain state and byte-compared". So every one of them is checked here against what the board
 * itself printed when the sweep produced it: the finding's own title and note, never a constant
 * copied into this file. The committed board changes with every sweep, and these tests should keep
 * passing on the next one.
 */

/** The copy the deployed site falls back to (web/scripts/prebuild.mjs writes it). */
const BOARD = resolve('web/data/findings.json')

const SHARE_COUNT = 'SHARE_COUNT_MISREAD_RISK'

function cited(f: Finding, call: string): Evidence | undefined {
  return f.evidence.find((e) => e.call === call)
}

/** What the sweep printed for this finding (src/sweep/detect.ts), parsed back out of its own text. */
function printed(f: Finding) {
  const note = /totalSupply raw (\d+\.\d{4}) tokens vs (\d+\.\d{4}) share-equivalents/.exec(f.impact.note)
  const mult = /\(multiplier (\d+\.\d{9})x\)/.exec(f.title)
  return { tokens: note?.[1], shares: note?.[2], multiplier: mult?.[1] }
}

/** The wall's own "largest gap on the board" (web/app/wall/page.tsx), as the fallback ranking. */
function worstShareCount(findings: Finding[]): Finding | undefined {
  return findings
    .filter((f) => f.defectClass === SHARE_COUNT)
    .sort((a, b) => (b.impact.percent ?? 0) - (a.impact.percent ?? 0))[0]
}

function board(over: Partial<SweepData> = {}): SweepData {
  return {
    blockNumber: '100',
    observedAt: '2026-09-23T20:00:00.000Z',
    assetsScanned: 1,
    feedsAvailable: 0,
    marketClosed: false,
    cohort: { size: 0, stale: 0, clockHint: false },
    findings: [],
    rejected: [],
    chainNotes: [],
    stats: {},
    errors: [],
    ...over,
  }
}

/** A uint256 return, ABI-encoded as the RPC returns it. */
const word = (n: bigint) => `0x${n.toString(16).padStart(64, '0')}`
const E18 = 10n ** 18n

// Synthetic contracts. A real token here would read as a claim about it.
const TOKEN_A = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const TOKEN_B = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'

function shareCount(
  symbol: string,
  token: string,
  opts: {
    multiplier: bigint
    supply: bigint
    percent?: number
    note?: string
    block?: string
    supplyBlock?: string
    multRaw?: string
    supplyRaw?: string
    verification?: Partial<Finding['verification']>
  },
): Finding {
  const block = opts.block ?? '100'
  const ev = (call: string, rawReturn: string, blockNumber: string): Evidence => ({
    claim: `${call} == …`,
    chainId: 4663,
    contract: token,
    call,
    rawReturn,
    blockNumber,
    explorerUrl: `https://robinhoodchain.blockscout.com/address/${token}`,
    observedAt: '2026-09-23T20:00:00.000Z',
  })
  return {
    id: `${symbol}-share-count`,
    defectClass: SHARE_COUNT,
    severity: 'critical',
    subject: `${symbol} (${token})`,
    title: `${symbol}: reading balanceOf() as shares understates`,
    statement: 's',
    impact: { percent: opts.percent ?? 50, note: opts.note ?? 'n' },
    evidence: [
      ev('uiMultiplier()', opts.multRaw ?? word(opts.multiplier), block),
      ev('totalSupply()', opts.supplyRaw ?? word(opts.supply), opts.supplyBlock ?? block),
    ],
    methodologyVersion: 'assay-rh-v0.4.0',
    detectedAt: '2026-09-23T20:00:00.000Z',
    verification: { checked: 2, reproduced: 2, mismatched: 0, pruned: 0, verifiedAt: 'x', ...opts.verification },
  }
}

describe('landingFacts on the committed board', () => {
  const d = loadSweep([BOARD])
  const facts = landingFacts(d)

  it('reads a real board with share-count findings (or these tests prove nothing)', () => {
    expect(existsSync(BOARD)).toBe(true)
    expect(d.findings.filter((f) => f.defectClass === SHARE_COUNT).length).toBeGreaterThan(0)
  })

  it('counts what the wall counts', () => {
    expect(facts.source).toBe('committed')
    expect(facts.blockNumber).toBe(d.blockNumber)
    expect(facts.observedAt).toBe(d.observedAt)
    expect(new Date(facts.staleAfter).getTime() - new Date(d.observedAt).getTime()).toBe(SNAPSHOT_FRESH_MS)
    expect(facts.findings).toBe(d.findings.length)
    expect(facts.critical).toBe(d.findings.filter((f) => f.severity === 'critical').length)
    expect(facts.citations).toEqual({
      ok: d.findings.reduce((n, f) => n + f.verification.reproduced, 0),
      total: d.findings.reduce((n, f) => n + f.verification.checked, 0),
    })
    expect(facts.citations.ok).toBeLessThanOrEqual(facts.citations.total)
    expect(facts.withheld).toBe(d.rejected.length)
    expect(facts.mismatched).toBe(d.rejected.filter((r) => r.reason === 'mismatch').length)
    expect(facts.divergent).toBe(divergentTokens(d).length)
  })

  it('strikes the preferred finding when the board has it, else the wall\'s worst share-count finding', () => {
    const expected = d.findings.find((f) => f.id === PREFERRED_BAR_FINDING) ?? worstShareCount(d.findings)
    expect(facts.bar?.findingId).toBe(expected?.id)
  })

  it('carries the cited bytes and the finding\'s own printed figures, nothing re-derived by hand', () => {
    const bar = facts.bar!
    const f = d.findings.find((x) => x.id === bar.findingId)!
    const mult = cited(f, 'uiMultiplier()')!
    const supply = cited(f, 'totalSupply()')!
    const p = printed(f)

    expect(bar.symbol).toBe(symbolOf(f.subject))
    expect(bar.token).toBe(supply.contract)
    expect(bar.block).toBe(supply.blockNumber)
    expect(bar.block).toBe(mult.blockNumber)
    expect(bar.supply.raw).toBe(supply.rawReturn)
    expect(bar.multiplier.raw).toBe(mult.rawReturn)
    expect(bar.supply.tokens).toBe(p.tokens)
    expect(bar.shares).toBe(p.shares)
    expect(bar.multiplier.value).toBe(p.multiplier)
    expect(bar.verified).toEqual({ checked: f.verification.checked, reproduced: f.verification.reproduced })
    expect(bar.verified.reproduced).toBe(bar.verified.checked)

    const integer = /^(\d+)\.0{9}$/.exec(p.multiplier ?? '')
    const n = integer ? Number(integer[1]) : null
    expect(bar.segments).toBe(n !== null && n >= 2 && n <= 8 ? n : null)
  })

  it('decodes every share-count finding on the board to the figures the sweep printed for it', () => {
    const all = d.findings.filter((f) => f.defectClass === SHARE_COUNT && cited(f, 'totalSupply()'))
    expect(all.length).toBeGreaterThan(0)
    for (const f of all) {
      const bar = landingFacts(board({ findings: [f] })).bar
      const p = printed(f)
      expect(bar, f.id).not.toBeNull()
      expect(bar!.supply.tokens, f.id).toBe(p.tokens)
      expect(bar!.shares, f.id).toBe(p.shares)
      expect(bar!.multiplier.value, f.id).toBe(p.multiplier)
    }
  })

  it('is pure: the board is not modified and the same board gives the same facts', () => {
    const before = JSON.stringify(d)
    expect(landingFacts(d)).toEqual(facts)
    expect(JSON.stringify(d)).toBe(before)
  })
})

describe('landingFacts on synthetic boards', () => {
  it('an empty board has no bar and zero counts, and is not called live', () => {
    const f = landingFacts(board())
    expect(f.bar).toBeNull()
    expect(f).toMatchObject({ source: 'committed', findings: 0, critical: 0, withheld: 0, mismatched: 0, divergent: 0 })
    expect(f.citations).toEqual({ ok: 0, total: 0 })
  })

  it('passes the loader\'s source through, and never upgrades an unlabelled board to live', () => {
    expect(landingFacts({ ...board(), source: 'live' }).source).toBe('live')
    expect(landingFacts({ ...board(), source: 'committed' }).source).toBe('committed')
    expect(landingFacts(board()).source).toBe('committed')
  })

  it('treats an unreadable timestamp as already stale', () => {
    expect(landingFacts(board({ observedAt: 'not a date' })).staleAfter).toBe(new Date(0).toISOString())
  })

  it('without CRWD, strikes the largest share-count gap, as the wall ranks it', () => {
    const small = shareCount('AAA', TOKEN_A, { multiplier: 2n * E18, supply: 10n * E18, percent: 1 })
    const large = shareCount('BBB', TOKEN_B, { multiplier: 3n * E18, supply: 7n * E18, percent: 66.6667 })
    const other: Finding = { ...small, id: 'AAA-cross', defectClass: 'CROSS_SURFACE_PRICE_MIX', impact: { percent: 99, note: 'n' } }
    const bar = landingFacts(board({ findings: [small, other, large] })).bar!
    expect(bar.findingId).toBe('BBB-share-count')
    expect(bar).toMatchObject({ symbol: 'BBB', token: TOKEN_B, block: '100', segments: 3 })
    expect(bar.supply.tokens).toBe('7.0000')
    expect(bar.multiplier.value).toBe('3.000000000')
    expect(bar.shares).toBe('21.0000')
  })

  it('prefers CRWD even when another finding has a larger gap', () => {
    const crwd = shareCount('CRWD', TOKEN_A, { multiplier: 4n * E18, supply: 1n * E18, percent: 75 })
    const bigger = shareCount('BBB', TOKEN_B, { multiplier: 8n * E18, supply: 1n * E18, percent: 87.5 })
    expect(landingFacts(board({ findings: [bigger, crwd] })).bar?.findingId).toBe(PREFERRED_BAR_FINDING)
  })

  it('keeps the bar whole for a non-integer multiplier, and for integers outside 2..8', () => {
    const f = (m: bigint) =>
      landingFacts(board({ findings: [shareCount('AAA', TOKEN_A, { multiplier: m, supply: 2n * E18 })] })).bar!
    const half = f(1_500_000_000_000_000_000n)
    expect(half.segments).toBeNull()
    expect(half.multiplier.value).toBe('1.500000000')
    expect(half.shares).toBe('3.0000')
    expect(f(10n * E18).segments).toBeNull()
    expect(f(2n * E18).segments).toBe(2)
    expect(f(8n * E18).segments).toBe(8)
    // A reverse split moves the multiplier below 1; the bar still reads, whole.
    const reverse = f(250_000_000_000_000_000n)
    expect(reverse.segments).toBeNull()
    expect(reverse.multiplier.value).toBe('0.250000000')
    expect(reverse.shares).toBe('0.5000')
  })

  it('rounds the multiplier to 9 dp and truncates amounts to 4 dp, as the sweep prints them', () => {
    // 1.0000000005 rounds up at the 9th place; 1.23456789 tokens truncates to 1.2345.
    const bar = landingFacts(
      board({
        findings: [shareCount('AAA', TOKEN_A, { multiplier: 1_000_000_000_500_000_000n, supply: 1_234_567_890_000_000_000n })],
      }),
    ).bar!
    expect(bar.multiplier.value).toBe('1.000000001')
    expect(bar.supply.tokens).toBe('1.2345')
    expect(bar.shares).toBe('1.2345')
  })

  it('refuses malformed return bytes and falls through to the next candidate', () => {
    for (const bad of ['0x', '0x1234', `0x${'g'.repeat(64)}`, `${'0'.repeat(66)}`, `0x${'0'.repeat(65)}`]) {
      const crwd = shareCount('CRWD', TOKEN_A, { multiplier: 4n * E18, supply: E18, multRaw: bad })
      expect(landingFacts(board({ findings: [crwd] })).bar, bad).toBeNull()
      const next = shareCount('BBB', TOKEN_B, { multiplier: 2n * E18, supply: E18, percent: 50 })
      expect(landingFacts(board({ findings: [crwd, next] })).bar?.findingId, bad).toBe('BBB-share-count')
    }
    const badSupply = shareCount('CRWD', TOKEN_A, { multiplier: 4n * E18, supply: E18, supplyRaw: '0xzz' })
    expect(landingFacts(board({ findings: [badSupply] })).bar).toBeNull()
  })

  it('refuses a finding whose citations did not all re-fetch byte-for-byte', () => {
    const f = shareCount('CRWD', TOKEN_A, { multiplier: 4n * E18, supply: E18, verification: { checked: 2, reproduced: 1 } })
    expect(landingFacts(board({ findings: [f] })).bar).toBeNull()
    const none = shareCount('CRWD', TOKEN_A, { multiplier: 4n * E18, supply: E18, verification: { checked: 0, reproduced: 0 } })
    expect(landingFacts(board({ findings: [none] })).bar).toBeNull()
  })

  it('refuses citations read at different blocks, a missing supply citation and a zero multiplier', () => {
    const split = shareCount('CRWD', TOKEN_A, { multiplier: 4n * E18, supply: E18, supplyBlock: '101' })
    expect(landingFacts(board({ findings: [split] })).bar).toBeNull()
    const noSupply = shareCount('CRWD', TOKEN_A, { multiplier: 4n * E18, supply: E18 })
    noSupply.evidence = noSupply.evidence.filter((e) => e.call !== 'totalSupply()')
    expect(landingFacts(board({ findings: [noSupply] })).bar).toBeNull()
    expect(landingFacts(board({ findings: [shareCount('CRWD', TOKEN_A, { multiplier: 0n, supply: E18 })] })).bar).toBeNull()
  })

  it('takes the token\'s decimals from the finding\'s own note, and refuses a note nothing reproduces', () => {
    // 6 decimals: 12_345_678 base units is 12.3456 tokens, which only a scale of 1e6 prints.
    const six = shareCount('AAA', TOKEN_A, {
      multiplier: 2n * E18,
      supply: 12_345_678n,
      note: 'totalSupply raw 12.3456 tokens vs 24.6913 share-equivalents (delta 12.3456).',
    })
    const bar = landingFacts(board({ findings: [six] })).bar!
    expect(bar.supply.tokens).toBe('12.3456')
    expect(bar.shares).toBe('24.6913')
    const contradicted = shareCount('AAA', TOKEN_A, {
      multiplier: 2n * E18,
      supply: 12_345_678n,
      note: 'totalSupply raw 99.0000 tokens vs 198.0000 share-equivalents.',
    })
    expect(landingFacts(board({ findings: [contradicted] })).bar).toBeNull()
  })

  it('counts withheld findings, and mismatches among them, from the rejected list', () => {
    const rejected: SweepData['rejected'] = [
      { reason: 'mismatch', detail: 'd', finding: { id: 'a', subject: 's' } },
      { reason: 'unverifiable_here', detail: 'd', finding: { id: 'b', subject: 's' } },
      { reason: 'mismatch', detail: 'd', finding: { id: 'c', subject: 's' } },
    ]
    expect(landingFacts(board({ rejected }))).toMatchObject({ withheld: 3, mismatched: 2 })
  })
})

/**
 * No client component may import a module that reads the filesystem.
 *
 * web/lib/findings.ts imports node:fs, and a 'use client' file that imports it by value drags it
 * into the browser bundle: the build fails, or worse, a bundler shim makes the fallback board
 * silently empty. Client files take `import type` from these modules and receive the values as
 * props from a server component. `next build` catches the direct case; this also catches it on a
 * laptop, and catches the indirect one (a lib module that itself imports findings by value).
 */
describe('client components never import server-only lib modules', () => {
  const WEB = resolve('web')
  const LIB = join(WEB, 'lib')
  const APP = join(WEB, 'app')

  function walk(dir: string): string[] {
    const out: string[] = []
    for (const name of readdirSync(dir)) {
      const p = join(dir, name)
      if (statSync(p).isDirectory()) out.push(...walk(p))
      else if (/\.(ts|tsx|js|jsx|mjs)$/.test(name)) out.push(p)
    }
    return out
  }

  type Import = { spec: string; typeOnly: boolean }

  /** Static imports and re-exports (with their type-only flag) and dynamic imports. */
  function importsOf(src: string): Import[] {
    const out: Import[] = []
    const stat = /(?:^|[;\n])\s*(import|export)\s+(type\s+)?(?:[^'";]*?\s+from\s+)?['"]([^'"]+)['"]/g
    for (const m of src.matchAll(stat)) out.push({ spec: m[3]!, typeOnly: !!m[2] })
    for (const m of src.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g)) out.push({ spec: m[1]!, typeOnly: false })
    return out
  }

  function isClient(src: string): boolean {
    const body = src.replace(/^﻿/, '').replace(/^(?:\s|\/\/[^\n]*\n|\/\*[\s\S]*?\*\/)*/, '')
    return /^['"]use client['"]/.test(body)
  }

  /** The web/lib module an import points at, by name without extension, or null. */
  function libModule(spec: string, from: string): string | null {
    let abs: string
    if (spec.startsWith('@/')) abs = join(WEB, spec.slice(2))
    else if (spec.startsWith('.')) abs = resolve(dirname(from), spec)
    else return null
    const rel = relative(LIB, abs)
    if (rel.startsWith('..') || rel.includes('/')) return null
    return rel.replace(/\.(ts|tsx|js|mjs)$/, '')
  }

  /**
   * findings (node:fs), landing (imports findings) and feeds (server fetch with revalidate), plus
   * any lib module that reaches node:* or one of those by value. Recomputed from the source, so a
   * new server-only module is covered the day it is written.
   */
  function serverOnly(): Set<string> {
    const mods = new Map<string, Import[]>()
    for (const p of walk(LIB)) mods.set(relative(LIB, p).replace(/\.(ts|tsx|js|mjs)$/, ''), importsOf(readFileSync(p, 'utf8')))
    const out = new Set(['findings', 'landing', 'feeds'])
    for (const [name, imps] of mods) if (imps.some((i) => !i.typeOnly && i.spec.startsWith('node:'))) out.add(name)
    let grew = true
    while (grew) {
      grew = false
      for (const [name, imps] of mods) {
        if (out.has(name)) continue
        const file = join(LIB, `${name}.ts`)
        if (imps.some((i) => !i.typeOnly && out.has(libModule(i.spec, file) ?? ''))) {
          out.add(name)
          grew = true
        }
      }
    }
    return out
  }

  function violations(src: string, file: string, server: Set<string>): string[] {
    if (!isClient(src)) return []
    return importsOf(src)
      .filter((i) => !i.typeOnly && server.has(libModule(i.spec, file) ?? ''))
      .map((i) => `${relative(WEB, file)} imports '${i.spec}' by value`)
  }

  const server = serverOnly()

  it('knows which lib modules are server-only', () => {
    for (const m of ['findings', 'landing', 'feeds', 'present']) expect(server.has(m), m).toBe(true)
    for (const m of ['site', 'guard', 'endpoints']) expect(server.has(m), m).toBe(false)
  })

  it('catches a value import and allows a type import (the guard guards itself)', () => {
    const file = join(APP, '_landing', 'x.tsx')
    expect(violations(`'use client'\nimport { loadSweep } from '@/lib/findings'\n`, file, server)).toHaveLength(1)
    expect(violations(`"use client";\nimport {\n  landingFacts,\n} from '../../lib/landing'\n`, file, server)).toHaveLength(1)
    expect(violations(`'use client'\nimport { type LandingFacts } from '@/lib/landing'\n`, file, server)).toHaveLength(1)
    expect(violations(`'use client'\nconst m = () => import('@/lib/feeds')\n`, file, server)).toHaveLength(1)
    expect(violations(`// note\n'use client'\nexport { loadSweep } from '@/lib/findings'\n`, file, server)).toHaveLength(1)
    expect(violations(`'use client'\nimport type { LandingFacts } from '@/lib/landing'\n`, file, server)).toHaveLength(0)
    expect(violations(`import { loadSweep } from '@/lib/findings'\n`, file, server)).toHaveLength(0)
    expect(violations(`'use client'\nimport { SITE } from '@/lib/site'\n`, file, server)).toHaveLength(0)
  })

  it('finds no violation under web/app', () => {
    const files = walk(APP)
    const clients = files.filter((p) => isClient(readFileSync(p, 'utf8')))
    // The scan must see the client files that exist today, or it is checking nothing.
    expect(clients.map((p) => relative(WEB, p))).toEqual(
      expect.arrayContaining(['app/_components/check-wallet.tsx', 'app/_motion/motion-provider.tsx']),
    )
    const found = files.flatMap((p) => violations(readFileSync(p, 'utf8'), p, server))
    expect(found).toEqual([])
  })
})
