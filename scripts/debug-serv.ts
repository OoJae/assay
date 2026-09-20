import 'dotenv/config'
import { readFileSync } from 'node:fs'
import { verifyFinding } from '../src/verify/index.js'
import { servClient, buildUserMessage } from '../src/adjudicate/serv.js'
import { METHODOLOGY_SYSTEM_PROMPT } from '../src/adjudicate/methodology.js'
import type { Finding } from '../src/sweep/types.js'

const data = JSON.parse(readFileSync('data/findings.json', 'utf8')) as { findings: Finding[] }
const f = data.findings.find((x) => x.id === 'CRWD-share-count')!
const v = (await verifyFinding(f))!

const client = servClient()
const res = await client.chat.completions.create({
  model: 'gpt-5.6-luna',
  messages: [
    { role: 'system', content: METHODOLOGY_SYSTEM_PROMPT },
    { role: 'user', content: buildUserMessage(v, 'Test mandate: we display positions in shares using balanceOf().') },
  ],
  max_completion_tokens: 2000,
  tools: [
    { type: 'function', function: { name: 'serv_prompt_guard' } },
    { type: 'function', function: { name: 'serv_shadow_agent', parameters: { type: 'object', properties: { hint: { type: 'string', default: 'binding_evidence must quote verbatim claims.' }, max_iterations: { type: 'integer', default: 3 } } } } },
  ] as never,
  response_format: {
    type: 'json_schema',
    json_schema: {
      name: 'adjudication',
      strict: true,
      schema: {
        type: 'object',
        properties: {
          verdict: { type: 'string', enum: ['MATERIAL_MISSTATEMENT','CONTROL_WEAKNESS','BENIGN','WITHHELD'] },
          severity: { type: 'string', enum: ['critical','high','medium','low','info'] },
          rationale: { type: 'string' },
          binding_evidence: { type: 'array', items: { type: 'string' } },
          withheld_reason: { type: ['string','null'] },
        },
        required: ['verdict','severity','rationale','binding_evidence','withheld_reason'],
        additionalProperties: false,
      },
    },
  } as never,
})
const c = res.choices[0]
console.log('finish_reason:', c?.finish_reason)
console.log('usage:', JSON.stringify(res.usage))
console.log('--- raw content start ---')
console.log(JSON.stringify(c?.message?.content)?.slice(0, 1500))
console.log('--- raw content end ---')
