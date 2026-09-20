import { truePosition } from '../src/lib/position.js'

const [symbol, holder] = process.argv.slice(2)
if (!symbol || !holder) {
  console.error('usage: tsx scripts/true-position.ts <SYMBOL> <0xholder>')
  process.exit(1)
}
const p = await truePosition(symbol, holder as `0x${string}`)
console.log(JSON.stringify(p, null, 2))
