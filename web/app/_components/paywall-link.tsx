import type { ReactNode } from 'react'

/**
 * A link to one of the OpenServ paywall pages. It opens in a new tab, so a visitor who goes to
 * look at the price (the page asks for a Base wallet before it shows any input) still has this
 * page behind it. Every paywall link goes through here so none can drift back to the same tab.
 */
export function PaywallLink({ href, className, children }: { href: string; className?: string; children: ReactNode }) {
  return (
    <a className={className} href={href} target="_blank" rel="noopener">
      {children}
      <span className="sr-only"> (opens in a new tab)</span>
    </a>
  )
}
