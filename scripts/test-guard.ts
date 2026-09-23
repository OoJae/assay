import { execFileSync, spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createPublicClient, createWalletClient, http, defineChain, parseAbi, parseAbiItem, zeroAddress } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

/**
 * Verify ERC8056Guard against REAL Robinhood Chain state, on a local fork.
 *
 * A guard whose whole purpose is refusing to return a wrong number cannot be tested against
 * fixtures alone — the interesting cases are a live feed going stale and a token whose multiplier
 * really is 4.0. anvil forks 4663, the contract is deployed into that fork, and time is warped
 * forward to force the staleness branch that would otherwise only be reachable at a weekend.
 *
 *   pnpm test:guard
 */
const PORT = 8599
const RPC = `http://127.0.0.1:${PORT}`
const ANVIL_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as const

const CRWD = '0xea72Ecca2d0f6bFA1394DBBCff85b52CD4233931' as const
const SGOV = '0x92FD66527192E3e61d4DDd13322Aa222DE86F9B5' as const
const SGOV_FEED = '0xa0DF4ee0fFf975306345875E3548Fcc519577A11' as const
/**
 * Nothing here names a holder or an integrator contract.
 *
 * These were an address the old snapshot labelled NOT_AWARE (an AMM pool the classifier now calls
 * NOT_APPLICABLE) and the v4 PoolManager as the CRWD holder, both committed to a public repo that
 * names neither kind. The contract with no uiMultiplier() selector is now the SGOV Chainlink feed
 * proxy, 9,571 bytes of well-known code, and the holder is found on the fork at run time.
 */
const NO_SELECTOR = SGOV_FEED
const NO_SELECTOR_BYTES = 9571n

const abi = parseAbi([
  'function shareEquivalents(address,address) view returns (uint256,bool,string)',
  'function safeShareEquivalents(address,address) view returns (uint256)',
  'function positionValue(address,address,address,uint256) view returns (uint256,bool,string)',
  'function feedUsable(address,uint256) view returns (bool,string)',
  'function referencesMultiplier(address) view returns (bool,uint256)',
])

let failures = 0
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

console.log('forking Robinhood Chain 4663…')
const anvil = spawn('anvil', ['--fork-url', 'https://rpc.mainnet.chain.robinhood.com', '--port', String(PORT), '--silent'], { stdio: 'ignore' })
process.on('exit', () => anvil.kill())
await new Promise((r) => setTimeout(r, 12_000))

const chain = defineChain({ id: 31337, name: 'fork', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [RPC] } } })
const pub = createPublicClient({ chain, transport: http(RPC) })
const wallet = createWalletClient({ account: privateKeyToAccount(ANVIL_KEY), chain, transport: http(RPC) })

execFileSync('solc', ['--optimize', '--optimize-runs', '200', '--combined-json', 'abi,bin', '--overwrite', '-o', 'build', 'contracts/ERC8056Guard.sol'], { stdio: 'ignore' })
const entry = JSON.parse(readFileSync('build/combined.json', 'utf8')).contracts['contracts/ERC8056Guard.sol:ERC8056Guard']
const hash = await wallet.deployContract({ abi, bytecode: `0x${entry.bin}`, args: [] })
const address = (await pub.waitForTransactionReceipt({ hash })).contractAddress!
console.log(`deployed at ${address}\n`)

const call = <T>(fn: string, args: unknown[]) =>
  pub.readContract({ address, abi, functionName: fn as never, args: args as never }) as Promise<T>

const balanceAbi = parseAbi(['function balanceOf(address) view returns (uint256)'])

/** The most recent CRWD recipient that still holds some, read from the fork's own Transfer logs. */
async function findHolder(token: `0x${string}`): Promise<`0x${string}`> {
  const transfer = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)')
  const head = await pub.getBlockNumber()
  for (let to = head; to > head - 200_000n; to -= 20_000n) {
    const logs = await pub.getLogs({ address: token, event: transfer, fromBlock: to - 20_000n, toBlock: to })
    for (const l of logs.reverse()) {
      const who = l.args.to
      if (!who || who === zeroAddress) continue
      const bal = await pub.readContract({ address: token, abi: balanceAbi, functionName: 'balanceOf', args: [who] })
      if (bal > 0n) return who
    }
  }
  throw new Error('no CRWD holder found in the last 200,000 blocks of Transfer logs')
}
const HOLDER = await findHolder(CRWD)

console.log('corrected numbers:')
const [crwdShares, crwdSafe] = await call<[bigint, boolean, string]>('shareEquivalents', [CRWD, HOLDER])
const crwdBal = await pub.readContract({ address: CRWD, abi: balanceAbi, functionName: 'balanceOf', args: [HOLDER] })
check('CRWD shares == balance x 4.0', crwdSafe && crwdBal > 0n && crwdShares === crwdBal * 4n, `${Number(crwdShares) / 1e18}`)

const [, sgovSafe] = await call<[bigint, boolean, string]>('shareEquivalents', [SGOV, HOLDER])
check('SGOV reading is safe', sgovSafe)

console.log('\nintegrator check matches the off-chain auditor:')
const [found, size] = await call<[boolean, bigint]>('referencesMultiplier', [NO_SELECTOR])
check(`a contract without the selector: not found, ${NO_SELECTOR_BYTES} bytes`, !found && size === NO_SELECTOR_BYTES, `${size} bytes`)
const [tokenFound, tokenSize] = await call<[boolean, bigint]>('referencesMultiplier', [SGOV])
check('a 283-byte proxy stub reports small — the documented caveat', !tokenFound && tokenSize < 2048n, `${tokenSize} bytes`)

console.log('\nrefusals — the point of the contract:')
let reverted = false
try { await call<bigint>('safeShareEquivalents', [NO_SELECTOR, HOLDER]) } catch (e) { reverted = /balanceOf\(\) unreadable/.test(String(e)) }
check('safeShareEquivalents reverts with a reason on a non-token', reverted)

const [usableNow] = await call<[boolean, string]>('feedUsable', [SGOV_FEED, 0n])
check('live feed is usable now', usableNow)

await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'evm_increaseTime', params: [259200] }) })
await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'evm_mine', params: [] }) })

const [usableLater, whyNot] = await call<[boolean, string]>('feedUsable', [SGOV_FEED, 0n])
check('after +3 days the feed is REFUSED', !usableLater && whyNot.length > 0, whyNot)
const [value, valueSafe, valueWhy] = await call<[bigint, boolean, string]>('positionValue', [SGOV, HOLDER, SGOV_FEED, 0n])
check('positionValue refuses rather than pricing off a stale feed', !valueSafe && value === 0n, valueWhy)

anvil.kill()
console.log(failures === 0 ? '\nall guard checks passed' : `\n${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
