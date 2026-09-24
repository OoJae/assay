'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'

/**
 * Sections that lived on `/` before the wall moved to /wall. Shared links, the README and old
 * demo recordings point at `/#check` and the like; they land on the same section of the wall.
 */
const LEGACY = new Set([
  '#check',
  '#check-h',
  '#holder',
  '#use-it',
  '#findings-h',
  '#exposure',
  '#notes-h',
  '#proofs-h',
  '#withheld-h',
  '#serv',
])

/**
 * A fragment never reaches the server, so this cannot be a redirect in next.config: it has to run
 * in the browser. `replace`, so Back returns to wherever the visitor came from, not to a page that
 * immediately sends them forward again.
 */
export function LegacyHash() {
  const router = useRouter()
  useEffect(() => {
    const follow = () => {
      const { pathname, hash } = window.location
      if (pathname === '/' && LEGACY.has(hash)) router.replace(`/wall${hash}`)
    }
    follow()
    window.addEventListener('hashchange', follow)
    return () => window.removeEventListener('hashchange', follow)
  }, [router])
  return null
}
