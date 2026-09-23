import { describe, it, expect, vi, beforeEach } from 'vitest'
import { encodeAbiParameters, keccak256, toFunctionSelector } from 'viem'

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

const S = (sig: string) => toFunctionSelector(`function ${sig}`)
const UIMULT = S('uiMultiplier()')
const BALANCE_OF = S('balanceOf(address)')
const IMPL_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc'
const BEACON_SLOT = '0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50'
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
const NOW = 1_700_000_000
const HEAD = 100_000n

/*
 * Synthetic bytecode, laid out as solc lays it out. A selector only counts as an instruction, so
 * fixtures are built from instructions rather than by pasting hex.
 */
const push4 = (sel: string) => '63' + sel.slice(2)
/** solc's dispatcher entry for a function the contract IMPLEMENTS: DUP1 PUSH4 sel EQ PUSH2 dest JUMPI. */
const implementing = (...sigs: string[]) => sigs.map((g) => '80' + push4(S(g)) + '14' + '610000' + '57').join('')
/** An outgoing call to someone else's function: PUSH4 sel PUSH1 0xe0 SHL. */
const calling = (...sigs: string[]) => sigs.map((g) => push4(S(g)) + '60e01b').join('')
const FILLER = 'ab'.repeat(3000)
const logic = (...parts: string[]) => '0x' + parts.join('') + FILLER
/** The pre-existing fixture: a large contract, optionally CALLING uiMultiplier(). */
const big = (sel?: string) => logic(sel ? push4(sel) + '60e01b' : '')
const zero = '0x' + '0'.repeat(64)
const word = (v: bigint | string) =>
  typeof v === 'bigint' ? '0x' + v.toString(16).padStart(64, '0') : '0x' + '0'.repeat(24) + v.slice(2)

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

const state: {
  codes: Record<string, string>
  slots: Record<string, Record<string, string>>
  beaconAnswers: Record<string, string>
  /** eth_call answers keyed `${to}:${selector}`. 'THROW' throws. */
  calls: Record<string, string>
  /** balanceOf answers keyed `${token}:${holder}`. 'THROW' throws. */
  balances: Record<string, bigint | 'THROW'>
  /** Transfer logs keyed by token. 'THROW' fails every window. */
  logs: Record<string, Array<{ topics: string[] }> | 'THROW'>
  /** Every block tag an eth_call was pinned to. */
  callBlocks: string[]
} = { codes: {}, slots: {}, beaconAnswers: {}, calls: {}, balances: {}, logs: {}, callBlocks: [] }

vi.mock('../src/lib/chains.js', () => ({
  rhClient: {
    getBlockNumber: async () => HEAD,
    getBlock: async () => ({ timestamp: BigInt(NOW) }),
    request: async ({ method, params }: { method: string; params: unknown[] }) => {
      // eth_call passes an OBJECT as params[0]; the others pass an address string.
      const p0 = params[0]
      if (method === 'eth_getLogs') {
        const logs = state.logs[(p0 as { address: string }).address.toLowerCase()]
        if (logs === 'THROW') throw new Error('HTTP request failed. Status: 403')
        return logs ?? []
      }
      const at = (typeof p0 === 'string' ? p0 : (p0 as { to: string }).to).toLowerCase()
      if (method === 'eth_getCode') {
        if (state.codes[at] === 'THROW') throw new Error('HTTP request failed. Status: 403')
        return state.codes[at] ?? '0x'
      }
      if (method === 'eth_getStorageAt') {
        const v = state.slots[at]?.[(params[1] as string).toLowerCase()]
        if (v === 'THROW') throw new Error('HTTP request failed. Status: 403 (cloudflare challenge)')
        return v ?? zero
      }
      if (method === 'eth_call') {
        state.callBlocks.push(params[1] as string)
        const data = (p0 as { data: string }).data
        const sel = data.slice(0, 10)
        if (sel === BALANCE_OF) {
          const b = state.balances[`${at}:0x${data.slice(34, 74)}`]
          if (b === 'THROW') throw new Error('HTTP request failed. Status: 403')
          return word(b ?? 0n)
        }
        const call = state.calls[`${at}:${sel}`]
        if (call === 'THROW') throw new Error('execution reverted')
        if (call !== undefined) return call
        const answer = state.beaconAnswers[at]
        if (answer === 'THROW') throw new Error('execution reverted')
        if (answer !== undefined) return answer
        throw new Error('execution reverted')
      }
      throw new Error(`unexpected ${method}`)
    },
  },
}))

