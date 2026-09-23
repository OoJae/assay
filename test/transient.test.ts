import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import {
  CallExecutionError,
  ContractFunctionExecutionError,
  HttpRequestError,
  RpcRequestError,
  TimeoutError,
  createPublicClient,
  http,
} from 'viem'
import { isTransient, describeRpcError, rawCall } from '../src/sweep/oracle.js'
import { withRetry } from '../src/lib/position.js'
import { rhClient, robinhoodTransport, RH_RPC_URL } from '../src/lib/chains.js'
import { stockTokenAbi } from '../src/lib/abis.js'

/**
 * Retry classification, tested against the errors viem actually throws.
 *
 * isTransient was written against hand-typed strings and assumed viem's class names appear in
 * its messages. They do not, so a Cloudflare 403 and a hung request — the two faults this RPC
 * actually has — were classified permanent and never retried. Every error below is either a real
 * viem instance or one viem produced itself from a loopback server shaped like the failure seen
 * in agent.log. Nothing here leaves 127.0.0.1.
 */

const TOKEN = '0xea72Ecca2d0f6bFA1394DBBCff85b52CD4233931' as const
const WORD_4E18 = '0x' + (4n * 10n ** 18n).toString(16).padStart(64, '0')

// The shape of the real challenge page: ~5KB of HTML with this title.
const CLOUDFLARE_PAGE =
  '<!DOCTYPE html><html lang="en-US"><head><title>Just a moment...</title>' +
  '<meta http-equiv="refresh" content="360"></head><body>' +
  '<noscript>Enable JavaScript and cookies to continue</noscript>'.padEnd(5000, ' ') +
  '<script>window._cf_chl_opt={cType: "managed"}</script></body></html>'

const hits: Record<string, number> = {}
let server: Server
let base = ''

function rpcReply(res: import('node:http').ServerResponse, id: unknown, body: object, status = 200) {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ jsonrpc: '2.0', id, ...body }))
}

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', () => {
      const route = req.url ?? '/'
      hits[route] = (hits[route] ?? 0) + 1
      const id = (JSON.parse(raw || '{}') as { id?: unknown }).id ?? 1
      switch (route) {
        case '/cloudflare':
          res.writeHead(403, { 'content-type': 'text/html; charset=UTF-8', server: 'cloudflare' })
          return res.end(CLOUDFLARE_PAGE)
        case '/500':
          res.writeHead(500, { 'content-type': 'text/plain' })
          return res.end('internal error')
        case '/hang':
          return // never answers; viem's own timeout fires
        case '/revert':
          return rpcReply(res, id, { error: { code: 3, message: 'execution reverted', data: '0x' } })
        case '/historical':
          return rpcReply(res, id, {
            error: { code: -32000, message: 'historical state 66fead22 is not available' },
          })
        case '/limit':
          return rpcReply(res, id, { error: { code: -32005, message: 'limit exceeded' } })
        case '/ok':
          return rpcReply(res, id, { result: WORD_4E18 })
        default:
          res.writeHead(404)
          return res.end()
      }
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(() => new Promise<void>((r) => server.close(() => r())))

/** What readContract throws against one loopback route, with no viem-level retries. */
async function readVia(route: string): Promise<unknown> {
  const client = createPublicClient({ transport: http(`${base}${route}`, { retryCount: 0, timeout: 250 }) })
  try {
    await client.readContract({ address: TOKEN, abi: stockTokenAbi, functionName: 'uiMultiplier' })
  } catch (err) {
    return err
  }
  throw new Error(`expected ${route} to fail`)
}

describe('isTransient — real viem errors, as readContract throws them', () => {
  it('retries a Cloudflare 403 buried inside ContractFunctionExecutionError', async () => {
    const err = await readVia('/cloudflare')
    // The premise of the old code, refuted: the class name is not in the message.
    expect((err as Error).name).toBe('ContractFunctionExecutionError')
    expect((err as Error).message.toLowerCase()).not.toContain('httprequesterror')
    expect(isTransient(err)).toBe(true)
  })

  it('retries a timeout ("took too long"), which the old check called permanent', async () => {
    const err = await readVia('/hang')
    expect(isTransient(err)).toBe(true)
  })

  it('retries HTTP 5xx and an RPC rate-limit code', async () => {
    expect(isTransient(await readVia('/500'))).toBe(true)
    expect(isTransient(await readVia('/limit'))).toBe(true)
  })

  it('does NOT retry a revert or a pruned block', async () => {
    expect(isTransient(await readVia('/revert'))).toBe(false)
    expect(isTransient(await readVia('/historical'))).toBe(false)
  })
})

