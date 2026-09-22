import { createServer } from 'node:http'
import { createPublicClient, http, defineChain } from 'viem'
import { isTransient } from './src/sweep/oracle.js'

const abi = [
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: 'a', type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'oraclePaused', stateMutability: 'view', inputs: [], outputs: [{ type: 'bool' }] },
] as const

let mode = 'ok'
const srv = createServer((req, res) => {
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    const id = (() => { try { return JSON.parse(body).id } catch { return 1 } })()
    if (mode === '429') { res.writeHead(429, {'content-type':'text/plain'}); res.end('Too Many Requests'); return }
    if (mode === '503') { res.writeHead(503, {'content-type':'text/plain'}); res.end('Service Unavailable'); return }
    if (mode === '502') { res.writeHead(502, {'content-type':'text/plain'}); res.end('Bad Gateway'); return }
    if (mode === 'hang') { return } // never respond
    if (mode === 'reset') { req.socket.destroy(); return }
    if (mode === 'revert') {
      res.writeHead(200, {'content-type':'application/json'})
      res.end(JSON.stringify({ jsonrpc:'2.0', id, error: { code: 3, message: 'execution reverted', data: '0x' } }))
      return
    }
    if (mode === 'zerodata') {
      res.writeHead(200, {'content-type':'application/json'})
      res.end(JSON.stringify({ jsonrpc:'2.0', id, result: '0x' }))
      return
    }
    if (mode === 'limitexceeded') {
      res.writeHead(200, {'content-type':'application/json'})
      res.end(JSON.stringify({ jsonrpc:'2.0', id, error: { code: -32005, message: 'Your app has exceeded its compute units per second capacity.' } }))
      return
    }
    if (mode === 'internal') {
      res.writeHead(200, {'content-type':'application/json'})
      res.end(JSON.stringify({ jsonrpc:'2.0', id, error: { code: -32603, message: 'Internal error' } }))
      return
    }
    if (mode === 'html') { res.writeHead(200, {'content-type':'text/html'}); res.end('<html>502 Bad Gateway nginx</html>'); return }
    res.writeHead(200, {'content-type':'application/json'})
    res.end(JSON.stringify({ jsonrpc:'2.0', id, result: '0x'+'0'.repeat(64) }))
  })
})

await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()))
const port = (srv.address() as any).port
const chain = defineChain({ id: 4663, name: 't', nativeCurrency:{name:'E',symbol:'E',decimals:18}, rpcUrls:{default:{http:[`http://127.0.0.1:${port}`]}} })
const client = createPublicClient({ chain, transport: http(undefined, { retryCount: 0, timeout: 1500 }) })

const TOKEN = '0x1111111111111111111111111111111111111111' as const
const HOLDER = '0x2222222222222222222222222222222222222222' as const

for (const m of ['429','503','502','hang','reset','revert','zerodata','limitexceeded','internal','html']) {
  mode = m
  try {
    await client.readContract({ address: TOKEN, abi, functionName: 'balanceOf', args: [HOLDER] })
    console.log(`[${m}] NO ERROR`)
  } catch (e: any) {
    const msg = e?.message ?? String(e)
    const first = msg.split('\n')[0]
    console.log(`\n=== ${m} ===`)
    console.log('name        :', e?.name)
    console.log('shortMessage:', e?.shortMessage)
    console.log('first line  :', first)
    console.log('isTransient :', isTransient(msg))
    console.log('msg(400)    :', JSON.stringify(msg.slice(0, 400)))
  }
}
srv.close()
process.exit(0)
