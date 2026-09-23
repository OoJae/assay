import { existsSync, mkdirSync, copyFileSync, readFileSync, writeFileSync } from 'node:fs'

/**
 * Copy the published artifacts into the Next project root.
 *
 * Vercel only bundles files INSIDE the project root, so reading '../data' works locally and
 * silently yields an empty board once deployed — which is exactly how this shipped once, rendering
 * a page that looked fine and said nothing.
 *
 * findings.json is required; replies.json is optional but must be copied too, or the right-of-reply
 * panel reads an absent file in production while working perfectly on a laptop.
 */
mkdirSync('data', { recursive: true })

/**
 * Named-integrator rows never reach the bundle.
 *
 * This copy is the wall's fallback, and a plain copyFileSync once put 25 rows naming 17 contracts
 * into it (and onto GitHub) in the very commit that withheld them from the live feed. The sweep now
 * redacts at the source and web/lib/findings.ts filters again on load (publicOnly, the same rule);
 * this is the layer that keeps them out of the deployed file. A board with nothing to strip is
 * copied byte-for-byte.
 */
const NAMED_INTEGRATOR_CLASS = 'INTEGRATOR_NOT_MULTIPLIER_AWARE'
const namesIntegrator = (f) =>
  !!f &&
  (f.defectClass === NAMED_INTEGRATOR_CLASS ||
    (f.defectClass === undefined && /^0x[0-9a-fA-F]{40}\b/.test(f.subject ?? '')))

function copyFindings(src, dest) {
  const board = JSON.parse(readFileSync(src, 'utf8'))
  const findings = Array.isArray(board.findings) ? board.findings : []
  const rejected = Array.isArray(board.rejected) ? board.rejected : []
  const keptFindings = findings.filter((f) => !namesIntegrator(f))
  const keptRejected = rejected.filter((r) => !namesIntegrator(r?.finding))
  const dropped = findings.length - keptFindings.length
  const droppedRejected = rejected.length - keptRejected.length
  if (dropped === 0 && droppedRejected === 0) {
    if (src !== dest) copyFileSync(src, dest)
    return 0
  }
  const redacted = {
    ...board,
    findings: keptFindings,
    rejected: keptRejected,
    withheld: {
      ...board.withheld,
      namedIntegrators: (board.withheld?.namedIntegrators ?? 0) + dropped,
      namedIntegratorsRejected: (board.withheld?.namedIntegratorsRejected ?? 0) + droppedRejected,
    },
  }
  writeFileSync(dest, `${JSON.stringify(redacted, null, 2)}\n`)
  return dropped + droppedRejected
}

const files = [
  { name: 'findings.json', required: true },
  { name: 'replies.json', required: false },
]

for (const { name, required } of files) {
  const src = `../data/${name}`
  if (existsSync(src)) {
    if (name === 'findings.json') {
      const stripped = copyFindings(src, `data/${name}`)
      console.log(`copied ${name} from repo root${stripped ? `, withholding ${stripped} named-integrator rows` : ''}`)
    } else {
      copyFileSync(src, `data/${name}`)
      console.log(`copied ${name} from repo root`)
    }
  } else if (existsSync(`data/${name}`)) {
    // Vercel uploads only web/, so this committed copy is what deploys: filter it in place too.
    const stripped = name === 'findings.json' ? copyFindings(`data/${name}`, `data/${name}`) : 0
    console.log(`using bundled web/data/${name}${stripped ? `, withholding ${stripped} named-integrator rows` : ''}`)
  } else if (required) {
    console.warn(`WARNING: no ${name} found; the board will render empty`)
  }
}
