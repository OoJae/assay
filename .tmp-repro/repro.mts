import http from 'node:http'
import { createPublicClient, http as httpT, defineChain } from 'viem'
import { isTransient } from '/Users/oluwademilade/Desktop/Openserv/assay/src/sweep/oracle.ts'

const abi = [{name:'balanceOf',type:'function',stateMutability:'view',inputs:[{name:'a',type:'address'}],outputs:[{name:'',type:'uint256'}]}]

let mode = 'hang'
const server = http.createServer((req, res) => {
  let body = ''
  req.on('data', c => body += c)
  req.on('end', () => {
    if (mode === 'hang') { /* never respond */ return }
    if (mode === 'reset') { req.socket.destroy(); return }
    if (mode === '429') { res.writeHead(429); res.end('too many'); return }
    if (mode === '503') { res.writeHead(503); res.end('unavailable'); return }
    const id = JSON.parse(body).id
    if (mode === 'limit') { res.writeHead(200,{'content-type':'application/json'}); res.end(JSON.stringify({jsonrpc:'2.0',id,error:{code:-32005,message:'Request exceeds defined limit'}})); return }
    if (mode === 'internal') { res.writeHead(200,{'content-type':'application/json'}); res.end(JSON.stringify({jsonrpc:'2.0',id,error:{code:-32603,message:'Internal error'}})); return }
    if (mode === 'revert') { res.writeHead(200,{'content-type':'application/json'}); res.end(JSON.stringify({jsonrpc:'2.0',id,error:{code:3,message:'execution reverted'}})); return }
  })
})
await new Promise(r => server.listen(0, r))
const port = server.address().port
const chain = defineChain({id:4663,name:'t',nativeCurrency:{name:'E',symbol:'E',decimals:18},rpcUrls:{default:{http:[`http://127.0.0.1:${port}`]}}})
const client = createPublicClient({chain, transport: httpT(`http://127.0.0.1:${port}`, {timeout: 800, retryCount: 0})})

for (const m of ['hang','reset','429','503','limit','internal','revert']) {
  mode = m
  try {
    await client.readContract({address:'0x0000000000000000000000000000000000000001', abi, functionName:'balanceOf', args:['0x0000000000000000000000000000000000000002']})
    console.log(m, 'NO ERROR')
  } catch (e) {
    const msg = e.message ?? String(e)
    console.log('=== mode:', m)
    console.log('  name:', e.name)
    console.log('  shortMessage:', JSON.stringify(e.shortMessage))
    console.log('  message:', JSON.stringify(msg))
    console.log('  isTransient(message):', isTransient(msg))
  }
}
server.close()
process.exit(0)