// The sweep test below reads the registry and the feed directory; nothing here touches the network.
const sweepFixture: { assets: unknown[]; feeds: unknown[] } = { assets: [], feeds: [] }
vi.mock('../src/lib/sources.js', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>
  return {
    ...actual,
    fetchRhAssets: async () => sweepFixture.assets,
    fetchChainlinkFeeds: async () => sweepFixture.feeds,
    fetchRhUnderlyingPrice: async () => null,
  }
})

const {
  classifyIntegrator,
  integratorExposure,
  integratorFinding,
  isMaterial,
  scanSelectors,
  MIN_LOGIC_BYTES,
  NAMED_MIN_USD,
  UI_MULTIPLIER_SELECTOR,
} = await import('../src/sweep/integrators.js')

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
  state.calls = {}
  state.balances = {}
  state.logs = {}
  state.callBlocks = []
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

describe('fail closed — a failed proxy read is PROXY_UNRESOLVED, never a selector test on the stub', () => {
  // A 3,000-byte proxy stub: big enough that falling through to the selector test on the stub
  // itself used to come back NOT_AWARE. Reproduced offline by the audit with a 403 on the slot.
  const bigStub = '0xcccc222222222222222222222222222222222222' as const

  it('the implementation-slot read throws', async () => {
    state.codes[bigStub] = big()
    state.slots[bigStub] = { [IMPL_SLOT]: 'THROW' }
    const r = await classifyIntegrator(bigStub, 100n)
    expect(r!.verdict).toBe('PROXY_UNRESOLVED')
    expect(r!.unresolvedReason).toMatch(/implementation slot/)
  })

  it('the beacon-slot read throws after the implementation slot came back empty', async () => {
    state.codes[bigStub] = big()
    state.slots[bigStub] = { [BEACON_SLOT]: 'THROW' }
    const r = await classifyIntegrator(bigStub, 100n)
    expect(r!.verdict).toBe('PROXY_UNRESOLVED')
    expect(r!.unresolvedReason).toMatch(/beacon slot/)
  })

  it("the implementation's code cannot be fetched", async () => {
    state.codes[A.slotImpl] = 'THROW'
    const r = await classifyIntegrator(A.slotProxy, 100n)
    expect(r!.verdict).toBe('PROXY_UNRESOLVED')
  })
})

describe('selectors are instructions, not text', () => {
  const at = '0xdddd333333333333333333333333333333333333' as const
  const classify = async (code: string) => {
    state.codes[at] = code
    return (await classifyIntegrator(at, 100n))!
  }

  it('counts the selector as the operand of a real PUSH4', async () => {
    expect((await classify(logic(push4(UIMULT) + '60e01b'))).verdict).toBe('AWARE')
  })

  it('counts a PUSH32 of the selector followed by 28 zero bytes, the form via-IR folds a call into', async () => {
    // Missing this form would turn a multiplier-aware contract into a NOT_AWARE one.
    expect((await classify(logic('7f' + UIMULT.slice(2) + '00'.repeat(28)))).verdict).toBe('AWARE')
  })

  it('ignores the selector at an odd nibble offset, where no instruction can hold it', async () => {
    // `code.includes('a60bf13d')` matched this, so a random byte run or a planted constant passed.
    const r = await classify('0x0' + UIMULT.slice(2) + '0' + FILLER)
    expect(r.verdict).toBe('NOT_AWARE')
    expect(r.hasMultiplierSelector).toBe(false)
  })

  it('ignores the selector bytes buried inside a longer constant', async () => {
    // PUSH6 whose operand happens to contain 63 a6 0b f1 3d: data, not a PUSH4.
    expect((await classify(logic('65' + push4(UIMULT) + '00'))).verdict).toBe('NOT_AWARE')
  })

  it('ignores the CBOR metadata tail, and the same bytes as code are still found', async () => {
    // A solc-shaped map {ipfs: <34 bytes>, solc: <3 bytes>} whose hash starts with PUSH4 uiMultiplier,
    // aligned so a linear sweep WOULD read it as an instruction if it did not stop at the metadata.
    const meta =
      'a2' + '64' + '69706673' + '58' + '22' + '1220' + push4(UIMULT) + '00'.repeat(27) + '64' + '736f6c63' + '43' + '000814'
    expect(meta.length / 2).toBe(0x33)
    expect((await classify('0x' + FILLER + meta + '0033')).verdict).toBe('NOT_AWARE')
    expect(scanSelectors('0x' + FILLER + meta).pushed.has(UIMULT)).toBe(true)
  })
})

