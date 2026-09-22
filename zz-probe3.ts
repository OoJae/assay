import { createServer } from 'node:http'
import { createPublicClient, http, defineChain } from 'viem'

let hits = 0
let mode = 'hang'
const srv = createServer((req, res) => {
  let b=''; req.on('data',c=>b+=c); req.on('end',()=>{
    hits++
    if (mode === 'hang') return
    if (mode === '429') { res.writeHead(429); res.end('nope'); return }
    res.writeHead(200,{'content-type':'application/json'}); res.end(JSON.stringify({jsonrpc:'2.0',id:1,result:'0x'}))
  })
})
await new Promise<void>(r=>srv.listen(0,'127.0.0.1',()=>r()))
const port=(srv.address() as any).port
const chain = defineChain({id:4663,name:'t',nativeCurrency:{name:'E',symbol:'E',decimals:18},rpcUrls:{default:{http:[`http://127.0.0.1:${port}`]}}})
// DEFAULT transport options, exactly like src/lib/chains.ts: http()
const client = createPublicClient({chain, transport: http()})

for (const m of ['hang','429']) {
  mode = m; hits = 0
  const t0 = Date.now()
  try {
    await Promise.race([
      client.request({method:'eth_call', params:[{to:'0x1111111111111111111111111111111111111111', data:'0x1e4e4bad'},'latest']} as never),
      new Promise((_,rej)=>setTimeout(()=>rej(new Error('outer-guard')), 45000)),
    ])
  } catch (e:any) {
    console.log(`[${m}] viem internal HTTP attempts = ${hits}, elapsed ${Date.now()-t0}ms, err="${(e.message||'').split('\n')[0]}"`)
  }
}
srv.close(); process.exit(0)
