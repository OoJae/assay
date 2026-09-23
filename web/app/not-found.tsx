import Link from 'next/link'

export const metadata = { title: 'Not found' }

export default function NotFound() {
  return (
    <>
      <nav className="navbar" aria-label="Site">
        <span className="brand">ASSAY</span>
        <Link href="/">Findings</Link>
        <Link href="/pricing">Pricing</Link>
      </nav>
      <main>
        <header className="top">
          <div className="tag">404</div>
          <h1>No current finding with that id.</h1>
          <p className="lede">
            Finding ids are stable (<span className="mono">CRWD-share-count</span> is the same finding on
            every sweep that produces it), and a finding page exists only while its condition does, so a
            link that stopped resolving usually means the condition is no longer current. Findings that
            would name a holder contract are the exception: they are withheld from this site, and their
            ids say so rather than landing here.
          </p>
        </header>
        <div className="card">
          <Link href="/">← Back to the findings wall</Link>
        </div>
      </main>
    </>
  )
}
