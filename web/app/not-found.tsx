import Link from 'next/link'

export default function NotFound() {
  return (
    <div className="wrap">
      <nav className="navbar">
        <span className="brand">ASSAY</span>
        <Link href="/">Findings</Link>
        <Link href="/pricing">Pricing</Link>
      </nav>
      <header className="top">
        <div className="tag">404</div>
        <h1>No finding with that id.</h1>
        <p className="lede">
          Finding ids are minted per sweep and the wall is regenerated on a schedule, so a link to a
          finding from an earlier snapshot can stop resolving once that condition clears. That is
          the honest behaviour: the finding is not being hidden, it is no longer current.
        </p>
      </header>
      <div className="card">
        <Link href="/">← Back to the findings wall</Link>
      </div>
    </div>
  )
}
