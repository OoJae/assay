import { describe, it, expect, vi, beforeEach } from 'vitest'
import { keccak256, toFunctionSelector } from 'viem'

/**
 * The integrator classifier, offline.
 *
 * This module is the only part of ASSAY that names a third-party contract, so the property under
 * test is not "does it find things" — it is "does it ever accuse a contract that is fine". The
 * proxy cases are the whole point: a proxy's own bytecode is a delegatecall stub containing no
 * application selectors, so a naive selector test reports every proxy on the chain as NOT_AWARE.
 *
 * Measured on mainnet before these tests existed: the Robinhood Stock Tokens are themselves EIP-1967
 * BEACON proxies. SGOV's address is a 283-byte stub. Without beacon resolution the classifier called
 * the very tokens that implement uiMultiplier() "not multiplier aware" — the exact libel this
 * project says is the most damaging error it can make.
 */

const UIMULT = toFunctionSelector('function uiMultiplier() view returns (uint256)')
const IMPL_SEL = '0x5c60da1b'
const IMPL_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc'
const BEACON_SLOT = '0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50'

const big = (sel?: string) => '0x' + (sel ? sel.slice(2) : '') + 'ab'.repeat(3000)
const zero = '0x' + '0'.repeat(64)
const word = (addr: string) => '0x' + '0'.repeat(24) + addr.slice(2)

const A = {
  plainAware: '0x1111111111111111111111111111111111111111',
  plainUnaware: '0x2222222222222222222222222222222222222222',
  stub: '0x3333333333333333333333333333333333333333',
  eoa: '0x4444444444444444444444444444444444444444',
  beaconProxy: '0x5555555555555555555555555555555555555555',
  beacon: '0x6666666666666666666666666666666666666666',
  beaconImpl: '0x7777777777777777777777777777777777777777',
  slotProxy: '0x8888888888888888888888888888888888888888',
  slotImpl: '0x9999999999999999999999999999999999999999',
  deadBeaconProxy: '0xaaaa111111111111111111111111111111111111',
  deadBeacon: '0xbbbb111111111111111111111111111111111111',
} as const

const state: { codes: Record<string, string>; slots: Record<string, Record<string, string>>; beaconAnswers: Record<string, string> } = {
  codes: {}, slots: {}, beaconAnswers: {},
}

vi.mock('../src/lib/chains.js', () => ({
  rhClient: {
    getBlockNumber: async () => 100n,
    readContract: async () => 0n,
    request: async ({ method, params }: { method: string; params: unknown[] }) => {
      // eth_call passes an OBJECT as params[0]; the others pass an address string.
      const p0 = params[0]
      const at = (typeof p0 === 'string' ? p0 : (p0 as { to: string }).to).toLowerCase()
      if (method === 'eth_getCode') return state.codes[at] ?? '0x'
      if (method === 'eth_getStorageAt') return state.slots[at]?.[(params[1] as string).toLowerCase()] ?? zero
      if (method === 'eth_call') {
        const answer = state.beaconAnswers[at]
        if (answer === 'THROW') throw new Error('execution reverted')
        return answer ?? '0x'
      }
      throw new Error(`unexpected ${method}`)
    },
  },
}))

const { classifyIntegrator, MIN_LOGIC_BYTES } = await import('../src/sweep/integrators.js')

beforeEach(() => {
  state.codes = {
    [A.plainAware]: big(UIMULT),
    [A.plainUnaware]: big(),
    [A.stub]: '0x' + 'ff'.repeat(100),
    [A.beaconProxy]: '0x' + 'ee'.repeat(141),
    [A.beacon]: big(),
    [A.beaconImpl]: big(UIMULT),
    [A.slotProxy]: '0x' + 'dd'.repeat(141),
    [A.slotImpl]: big(),
    [A.deadBeaconProxy]: '0x' + 'cc'.repeat(141),
  }
  state.slots = {
    [A.beaconProxy]: { [BEACON_SLOT]: word(A.beacon) },
    [A.slotProxy]: { [IMPL_SLOT]: word(A.slotImpl) },
    [A.deadBeaconProxy]: { [BEACON_SLOT]: word(A.deadBeacon) },
  }
  state.beaconAnswers = { [A.beacon]: word(A.beaconImpl), [A.deadBeacon]: 'THROW' }
})

