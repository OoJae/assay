import 'dotenv/config'
import { servClient, buildUserMessage, adjudicationRequest, parseAdjudication, AdjudicatorError } from '../src/adjudicate/serv.js'
import { loadFindingForAdjudication } from './adjudicate-one.js'

/**
 * Print the RAW SERV response for one finding: finish_reason, refusal, usage, the content, and
 * what the parser makes of it. A development tool; it spends a SERV call.
 *
 *   tsx scripts/debug-serv.ts [--id=CRWD-share-count] [--dev]
 *
 * It sends adjudicationRequest(), the request adjudicate() sends, so what it diagnoses is what
 * production runs; the hand-copied request it used to send had drifted (another model, 3 shadow
 * iterations, no reasoning_effort). And it goes through the same finding lookup as
 * adjudicate-one.ts, which handles a pruned citation instead of dereferencing a null.
 */
const args = process.argv.slice(2)
const id = args.find((a) => a.startsWith('--id='))?.split('=')[1] ?? 'CRWD-share-count'

const loaded = await loadFindingForAdjudication(id)
if (!loaded.ok) {
  console.error(loaded.reason)
  process.exit(1)
}
console.error(`finding ${id} (${loaded.source})`)

const userMessage = buildUserMessage(loaded.finding, 'Test mandate: we display positions in shares using balanceOf().')
const { model, body, options } = adjudicationRequest(userMessage, { dev: args.includes('--dev') })
const res = await servClient().chat.completions.create(body, options)
const c = res.choices[0]
console.log('model:', model)
console.log('finish_reason:', c?.finish_reason)
console.log('refusal:', c?.message?.refusal ?? null)
console.log('usage:', JSON.stringify(res.usage))
console.log('--- raw content start ---')
console.log(JSON.stringify(c?.message?.content)?.slice(0, 1500))
console.log('--- raw content end ---')
try {
  const parsed = parseAdjudication(c?.message?.content, c?.finish_reason ?? '', c?.message?.refusal)
  console.log(`parsed: ${parsed.verdict} / ${parsed.severity}`)
} catch (e) {
  if (!(e instanceof AdjudicatorError)) throw e
  console.log(`parsed: ${e.message}`)
}
