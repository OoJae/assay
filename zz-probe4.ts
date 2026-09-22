import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { buildServer } from './src/mcp/server.js'

const [cT, sT] = InMemoryTransport.createLinkedPair()
const server = buildServer()
await server.connect(sT)
const client = new Client({ name: 'probe', version: '0' })
await client.connect(cT)

async function call(name: string, args: any) {
  try {
    const r: any = await client.callTool({ name, arguments: args })
    console.log(`>>> ${name}(${JSON.stringify(args)})`)
    console.log('    isError:', r.isError)
    console.log('    text   :', JSON.stringify(String(r.content?.[0]?.text ?? '').slice(0, 400)))
  } catch (e: any) {
    console.log(`>>> ${name}(${JSON.stringify(args)}) THREW to the client: ${e.code} ${e.message?.slice(0,300)}`)
  }
}

await call('assay_true_position', { symbol: 'ZZZNOPE', holder: '0x8366a39CC670B4001A1121B8F6A443A643e40951' })
await call('assay_true_position', { symbol: 'CRWDD', holder: '0x8366a39CC670B4001A1121B8F6A443A643e40951' })
await call('assay_findings', { symbol: 'P' })
process.exit(0)