describe('classifyIntegrator — never accuse a contract that is fine', () => {
  it('a BEACON proxy is judged on its implementation, not its 283-byte stub', async () => {
    // Exactly the Stock Token case. The stub has no selectors at all; the implementation has them.
    const r = await classifyIntegrator(A.beaconProxy, 100n)
    expect(r!.verdict).toBe('AWARE')
    expect(r!.proxyKind).toBe('eip1967-beacon')
    expect(r!.beacon?.toLowerCase()).toBe(A.beacon)
    expect(r!.implementation?.toLowerCase()).toBe(A.beaconImpl)
    // And the evidence must cite the size it actually tested, not the stub's.
    expect(r!.testedCodeSize).toBeGreaterThan(MIN_LOGIC_BYTES)
    expect(r!.testedCodeSize).not.toBe(r!.codeSize)
  })

  it('an EIP-1967 slot proxy is judged on its implementation', async () => {
    const r = await classifyIntegrator(A.slotProxy, 100n)
    expect(r!.verdict).toBe('NOT_AWARE')
    expect(r!.implementation?.toLowerCase()).toBe(A.slotImpl)
  })

  it('WITHHOLDS when a beacon exists but cannot be read — no claim at all', async () => {
    // The dangerous case: we know it is a proxy and cannot see through it. Silence, not a verdict.
    const r = await classifyIntegrator(A.deadBeaconProxy, 100n)
    expect(r!.verdict).toBe('PROXY_UNRESOLVED')
    expect(r!.hasMultiplierSelector).toBe(false)
  })

  it('calls a plain contract with the selector AWARE', async () => {
    expect((await classifyIntegrator(A.plainAware, 100n))!.verdict).toBe('AWARE')
  })

  it('calls a plain contract without the selector NOT_AWARE', async () => {
    const r = await classifyIntegrator(A.plainUnaware, 100n)
    expect(r!.verdict).toBe('NOT_AWARE')
    expect(r!.codeHash).toBe(keccak256(big() as `0x${string}`))
  })

  it('excludes EOAs and bytecode too small to hold valuation logic', async () => {
    expect((await classifyIntegrator(A.eoa, 100n))!.verdict).toBe('EOA')
    expect((await classifyIntegrator(A.stub, 100n))!.verdict).toBe('TOO_SMALL')
  })

  it('NEVER returns NOT_AWARE for anything it could not fully resolve', async () => {
    // The invariant, asserted directly across every fixture.
    for (const addr of Object.values(A)) {
      const r = await classifyIntegrator(addr as `0x${string}`, 100n)
      if (r?.verdict === 'NOT_AWARE') {
        expect(r.hasMultiplierSelector).toBe(false)
        expect(r.testedCodeSize).toBeGreaterThanOrEqual(MIN_LOGIC_BYTES)
      }
    }
  })
})

describe('named integrators never reach a public surface', () => {
  const snap = {
    findings: [
      { defectClass: 'SHARE_COUNT_MISREAD_RISK', subject: 'CRWD (0xea72)', severity: 'critical' },
      { defectClass: 'INTEGRATOR_NOT_MULTIPLIER_AWARE', subject: '0xfab520… (holds SGOV)', severity: 'low' },
      { defectClass: 'CROSS_SURFACE_PRICE_MIX', subject: 'SPY (0x117c)', severity: 'medium' },
    ],
  } as never

  it('strips them from the payload the wall and the free feed consume', async () => {
    const { findingsPayload, withoutNamedIntegrators } = await import('../src/lib/surface.js')
    expect(withoutNamedIntegrators(snap.findings)).toHaveLength(2)

    const p = findingsPayload({}, snap)
    expect(p.findings.some((f: { defectClass: string }) => f.defectClass === 'INTEGRATOR_NOT_MULTIPLIER_AWARE')).toBe(false)
    expect(p.namedIntegratorsWithheld).toBe(1)
  })

  it('answers an explicit filter with a note, not silently with nothing', async () => {
    // A caller who asks for the class deserves to know the names exist and where to get them,
    // rather than receiving an empty list that reads as "there are none".
    const { findingsPayload } = await import('../src/lib/surface.js')
    const p = findingsPayload({ defectClass: 'INTEGRATOR_NOT_MULTIPLIER_AWARE' as never }, snap)
    expect(p.findings).toHaveLength(0)
    expect((p as { note?: string }).note).toMatch(/assay_check_contract/)
  })

  it('leaves every other class alone', async () => {
    const { findingsPayload } = await import('../src/lib/surface.js')
    const p = findingsPayload({ defectClass: 'SHARE_COUNT_MISREAD_RISK' as never }, snap)
    expect(p.findings).toHaveLength(1)
  })
})
