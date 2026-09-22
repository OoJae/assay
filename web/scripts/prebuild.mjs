import { existsSync, mkdirSync, copyFileSync } from 'node:fs'

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

const files = [
  { name: 'findings.json', required: true },
  { name: 'replies.json', required: false },
]

for (const { name, required } of files) {
  const src = `../data/${name}`
  if (existsSync(src)) {
    copyFileSync(src, `data/${name}`)
    console.log(`copied ${name} from repo root`)
  } else if (existsSync(`data/${name}`)) {
    console.log(`using bundled web/data/${name}`)
  } else if (required) {
    console.warn(`WARNING: no ${name} found; the board will render empty`)
  }
}