describe('isTransient — constructed viem errors', () => {
  const body = { method: 'eth_call', params: [] }
  const wrap = (cause: HttpRequestError | TimeoutError | RpcRequestError) =>
    new ContractFunctionExecutionError(new CallExecutionError(cause, { to: TOKEN, data: '0x3bd3f8ab' }), {
      abi: stockTokenAbi,
      functionName: 'uiMultiplier',
      args: [],
      contractAddress: TOKEN,
    })

  it('classifies HttpRequestError by status: 403/408/429/5xx retry, 400/404 do not', () => {
    for (const status of [403, 408, 429, 500, 502, 503, 504, 520, 522, 524]) {
      const e = new HttpRequestError({ body, status, url: RH_RPC_URL, details: 'x' })
      expect([status, isTransient(e), isTransient(wrap(e))]).toEqual([status, true, true])
    }
    for (const status of [400, 404]) {
      const e = new HttpRequestError({ body, status, url: RH_RPC_URL, details: 'bad request' })
      expect([status, isTransient(wrap(e))]).toEqual([status, false])
    }
  })

  it('retries TimeoutError at any depth', () => {
    const e = new TimeoutError({ body, url: RH_RPC_URL })
    expect(e.message).toMatch(/took too long/)
    expect(isTransient(e)).toBe(true)
    expect(isTransient(wrap(e))).toBe(true)
  })

  it('retries a fallback node a few blocks behind the head it was asked for', () => {
    // Measured replies to a block past each node's head.
    for (const message of ['unsupported block number 70069813', 'header not found', 'Unknown block']) {
      const e = new RpcRequestError({ body, url: RH_RPC_URL, error: { code: -32000, message } })
      expect([message, isTransient(wrap(e))]).toEqual([message, true])
    }
  })

  it('does not mistake digits inside a revert message for a status code', () => {
    const e = new RpcRequestError({
      body,
      url: RH_RPC_URL,
      error: { code: 3, message: 'execution reverted: holder 0x4290000000000000000000000000000000000503' },
    })
    expect(isTransient(wrap(e))).toBe(false)
  })

  it('does not mistake digits inside a permanent, non-revert error for a status code', () => {
    // The revert case above returns false on "execution reverted" before the status pattern is
    // read, so it passed with the bare /(403|408|429|5\d\d)/ this replaced. This one reaches it.
    const e = new RpcRequestError({
      body,
      url: RH_RPC_URL,
      error: { code: -32602, message: 'invalid argument 0: unknown account 0x4290000000000000000000000000000000000503' },
    })
    expect(isTransient(e)).toBe(false)
    expect(isTransient(wrap(e))).toBe(false)
    // The same digits after "Status:", as viem prints an HTTP failure, still retry.
    expect(isTransient('HTTP request failed. Status: 503')).toBe(true)
  })

  it('still accepts a plain string from old callers', () => {
    expect(isTransient('fetch failed')).toBe(true)
    expect(isTransient('The request took too long to respond.')).toBe(true)
    expect(isTransient('execution reverted')).toBe(false)
    expect(isTransient('historical state abc is not available')).toBe(false)
  })
})

describe('describeRpcError', () => {
  it('collapses a Cloudflare challenge page to one line, without the HTML', async () => {
    const err = await readVia('/cloudflare')
    // The raw message carries the whole page; this is what used to reach agent.log and buyers.
    expect((err as Error).message.length).toBeGreaterThan(5000)
    const line = describeRpcError(err)
    expect(line).toMatch(/Cloudflare challenge \(HTTP 403\)/)
    expect(line).toContain('127.0.0.1')
    expect(line).not.toContain('<')
    expect(line).not.toContain('\n')
    expect(line.length).toBeLessThan(200)
  })

  it('names a timeout plainly and keeps only the host of a URL', async () => {
    expect(describeRpcError(await readVia('/hang'))).toBe('RPC request timed out')
    const keyed = new HttpRequestError({
      body: {},
      status: 500,
      url: 'https://example-provider.invalid/v2/SECRETKEY123',
      details: '"<html>oops</html>"',
    })
    const line = describeRpcError(keyed)
    expect(line).toBe('example-provider.invalid returned HTTP 500')
    expect(line).not.toContain('SECRETKEY123')
  })
})

