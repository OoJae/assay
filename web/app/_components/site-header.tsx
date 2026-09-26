import { AssayLockup, AssayMark } from '../_brand/mark'
import { TransitionLink } from '../_motion/transition-link'
import { PAID_ENDPOINTS } from '@/lib/endpoints'
import { REPO } from '@/lib/site'
import { NavLink } from './nav-link'
import { PaywallLink } from './paywall-link'

/**
 * The one header every page shares; the per-page navs it replaces had drifted apart.
 *
 * Labels are fixed: docs/DEMO.md's recorded script says "Check a wallet" and "Try it · $0.01".
 * On a phone (560px and under) it keeps the brand, the free wallet check and the paid call to
 * action; Wall, Pricing, Source and Agent card are one tap away in the footer. The free check
 * stays because without it a phone's only way in was the paid one. Under 360px the lockup gives
 * way to the mark alone (globals.css), so both still fit a 320px screen.
 *
 * The rail at its foot is the sterling hairline a route change scribes across.
 */
export function SiteHeader() {
  const tp = PAID_ENDPOINTS.truePosition
  return (
    <header className="site-header">
      <div className="site-header__bar">
        <TransitionLink href="/" className="site-brand">
          <AssayLockup height={24} className="site-brand__lockup" />
          <AssayMark size={32} className="site-brand__mark" />
        </TransitionLink>
        <nav className="site-nav" aria-label="Site">
          <NavLink href="/wall">Wall</NavLink>
          <NavLink href="/pricing">Pricing</NavLink>
          <a className="site-nav__wide" href={REPO}>
            Source
          </a>
          <a className="site-nav__wide" href="/agent-card.json">
            Agent card
          </a>
        </nav>
        <div className="site-header__actions">
          <NavLink href="/wall#check">Check a wallet</NavLink>
          <PaywallLink className="btn primary btn--sm" href={tp.paywall}>
            Try it · ${tp.priceUsd.toFixed(2)}
          </PaywallLink>
        </div>
      </div>
      <span className="site-rail" aria-hidden="true" />
    </header>
  )
}
