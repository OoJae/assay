import { HALLMARK } from './_brand/mark'
import { TransitionLink } from './_motion/transition-link'

export const metadata = { title: 'Not found' }

/**
 * "Unmarked." Laid out as a certificate is: the mark's slot, then the stamp line and the title. A
 * certificate strikes the hallmark in gold there; this page has nothing to strike, so the slot holds
 * the plaque with its score and no A, in ash. docs/BRAND.md reserves this drawing for this page.
 */
export default function NotFound() {
  return (
    <main id="main" className="wrap unmarked">
      <div className="unmarked__plaque">
        <svg viewBox={HALLMARK.viewBox} width={64} height={64} aria-hidden="true">
          <path fill="currentColor" d={HALLMARK.unstruck} />
        </svg>
      </div>
      <div className="unmarked__body">
        <p className="tag">404 · not found</p>
        <h1 className="unmarked__title">Unmarked.</h1>
        <p className="lede">
          No finding carries this mark. Finding ids are stable (<span className="mono">CRWD-share-count</span>{' '}
          is the same finding on every sweep that produces it), and a finding page exists only while its
          condition does, so a link that stopped resolving usually means the condition is no longer current.
        </p>
        <p className="note">
          Findings that would name a holder contract are the exception: they are withheld from this site,
          and their ids say so rather than landing here.
        </p>
        <div className="actions">
          <TransitionLink className="btn primary" href="/wall">
            Open the findings wall
          </TransitionLink>
        </div>
      </div>
    </main>
  )
}