describe('EIP-1167 is matched as the exact minimal-proxy runtime, nothing looser', () => {
  const clone = '0xeeee444444444444444444444444444444444444' as const

  it('resolves an exact EIP-1167 proxy to its inlined implementation', async () => {
    state.codes[clone] = '0x363d3d373d3d3d363d73' + A.plainAware.slice(2) + '5af43d82803e903d91602b57fd5bf3'
    const r = await classifyIntegrator(clone, 100n)
    expect(r!.proxyKind).toBe('eip1167')
    expect(r!.implementation?.toLowerCase()).toBe(A.plainAware)
    expect(r!.verdict).toBe('AWARE')
  })

  it('resolves the PUSH0 form (ERC-7511)', async () => {
    state.codes[clone] = '0x365f5f375f5f365f73' + A.plainUnaware.slice(2) + '5af43d5f5f3e5f3d91602a57fd5bf3'
    const r = await classifyIntegrator(clone, 100n)
    expect(r!.proxyKind).toBe('eip1167')
    expect(r!.implementation?.toLowerCase()).toBe(A.plainUnaware)
  })

  it('does not mistake a clone FACTORY, which embeds both constants, for a proxy', async () => {
    // OpenZeppelin Clones pushes the creation prefix and the runtime suffix as constants. The old
    // fragment match found both and invented an implementation from the next 40 hex characters.
    state.codes[clone] =
      logic('7f' + '3d602d80600a3d3981f3363d3d373d3d3d363d73' + '00'.repeat(12)) + '6e' + '5af43d82803e903d91602b57fd5bf3'
    const r = await classifyIntegrator(clone, 100n)
    expect(r!.proxyKind).toBeUndefined()
    expect(r!.implementation).toBeUndefined()
    expect(r!.verdict).toBe('NOT_AWARE')
  })
})

describe('recognised roles are NOT_APPLICABLE, never NOT_AWARE', () => {
  const at = '0xffff555555555555555555555555555555555555' as const
  const classify = async (code: string) => {
    state.codes[at] = code
    return (await classifyIntegrator(at, 100n))!
  }
  const V3_SWAP = 'swap(address,bool,int256,uint160,bytes)'

  it('a Uniswap-V3-style pool (implements slot0 and swap)', async () => {
    const r = await classify(logic(implementing('factory()', 'slot0()', V3_SWAP)))
    expect(r.verdict).toBe('NOT_APPLICABLE')
    expect(r.role).toBe('AMM_POOL')
    expect(r.roleSelectors).toEqual(['slot0()', V3_SWAP])
  })

  it('a Uniswap-V2-style pair (implements getReserves and factory)', async () => {
    const r = await classify(logic(implementing('getReserves()', 'factory()', 'swap(uint256,uint256,address,bytes)')))
    expect(r.role).toBe('AMM_POOL')
  })

  it('a Uniswap-v4-style PoolManager (implements unlock, settle and take)', async () => {
    const r = await classify(logic(implementing('unlock(bytes)', 'settle()', 'take(address,address,uint256)', 'extsload(bytes32)')))
    expect(r.role).toBe('AMM_POOL_MANAGER')
  })

  it('an executor wallet and a Safe are CUSTODY', async () => {
    expect((await classify(logic(implementing('executeGeneral(address,bytes)', 'withdrawAllTokens(address[])')))).role).toBe('CUSTODY')
    expect(
      (await classify(logic(implementing('execTransaction(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,bytes)'))))
        .role,
    ).toBe('CUSTODY')
  })

  it('a merkle distributor reached through a beacon is judged on its implementation', async () => {
    state.codes[A.beaconImpl] = logic(implementing('claim(uint256,address,uint256,uint256,bytes32[])', 'harvest()'))
    const r = await classifyIntegrator(A.beaconProxy, 100n)
    expect(r!.verdict).toBe('NOT_APPLICABLE')
    expect(r!.role).toBe('DISTRIBUTOR')
    expect(r!.proxyKind).toBe('eip1967-beacon')
  })

  it('a router that only CALLS pool functions is not a pool', async () => {
    // Measured: aggregators on this chain push swap, slot0, unlock, settle and take to call them,
    // then shift them into calldata. Only the pool itself compares them in a dispatcher.
    const r = await classify(logic(calling('slot0()', V3_SWAP, 'unlock(bytes)', 'settle()', 'take(address,address,uint256)')))
    expect(r.verdict).toBe('NOT_AWARE')
    expect(r.role).toBeUndefined()
  })

  it('a valuation selector vetoes the role: a pool-shaped contract that values shares stays NOT_AWARE', async () => {
    const r = await classify(logic(implementing('slot0()', V3_SWAP), calling('totalAssets()')))
    expect(r.verdict).toBe('NOT_AWARE')
  })

  it('AWARE outranks every role', async () => {
    const r = await classify(logic(implementing('slot0()', V3_SWAP), calling('uiMultiplier()')))
    expect(r.verdict).toBe('AWARE')
  })

  it('selector fingerprints work at the same offsets as a real dispatcher', async () => {
    // DUP2 before PUSH4 (the second arm of a solc binary-search dispatcher) counts too.
    const dup2 = '81' + push4(S('slot0()')) + '14610000' + '57' + '80' + push4(S(V3_SWAP)) + '14610000' + '57'
    expect((await classify(logic(dup2))).role).toBe('AMM_POOL')
  })
})

