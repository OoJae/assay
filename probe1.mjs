const RPC='https://rpc.mainnet.chain.robinhood.com'
const sel={ui:'0x4a9bbd44',new:'0xb1a3a4cc',eff:'0x0b56c982'}
// compute selectors properly with viem
import('viem').then(async (viem)=>{
  const {toFunctionSelector}=viem
  const s={ui:toFunctionSelector('uiMultiplier()'),nu:toFunctionSelector('newUIMultiplier()'),ef:toFunctionSelector('effectiveAt()'),ts:toFunctionSelector('totalSupply()'),dc:toFunctionSelector('decimals()')}
  console.log(s)
  const assets=await (await fetch('https://api.robinhood.com/rhj/assets',{headers:{accept:'application/json'}})).json()
  const list=Array.isArray(assets)?assets:assets.assets
  console.log('assets',list.length)
  const call=async(to,data)=>{
    const r=await fetch(RPC,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'eth_call',params:[{to,data},'latest']})})
    const j=await r.json(); return j.result ?? ('ERR:'+(j.error&&j.error.message))
  }
  let n=0, zero=0, diff=0, rows=[]
  for(const a of list){
    const dep=(a.deployments||[]).find(d=>d.chainId===4663)||(a.deployments||[])[0]
    if(!dep) continue
    n++
    if(n>200) break
    const [ui,nu,ef,dc]=await Promise.all([call(dep.contractAddress,s.ui),call(dep.contractAddress,s.nu),call(dep.contractAddress,s.ef),call(dep.contractAddress,s.dc)])
    const U=ui.startsWith('0x')&&ui.length>2?BigInt(ui):null
    const N=nu.startsWith('0x')&&nu.length>2?BigInt(nu):null
    if(N===0n) zero++
    if(U!==null&&N!==null&&U!==N){diff++;rows.push({sym:a.tokenSymbol,addr:dep.contractAddress,ui:U.toString(),nu:N.toString(),ef:ef,dc:dc,offPending:a.pendingMultiplier})}
  }
  console.log('checked',n,'newUIMultiplier==0:',zero,'ui!=new:',diff)
  console.log(JSON.stringify(rows.slice(0,25),null,1))
})
