'use client'

import type { ReactNode } from 'react'
import { usePathname } from 'next/navigation'
import { TransitionLink } from '../_motion/transition-link'

/**
 * A header link that knows when it is the current page.
 *
 * usePathname() only: useSearchParams() would opt the statically rendered landing out of static
 * rendering for the whole tree under the header. A link with a hash ("Check a wallet") is an
 * action on a page, not the page, so it is never marked current.
 */
export function NavLink({ href, className, children }: { href: string; className?: string; children: ReactNode }) {
  const pathname = usePathname()
  const current = !href.includes('#') && pathname === href
  return (
    <TransitionLink href={href} className={className} aria-current={current ? 'page' : undefined}>
      {children}
    </TransitionLink>
  )
}
