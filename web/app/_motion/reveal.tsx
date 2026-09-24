'use client'

import { useEffect, useRef, type ReactNode } from 'react'
import { loadRuntime } from './nav'

type Tag = 'h2' | 'h3' | 'p' | 'div'

/**
 * A heading that reveals line by line when it scrolls into view (masked lines rising, once).
 *
 * For headings below the fold only. It renders the heading exactly as the server did; the split
 * happens after the runtime loads, and only if the heading is still off screen by then (see
 * reveal() in ./runtime), so without JS, or with a slow chunk, the text is simply there.
 * Reduced motion gets an opacity fade instead of moving lines.
 */
export function Reveal({
  as: Tag = 'h2',
  children,
  className,
  id,
}: {
  as?: Tag
  children: ReactNode
  className?: string
  id?: string
}) {
  const ref = useRef<HTMLHeadingElement & HTMLParagraphElement & HTMLDivElement>(null)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    let cancelled = false
    let revert: (() => void) | undefined
    loadRuntime()
      .then((rt) => {
        if (!cancelled) revert = rt.reveal(el)
      })
      .catch(() => {})
    return () => {
      cancelled = true
      revert?.()
    }
  }, [])

  return (
    <Tag ref={ref} className={className} id={id}>
      {children}
    </Tag>
  )
}