describe('the named finding', () => {
  const token = '0x1234000000000000000000000000000000000001' as const
  async function exposure(multiplier: bigint, balance: bigint, usd: number | null) {
    const reading = (await classifyIntegrator(A.plainUnaware, 100n))!
    state.balances[`${token}:${A.plainUnaware}`] = balance
    const m = { symbol: 'TKN', token, multiplier, raw: word(multiplier), blockNumber: 200n }
    const price = usd === null ? null : { usd, feed: '0xfeed000000000000000000000000000000000001' as const, latestRoundData: '0xabc' }
    const x = await integratorExposure(reading, m, price)
    if (x.status !== 'held') throw new Error(`expected a holding, got ${x.status}`)
    return x.exposure
  }

  it('does not claim a feed-priced valuation is understated, because the feed is multiplier-adjusted', async () => {
    const f = integratorFinding(await exposure(4n * 10n ** 18n, 10n ** 18n, 100), 100n, 'now', 'v')
    expect(f.title).toMatch(/cannot call uiMultiplier\(\) directly$/)
    expect(f.statement).toMatch(/Valuing the balance at the Chainlink feed price is correct and unaffected/)
    expect(f.statement).not.toMatch(/share count or a valuation/)
    expect(f.impact.percent).toBe(75)
  })

  it('reads a reverse split as an overstatement, with a positive magnitude and severity from it', async () => {
    // A 0.25x multiplier printed "understated by -300.0000%" at severity low.
    const f = integratorFinding(await exposure(25n * 10n ** 16n, 4n * 10n ** 18n, null), 100n, 'now', 'v')
    expect(f.statement).toMatch(/overstates the position by 300\.0000%/)
    expect(f.statement).toMatch(/3\.000000 fewer than the raw balance/)
    expect(f.statement).not.toMatch(/ -\d/)
    expect(f.impact.percent).toBe(300)
    expect(f.severity).toBe('high')
  })

  it('cites the on-chain multiplier and the balance at the block they were read, with the calldata', async () => {
    const f = integratorFinding(await exposure(15n * 10n ** 17n, 10n ** 18n, 50), 100n, 'now', 'v')
    const mult = f.evidence.find((e) => e.call === 'uiMultiplier()')!
    const bal = f.evidence.find((e) => e.call === 'balanceOf(address)')!
    expect(mult.rawReturn).toBe(word(15n * 10n ** 17n))
    expect(mult.blockNumber).toBe('200')
    expect(bal.blockNumber).toBe('200')
    expect(bal.calldata?.slice(0, 10)).toBe(BALANCE_OF)
    expect(bal.calldata).toContain(A.plainUnaware.slice(2))
    expect(f.evidence.find((e) => e.call === 'getCode()')!.claim).toContain(`no ${UI_MULTIPLIER_SELECTOR} selector`)
    expect(state.callBlocks.every((b) => b === '0xc8')).toBe(true)
  })

  it('reports a failed balanceOf as unreadable, never as an empty holding', async () => {
    const reading = (await classifyIntegrator(A.plainUnaware, 100n))!
    state.balances[`${token}:${A.plainUnaware}`] = 'THROW'
    const m = { symbol: 'TKN', token, multiplier: 2n * 10n ** 18n, raw: '0x', blockNumber: 200n }
    expect((await integratorExposure(reading, m, null)).status).toBe('unreadable')
  })

  it('names nothing below the materiality floor', async () => {
    expect(isMaterial(await exposure(2n * 10n ** 18n, 10n ** 18n, NAMED_MIN_USD - 1))).toBe(false)
    expect(isMaterial(await exposure(2n * 10n ** 18n, 10n ** 18n, NAMED_MIN_USD))).toBe(true)
    // Unpriced: judged on share-equivalents unaccounted. 0.005 tokens at 2x leaves 0.005.
    expect(isMaterial(await exposure(2n * 10n ** 18n, 5n * 10n ** 15n, null))).toBe(false)
    expect(isMaterial(await exposure(2n * 10n ** 18n, 10n ** 16n, null))).toBe(true)
  })
})

