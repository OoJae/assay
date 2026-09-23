import { describe, it, expect, vi, afterEach } from 'vitest'
import { encodeAbiParameters, toFunctionSelector } from 'viem'
import { readFeed } from '../src/sweep/oracle.js'
import { rhClient } from '../src/lib/chains.js'
import { HEARTBEAT_GRACE_SECONDS } from '../src/lib/sources.js'

/**
 * The sweep's staleness call applies the heartbeat delivery grace.
 *
 * SGOV only updates on its heartbeat, and its rounds land 86,400-86,426s apart. A strict
 * `age > heartbeat` in readFeed published it as "stale DURING MARKET HOURS" around 00:00 UTC. The
 * weekend replay tests pastHeartbeat() directly, so reverting readFeed to the strict comparison
 * failed nothing; this reads through readFeed itself. No network: the RPC is stubbed.
 */

const FEED = '0xa0DF4ee0fFf975306345875E3548Fcc519577A11' as const
const NOW = 1_800_000_000
const HEARTBEAT = 86_400
const LATEST_ROUND_DATA = toFunctionSelector('function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)')

function stubFeed(ageSeconds: number) {
  return vi.spyOn(rhClient, 'request').mockImplementation((async (args: { params: [{ data: string }] }) => {
    if (args.params[0].data.startsWith(LATEST_ROUND_DATA)) {
      const at = BigInt(NOW - ageSeconds)
      return encodeAbiParameters(
        [{ type: 'uint80' }, { type: 'int256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint80' }],
        [64n, 100_00000000n, at, at, 64n],
      )
    }
    return '0x' + (8n).toString(16).padStart(64, '0') // decimals()
  }) as never)
}

afterEach(() => vi.restoreAllMocks())

describe('readFeed applies the heartbeat delivery grace', () => {
  it("SGOV's measured 86,426s round is on schedule, not stale", async () => {
    stubFeed(86_426)
    const r = await readFeed(FEED, HEARTBEAT, NOW, 100n)
    expect(r?.ageSeconds).toBe(86_426)
    expect(r?.stale).toBe(false)
  })

  it('a feed past its heartbeat by more than the grace is stale', async () => {
    stubFeed(HEARTBEAT + HEARTBEAT_GRACE_SECONDS + 1)
    expect((await readFeed(FEED, HEARTBEAT, NOW, 100n))?.stale).toBe(true)
  })
})
