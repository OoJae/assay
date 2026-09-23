import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { keccak256, toBytes } from 'viem'
import { NAMED_INTEGRATOR_CLASS } from '../src/lib/redact.js'
import { privateSnapshotPath } from '../src/sweep/guard.js'

/**
 * Nothing committed names an integrator.
 *
 * data/findings.json and web/data/findings.json carried 25 INTEGRATOR_NOT_MULTIPLIER_AWARE
 * findings over 17 full contract addresses while the wall withheld the class, so one
 * raw.githubusercontent.com request undid the withholding. The sweep now redacts at the source,
 * but a hand-run, a copied file or a new artifact could put the names back, and this is the
 * check that notices. It reads the working tree of every TRACKED file, so it also catches a
 * modification that has not been committed yet.
 *
 * A file deleted in the working tree but not yet staged is still listed by `git ls-files`; it
 * is skipped rather than failing with ENOENT, since there is nothing left in it to publish.
 */

const listed = (...args: string[]) =>
  execFileSync('git', ['ls-files', '-z', ...args], { encoding: 'utf8' })
    .split('\0')
    .filter((p) => p && existsSync(p) && statSync(p).isFile())

const tracked = listed('--', 'data', 'web').filter((p) => p.endsWith('.json'))

/** Tracked files plus untracked ones that are not ignored: everything the next `git add -A` publishes. */
const publishable = listed('--cached', '--others', '--exclude-standard')

type Row = { defectClass?: string } | null | undefined

function namedRows(doc: unknown): Row[] {
  const d = doc as { findings?: unknown; rejected?: unknown }
  const findings = Array.isArray(d?.findings) ? (d.findings as Row[]) : []
  const rejected = Array.isArray(d?.rejected)
    ? (d.rejected as Array<{ finding?: Row }>).map((r) => r?.finding)
    : []
  return [...findings, ...rejected].filter((f) => f?.defectClass === NAMED_INTEGRATOR_CLASS)
}

describe('committed data names no integrator', () => {
  it('finds the tracked JSON to check', () => {
    expect(tracked).toContain('data/findings.json')
    expect(tracked).toContain('web/data/findings.json')
  })

  for (const path of tracked) {
    it(`${path} has no ${NAMED_INTEGRATOR_CLASS} row in findings or rejected`, () => {
      const text = readFileSync(path, 'utf8')
      let doc: unknown
      try {
        doc = JSON.parse(text)
      } catch {
        // tsconfig-style JSON with comments is not a findings artifact; a file that cannot be
        // parsed must still not mention the class at all.
        expect(text).not.toContain(NAMED_INTEGRATOR_CLASS)
        return
      }
      expect(namedRows(doc)).toEqual([])
    })
  }

  it('the committed boards say how many named findings they withheld', () => {
    for (const path of ['data/findings.json', 'web/data/findings.json']) {
      const d = JSON.parse(readFileSync(path, 'utf8')) as { withheld?: { namedIntegrators?: number } }
      expect(typeof d.withheld?.namedIntegrators).toBe('number')
    }
  })
})

/**
 * The 17 contracts the snapshot of 2026-09-22 named (commits 47f1166 and 2352a60), as keccak256 of
 * the lowercase address text, so this file does not name them itself.
 *
 * The row check above passed while the names sat in other shapes: a settlement row reading
 * "NOT_AWARE for 0xfab5…", a fork script's `NOT_AWARE` constant, the paid audit's default target,
 * a test fixture copying a real named row, and the v4 PoolManager (11 of the 17 are pools, pool
 * managers or custody, which decision 3 says are never named) as the example holder on the agent
 * card and in the npm README. So every publishable file is scanned, whatever its extension.
 */
const NAMED_ADDRESS_HASHES = new Set([
  '0x2c107f7629de1e8ee9ed0b54e421a3306f7ade1ac7fdeb1c403811b6edfbabc1',
  '0xe6a477c004f4678d786a79459c84c256e9832545fa3e427dfbe97d0449a28219',
  '0xb1c91148915e761db4eec68bee3e520e927c063edadc46c82133820a207e084b',
  '0x00c2d554cd0521e4935b2ee3eb07fba1aa97f4dbf89b7b6531616dc24ec8d9b8',
  '0x7e943e93ae23fbd06d4f47ccadf3e64f46a9dffb524d8f3ddf7a73266b81a667',
  '0xacb4df30af01ca9f2b0d5d9a0d5e020889afb9e14fed81dcc4923ad3af529763',
  '0x049cd2b5efa382dea7bd396008b56049246335ce3dad5bb928f11abafad70f60',
  '0x35d83476c53b7604a27318961fd564884c6530b8c243269eaff0840834df5540',
  '0x0dcee0190b73239f3a236b9e3b4318021cee1d5aee1cfef5422a27fccb90616b',
  '0xf0161598c675569927708bea64fefa468ace084d5fd16fd51542c4db2fd03045',
  '0x48346774ce79b8401c52871866a702f0ded9b6f5714e9653d61dbac8005496f8',
  '0x9749ccf63e51f88017179334cf497ff8093852f00886a744767e42965eb703b1',
  '0x9944295a21886d010ee133f46d29048cba3c5cff4acde43aebc911405d16a980',
  '0x260900129c1a059887f60d80a6911b741462a2944f2816a290f5c9e1568f0c91',
  '0xb96ffe47f4d0690de30382f2605f349b0899e6cdae55fb2b55223ac95d284ba1',
  '0xe05acab1e86c6387df0967c5affedcd4c268b62c5d2d0d9dc1c1da72e837e995',
  '0x06b46c9e7ae73e8d80108ea6f34ca08eafb5f68a6806e42d384c919fcf48af49',
])

