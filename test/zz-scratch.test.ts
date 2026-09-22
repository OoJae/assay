import { describe, it, expect, vi } from 'vitest'
import { appendFileSync, writeFileSync } from 'node:fs'
const OUT='/tmp/scratch-out.txt'
const log=(...a:any[])=>appendFileSync(OUT, a.map(x=>typeof x==='string'?x:JSON.stringify(x)).join(' ')+'\n')
import { toFunctionSelector, encodeAbiParameters, parseAbiParameters, pad, toHex } from 'viem'

const SEL = {
  ui: toFunctionSelector('uiMultiplier()'),
  nu: toFunctionSelector('newUIMultiplier()'),
  ef: toFunctionSelector('effectiveAt()'),
  op: toFunctionSelector('oraclePaused()'),
  ts: toFunctionSelector('totalSupply()'),
  dc: toFunctionSelector('decimals()'),
  lrd: toFunctionSelector('latestRoundData()'),
}

const NOW = 1_700_000_000
const TOKEN = '0xea72Ecca2d0f6bFA1394DBBCff85b52CD4233931'
const TESTFEED = '0xfeed000000000000000000000000000000000001'

function word(v: bigint) { return pad(toHex(v), { size: 32 }) }
function lrd(updatedAt: bigint, answer = 12345678n) {
  return encodeAbiParameters(parseAbiParameters('uint80,int256,uint256,uint256,uint80'),
    [1n, answer, updatedAt, updatedAt, 1n])
}

// behaviour switches the fake RPC reads
const cfg: any = { cryptoFeed: false, totalSupplyFails: false, feedDecimalsFails: false, testFeedStale: true, cohortStale: 0, cohortReadFails: 0, cryptoStale: false }

function makeClient() {
  return {
    getBlockNumber: async () => 1000n,
    getBlock: async () => ({ timestamp: BigInt(NOW) }),
    request: async (args: any) => {
      const [{ to, data }] = args.params
      const sel = (data as string).slice(0, 10)
      const addr = (to as string).toLowerCase()
      if (addr === TOKEN.toLowerCase()) {
        if (sel === SEL.ui) return word(4n * 10n ** 18n)
        if (sel === SEL.ts) { if (cfg.totalSupplyFails) throw new Error('fetch failed'); return word(19506750000000000000n) }
        if (sel === SEL.dc) return word(18n)
        if (sel === SEL.op) return word(0n)
        if (sel === SEL.nu) return word(4n * 10n ** 18n)
        if (sel === SEL.ef) return word(0n)
      }
      // cohort feeds 0xc0...NN
      if (addr.startsWith('0xc0')) {
        const idx = parseInt(addr.slice(-4), 16)
        if (idx < cfg.cohortReadFails) throw new Error('fetch failed')
        if (sel === SEL.dc) return word(8n)
        if (sel === SEL.lrd) return lrd(BigInt(NOW - (idx < cfg.cohortStale ? 200_000 : 10)))
      }
      if (addr === TESTFEED) {
        if (sel === SEL.dc) { if (cfg.feedDecimalsFails) throw new Error('execution reverted'); return word(8n) }
        if (sel === SEL.lrd) return lrd(BigInt(NOW - (cfg.testFeedStale ? 200_000 : 10)))
      }
      throw new Error('execution reverted')
    },
  }
}

vi.mock('../src/lib/chains.js', () => ({ rhClient: makeClient() }))

const mkFeed = (name: string, proxy: string, equities: boolean) => ({
  name, proxyAddress: proxy, decimals: 8, heartbeat: 86400,
  docs: { marketHours: equities ? 'us_equities_24/5' : 'Crypto' },
})

function feeds() {
  const cohort = Array.from({ length: 34 }, (_, i) =>
    mkFeed(`Robinhood C${i}`, '0xc0' + String(i).padStart(2, '0').padEnd(36, '0') + i.toString(16).padStart(2, '0'), true))
  return [...cohort, mkFeed('Robinhood TEST', TESTFEED, !cfg.cryptoFeed)]
}

vi.mock('../src/lib/sources.js', async (orig) => {
  const real: any = await orig()
  return {
    ...real,
    fetchRhAssets: async () => [{
      id: 'x', tokenSymbol: 'TEST', tokenName: 'Test', tokenDecimals: 18,
      currentMultiplier: '4', pendingMultiplier: '', status: 'active',
      deployments: [{ contractAddress: TOKEN, chainId: 4663 }],
    }],
    fetchChainlinkFeeds: async () => feeds(),
    fetchRhUnderlyingPrice: async () => null,
    feedForSymbol: (fs: any[], sym: string) => fs.find((f) => f.name.includes('TEST')) ?? null,
  }
})

async function freshSweep() {
  vi.resetModules()
  const m = await import('../src/sweep/detect.js')
  return m.sweep
}

describe('scratch', () => {
  writeFileSync(OUT,'')
  it('A: feed decimals() OK -> stale finding published', async () => {
    cfg.feedDecimalsFails = false
    const sweep = await freshSweep()
    const r = await sweep({})
    log('A cohort', r.cohort)
    log('A stats', r.stats, 'errors', r.errors, 'rejected', r.rejected.length)
    log('A findings', r.findings.map((f: any) => f.defectClass + ' / ' + f.severity + ' / ' + f.title))
    expect(r.stats.staleFeeds).toBe(1)
  })

  it('B: feed decimals() FAILS -> staleness silently vanishes', async () => {
    cfg.feedDecimalsFails = true
    const sweep = await freshSweep()
    const r = await sweep({})
    log('B cohort', r.cohort)
    log('B stats', r.stats, 'errors', r.errors, 'rejected', r.rejected.length)
    log('B findings', r.findings.map((f: any) => f.defectClass + ' / ' + f.title))
  })
  it('C: crypto feed stale + cohort quorum FAILED -> asserts "NOT a market-wide closure"', async () => {
    cfg.feedDecimalsFails = false
    cfg.cryptoFeed = true
    cfg.cohortReadFails = 30   // only 4 of 34 cohort feeds readable -> quorum fails
    cfg.cohortStale = 34       // every readable one is stale
    const sweep = await freshSweep()
    const r = await sweep({})
    log('C cohort', r.cohort)
    log('C stats', r.stats)
    for (const f of r.findings as any[]) log('C ->', f.defectClass, '|', f.severity, '|', f.statement)
  })

  it('D: totalSupply() read fails -> whole finding rejected as MISMATCH', async () => {
    cfg.feedDecimalsFails = false
    cfg.cryptoFeed = false
    cfg.cohortReadFails = 0
    cfg.cohortStale = 0
    cfg.totalSupplyFails = true
    const sweep = await freshSweep()
    const r = await sweep({})
    log('D published', r.findings.length, 'rejected', JSON.stringify(r.rejected.map((x: any) => ({ id: x.finding.id, reason: x.reason, detail: x.detail }))))
    log('D errors', r.errors)
    cfg.totalSupplyFails = false
  })
})