describe('the sweep aggregate counts distinct contracts and keeps AMM reserves out of the headline', () => {
  const T = {
    TOKA: '0xa000000000000000000000000000000000000001',
    TOKB: '0xa000000000000000000000000000000000000002',
    TOKC: '0xa000000000000000000000000000000000000003',
    TOKD: '0xa000000000000000000000000000000000000004',
  } as const
  const FEED = '0xfeed00000000000000000000000000000000000a'
  const H = {
    pool: '0xb000000000000000000000000000000000000001',
    unaware: '0xb000000000000000000000000000000000000002',
    dust: '0xb000000000000000000000000000000000000003',
    eoa: '0xb000000000000000000000000000000000000004',
    aware: '0xb000000000000000000000000000000000000005',
  } as const
  const E18 = 10n ** 18n
  const mults: Record<string, bigint> = { TOKA: 15n * 10n ** 17n, TOKB: 1001n * 10n ** 15n, TOKC: E18, TOKD: 2n * E18 }
  const topic = (a: string) => '0x' + '0'.repeat(24) + a.slice(2)
  const transfer = (from: string, to: string) => ({ topics: [TRANSFER, topic(from), topic(to)] })

  function arrange() {
    sweepFixture.assets = Object.entries(T).map(([sym, token]) => ({
      id: sym,
      tokenSymbol: sym,
      tokenName: sym,
      tokenDecimals: 18,
      // The REST registry says TOKA is 1.0. The chain says 1.5, and the chain is what is gated on.
      currentMultiplier: sym === 'TOKA' ? E18.toString() : mults[sym]!.toString(),
      pendingMultiplier: '',
      status: 'active',
      deployments: [{ contractAddress: token, chainId: 4663 }],
    }))
    sweepFixture.feeds = [
      { name: 'ROBINHOOD TOKA / USD', proxyAddress: FEED, decimals: 8, heartbeat: 86_400, docs: { marketHours: 'us_equities_24/5' } },
    ]
    for (const [sym, token] of Object.entries(T)) {
      state.calls[`${token}:${S('uiMultiplier()')}`] = word(mults[sym]!)
      state.calls[`${token}:${S('newUIMultiplier()')}`] = word(mults[sym]!)
      state.calls[`${token}:${S('totalSupply()')}`] = word(1000n * E18)
      state.calls[`${token}:${S('decimals()')}`] = word(18n)
      state.calls[`${token}:${S('oraclePaused()')}`] = word(0n)
      state.calls[`${token}:${S('effectiveAt()')}`] = word(0n)
    }
    // $10 a token, 200,000s old against a 24h heartbeat: 55.6h old, 31.6h past it.
    state.calls[`${FEED}:${S('latestRoundData()')}`] = encodeAbiParameters(
      [{ type: 'uint80' }, { type: 'int256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint80' }],
      [5n, 10_00000000n, BigInt(NOW - 200_000), BigInt(NOW - 200_000), 5n],
    )
    state.calls[`${FEED}:${S('decimals()')}`] = word(8n)
    state.codes[H.pool] = logic(implementing('factory()', 'slot0()', 'swap(address,bool,int256,uint160,bytes)'))
    state.codes[H.unaware] = big()
    state.codes[H.dust] = logic('5b')
    state.codes[H.aware] = big(UIMULT)
    state.logs[T.TOKA] = [transfer(H.pool, H.unaware), transfer(H.dust, H.eoa), transfer(H.aware, H.pool)]
    state.logs[T.TOKB] = [transfer(H.pool, H.unaware)]
    state.logs[T.TOKD] = [transfer(H.pool, H.unaware)]
    state.balances[`${T.TOKA}:${H.pool}`] = 500n * E18
    state.balances[`${T.TOKA}:${H.unaware}`] = 200n * E18
    state.balances[`${T.TOKA}:${H.dust}`] = E18
    state.balances[`${T.TOKD}:${H.pool}`] = 7n * E18
    state.balances[`${T.TOKD}:${H.unaware}`] = 3n * E18
  }

  it('counts distinct addresses, separates NOT_APPLICABLE, prices honestly, and names only material holdings', async () => {
    arrange()
    const { sweep } = await import('../src/sweep/detect.js')
    const r = await sweep({ verify: false })
    const ig = r.integrators

    // The pool holds two tokens and the unaware contract holds two: each is ONE contract.
    expect(ig.scanned).toBe(5)
    expect(ig.contracts).toBe(4)
    expect(ig.aware).toBe(1)
    expect(ig.notApplicable).toBe(1)
    expect(ig.byRole.AMM_POOL).toEqual({ contracts: 1, usdHeld: 5000 })
    expect(ig.notAware).toBe(2)
    expect(ig.holdingsNotAware).toBe(3)
    expect(ig.holdingsNotApplicable).toBe(2)

    // Pool reserves are their own line, never inside the NOT_AWARE headline.
    expect(ig.usdHeldByNotApplicable).toBe(5000)
    expect(ig.usdHeldByNotAware).toBe(2010)
    // TOKD has no feed: counted as unpriced, not as $0.
    expect(ig.unpricedNotAware).toBe(1)
    expect(ig.unpricedNotApplicable).toBe(1)
    expect(ig.sharesUnaccounted).toBeCloseTo(100 + 0.5 + 3, 9)

    // Coverage is stated: TOKB is divergent but under the cutoff; TOKA is scanned on its ON-CHAIN value.
    expect(ig.assetsScanned).toEqual(['TOKA', 'TOKD'])
    expect(ig.assetsBelowCutoff).toEqual(['TOKB'])

    // Named: the material holdings of the NOT_AWARE contract only. Never the pool, never the dust.
    const named = r.findings.filter((f) => f.defectClass === 'INTEGRATOR_NOT_MULTIPLIER_AWARE').map((f) => f.id)
    expect(named.sort()).toEqual([`integrator-${H.unaware.slice(2, 10)}-TOKA`, `integrator-${H.unaware.slice(2, 10)}-TOKD`])
    expect(ig.dustNotAware).toBe(1)
    const f = r.findings.find((x) => x.id.endsWith('-TOKA') && x.defectClass === 'INTEGRATOR_NOT_MULTIPLIER_AWARE')!
    expect(f.statement).toContain(`uiMultiplier() returns ${mults.TOKA}`)
    expect(f.evidence.find((e) => e.call === 'balanceOf(address)')!.blockNumber).toBe(HEAD.toString())

    // One metric in two units on the share-count finding: 1.5x understates by 33.3333% = 3333.33 bps.
    const share = r.findings.find((x) => x.id === 'TOKA-share-count')!
    expect(share.impact.percent).toBe(33.3333)
    expect(share.impact.basisPoints).toBe(3333.33)

    // The stale title states total age and lateness separately.
    const stale = r.findings.find((x) => x.id === 'TOKA-stale-feed')!
    expect(stale.title).toMatch(/feed 55\.6h old, 31\.6h past its 24h heartbeat/)
  })

  it('does not publish an asset as scanned when not one window of its Transfer logs could be read', async () => {
    arrange()
    state.logs[T.TOKD] = 'THROW'
    const { sweep } = await import('../src/sweep/detect.js')
    const ig = (await sweep({ verify: false })).integrators
    // TOKD's holders were never read. It used to be listed as scanned, with no holders.
    expect(ig.assetsScanned).toEqual(['TOKA'])
    expect(ig.assetsUnread).toEqual(['TOKD'])
    expect(ig.holdingsNotAware).toBe(2)
  })
})

describe('named integrators never reach a public surface', () => {
  const snap = {
    findings: [
      { defectClass: 'SHARE_COUNT_MISREAD_RISK', subject: 'CRWD (0xea72)', severity: 'critical' },
      { defectClass: 'INTEGRATOR_NOT_MULTIPLIER_AWARE', subject: '0x0a0a0a… (holds SGOV)', severity: 'low' },
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