describe('robinhoodTransport — a second endpoint for availability faults only', () => {
  it('moves on to the next endpoint when the first serves a Cloudflare 403', async () => {
    const client = createPublicClient({ transport: robinhoodTransport([`${base}/cloudflare`, `${base}/ok`]) })
    const m = await client.readContract({ address: TOKEN, abi: stockTokenAbi, functionName: 'uiMultiplier' })
    expect(m).toBe(4n * 10n ** 18n)
  })

  it('does NOT fall through on a pruned block, so retention stays a property of the public RPC', async () => {
    const before = hits['/ok'] ?? 0
    const client = createPublicClient({ transport: robinhoodTransport([`${base}/historical`, `${base}/ok`]) })
    await expect(
      client.readContract({ address: TOKEN, abi: stockTokenAbi, functionName: 'uiMultiplier', blockNumber: 1n }),
    ).rejects.toThrow(/historical state/)
    expect(hits['/ok'] ?? 0).toBe(before)
  })

  it('does NOT fall through on a revert, which every node would repeat', async () => {
    const before = hits['/ok'] ?? 0
    const client = createPublicClient({ transport: robinhoodTransport([`${base}/revert`, `${base}/ok`]) })
    await expect(
      client.readContract({ address: TOKEN, abi: stockTokenAbi, functionName: 'uiMultiplier' }),
    ).rejects.toThrow(/reverted/)
    expect(hits['/ok'] ?? 0).toBe(before)
  })
})

describe('the two callers pass the error, not its message', () => {
  it('withRetry (paid path) retries a 403 and returns the answer', async () => {
    let calls = 0
    const v = await withRetry(async () => {
      calls++
      if (calls < 3) throw await readVia('/cloudflare')
      return 42
    }, Date.now() + 5_000)
    expect([v, calls]).toEqual([42, 3])
  })

  it('withRetry gives up at once on a revert', async () => {
    const revert = await readVia('/revert')
    let calls = 0
    await expect(
      withRetry(async () => {
        calls++
        throw revert
      }, Date.now() + 5_000),
    ).rejects.toBe(revert)
    expect(calls).toBe(1)
  })

  it('withRetry stops at the shared deadline instead of starting a fresh budget', async () => {
    const started = Date.now()
    await expect(
      withRetry(async () => {
        throw new HttpRequestError({ body: {}, status: 403, url: RH_RPC_URL })
      }, Date.now() + 100),
    ).rejects.toBeInstanceOf(HttpRequestError)
    expect(Date.now() - started).toBeLessThan(500)
  })

  it('rawCall (sweep) retries a 403 instead of dropping the read', async () => {
    const cloudflare = await readVia('/cloudflare')
    let calls = 0
    const spy = vi.spyOn(rhClient, 'request').mockImplementation((async () => {
      calls++
      if (calls === 1) throw cloudflare
      return WORD_4E18
    }) as never)
    try {
      const r = await rawCall(stockTokenAbi, TOKEN, 'uiMultiplier', 100n)
      expect(r?.decoded).toBe(4n * 10n ** 18n)
      expect(calls).toBe(2)
    } finally {
      spy.mockRestore()
    }
  })

  it('rawCall does not retry a revert', async () => {
    const revert = await readVia('/revert')
    let calls = 0
    const spy = vi.spyOn(rhClient, 'request').mockImplementation((async () => {
      calls++
      throw revert
    }) as never)
    try {
      expect(await rawCall(stockTokenAbi, TOKEN, 'uiMultiplier', 100n)).toBeNull()
      expect(calls).toBe(1)
    } finally {
      spy.mockRestore()
    }
  })
})
