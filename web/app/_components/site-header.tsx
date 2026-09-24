import { AssayLockup } from '../_brand/mark'
import { TransitionLink } from '../_motion/transition-link'
import { PAID_ENDPOINTS } from '@/lib/endpoints'
import { REPO } from '@/lib/site'
import { NavLink } from './nav-link'

/**
 * The one header every page shares; the per-page navs it replaces had drifted apart.
 *
 * Labels are fixed: docs/DEMO.md's recorded script says "Check a wallet" and "Try it · $0.01".
 * Under 560px it keeps the mark, Wall, Pricing and the call to action; Source, Agent card and the
 * wallet check are one tap away in the footer and on the wall itself. Under 360px Pricing goes to
 * the footer too: the mark, Wall and the call to action alone fill a 320px screen.
 *
 * The rail at its foot is the sterling hairline a route change scribes across.
 */
export function SiteHeader() {
  const tp = PAID_ENDPOINTS.truePosition
  return (
    <header className="site-header">
      <div className="site-header__bar">
        <TransitionLink href="/" className="site-brand">
          <AssayLockup height={24} />
        </TransitionLink>
        <nav className="site-nav" aria-label="Site">
          <NavLink href="/wall">Wall</NavLink>
          <NavLink href="/pricing" className="site-nav__mid">
            Pricing
          </NavLink>
          <a className="site-nav__wide" href={REPO}>
            Source
          </a>
          <a className="site-nav__wide" href="/agent-card.json">
            Agent card
          </a>
        </nav>
        <div className="site-header__actions">
          <NavLink href="/wall#check" className="site-nav__wide">
            Check a wallet
          </NavLink>
          <a className="btn primary btn--sm" href={tp.paywall}>
            Try it · ${tp.priceUsd.toFixed(2)}
          </a>
        </div>
      </div>
      <span className="site-rail" aria-hidden="true" />
    </header>
  )
}