/** The same 17, as the 8-hex-digit prefix a finding id (`integrator-xxxxxxxx-SYM`) or title (`0xxxxxxxxx…`) shows. */
const NAMED_PREFIX_HASHES = new Set([
  '0x6721259d6f4deddac153b482782703ea1af29cf6e509956117003bb7a2cdfdf9',
  '0x3adffbc2d0320b48ba9a4b45302f377ffeb815315aee138079d4fbcb39e2280d',
  '0xe303fef9c17d694dc2c86d94d1b7d0e8da496d48ddd49b7e3c5d0b6ab3a9c85d',
  '0xb69179ad6d625c17f331ef79d3ca0e9e5b80d345f05afb52c980a69c250e328e',
  '0x4efb6d08f57a7fe3972cea1a22457bf634db9c22e080a89c451c86aba39e0495',
  '0x81e63b2b71dd995798dc6d41f5f342302cac4fc0872cc4eaa62ada4d898dcdf5',
  '0x90e155efcf64a6f1a9febf60aa220e6003d72803e5cd4e7560d6b09b12129ccb',
  '0xd3dd219958de4988a812efc08b6240278423a831b8dc1c2b5602e25e4425d2af',
  '0xeeb093947dd14636ac41cf035e6e9c0dd227d52a399677e105949707ff6e7694',
  '0x9c53c74a4a93afa3fd94082d34345c9fbed50b4dac48ca6c85894c295dea2af2',
  '0xd9494c0f09f00702ba09f4fdf976d9e41222cd90a04c0a63c579f57bcbd647ad',
  '0x2a2ee2e06658244d6b28e9020d369b640594a261eb553910b56a06fd5f02c402',
  '0x1a700b312a8c9fd67e3d23b3935ed2d23b0a38a3ed4013b8421cc2974515b3ba',
  '0x36b6182c83a7665189e7a67b948f949dc0c8b2b83d77082cae40b94d2bb6b552',
  '0x03257ebe9138d5d40d22156b1c08233bb3554eea1dddc5150c8bb0eab7f84125',
  '0x263c343c5d479348aca898dcae09d6fe3384477907fc02a250b08f2285dd6fdd',
  '0xb1b624e62cfe87931ae6d509e9986147ae7f4776efe91cb1007bf68d49c1c6cb',
])

const hash = (text: string) => keccak256(toBytes(text.toLowerCase()))

/**
 * Plus whatever a local sweep has named since. The private snapshot is gitignored and exists only
 * where a sweep ran; where it does, every contract it names is held to the same rule.
 */
function privatelyNamed(): Set<string> {
  const path = privateSnapshotPath('data/findings.json')
  if (!existsSync(path)) return new Set()
  const out = new Set<string>()
  for (const row of namedRows(JSON.parse(readFileSync(path, 'utf8')))) {
    const m = /0x[0-9a-fA-F]{40}/.exec((row as { subject?: string }).subject ?? '')
    if (m) out.add(hash(m[0]))
  }
  return out
}

describe('no publishable file names a contract the snapshot named', () => {
  const named = new Set([...NAMED_ADDRESS_HASHES, ...privatelyNamed()])

  it('scans the files the next commit would publish', () => {
    expect(publishable).toContain('data/settlements.json')
    expect(publishable).toContain('src/lib/endpoints.ts')
    expect(publishable.length).toBeGreaterThan(100)
  })

  it('the hash lists are the 17 contracts and their id prefixes', () => {
    expect(NAMED_ADDRESS_HASHES.size).toBe(17)
    expect(NAMED_PREFIX_HASHES.size).toBe(17)
  })

  it('no full address, id prefix or title prefix of a named contract, in any file', () => {
    const hits: string[] = []
    for (const path of publishable) {
      const text = readFileSync(path, 'utf8')
      for (const m of text.matchAll(/0x[0-9a-fA-F]{40}/g)) {
        if (named.has(hash(m[0]))) hits.push(`${path}: full address at offset ${m.index}`)
      }
      for (const m of text.matchAll(/integrator-([0-9a-f]{8})-|0x([0-9a-fA-F]{8})(?:…|\.\.\.)/g)) {
        if (NAMED_PREFIX_HASHES.has(hash(m[1] ?? m[2]!))) hits.push(`${path}: prefix at offset ${m.index}`)
      }
    }
    expect(hits).toEqual([])
  })

  it('no verdict label written next to a full address', () => {
    // "NOT_AWARE for 0x…" is how the settlement row named one; a constant named NOT_AWARE holding
    // an address is how the fork script did.
    const hits = publishable.filter((path) =>
      /NOT_AWARE[^\n]{0,24}0x[0-9a-fA-F]{40}/.test(readFileSync(path, 'utf8')),
    )
    expect(hits).toEqual([])
  })
})
