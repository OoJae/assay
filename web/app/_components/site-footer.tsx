import { AssayLockup } from '../_brand/mark'
import { TransitionLink } from '../_motion/transition-link'
import { DISCLAIMER, REPO } from '@/lib/site'

/**
 * The disclaimer, on every page, at reading size.
 *
 * Robinhood Chain's terms (§5.7(b)(ii)) require it to be prominent, so it is set in the body face
 * at a size people read, never as fine print, under the full ASSAY lockup so the name it opens
 * with outranks every other name in it. The links repeat the header's for phones, where Wall,
 * Pricing, Source and Agent card do not fit in it.
 */
export function SiteFooter() {
  return (
    <footer className="site-footer">
      <div className="site-footer__inner">
        <div className="site-footer__top">
          <AssayLockup height={22} />
          <nav className="site-footer__nav" aria-label="Footer">
            <TransitionLink href="/wall">Wall</TransitionLink>
            <TransitionLink href="/wall#check">Check a wallet</TransitionLink>
            <TransitionLink href="/pricing">Pricing</TransitionLink>
            <a href={REPO}>Source</a>
            <a href="/agent-card.json">Agent card</a>
          </nav>
        </div>
        <p className="site-footer__disclaimer">{DISCLAIMER}</p>
      </div>
    </footer>
  )
}
