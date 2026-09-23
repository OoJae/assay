import { ImageResponse } from 'next/og'
import { loadSweepLive } from '@/lib/findings'
import { OG_IMAGE } from '@/lib/site'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * The social card, GENERATED from the current sweep rather than shipped as a binary.
 *
 * It used to be app/opengraph-image.tsx, and its comment said rendering from the live loader made
 * a stale count "impossible by construction". It did not: that file convention is served as
 * `immutable, max-age=31536000` behind a build hash, so the first render after each deploy was the
 * card for a year. This route sets its own five-minute cache, and because X and others cache cards
 * on their own terms anyway, the counts are printed with the sweep time they belong to.
 *
 * ASSAY is the largest thing on the card: Robinhood Chain's terms (§5.7(b)(iii)) require a
 * project's own name to be more prominent than any use of theirs, and the old banner set both in
 * one 22px line.
 */
export async function GET() {
  const d = await loadSweepLive()
  const cites = d.findings.reduce((n, f) => n + (f.verification?.checked ?? 0), 0)
  const ok = d.findings.reduce((n, f) => n + (f.verification?.reproduced ?? 0), 0)
  const when = new Date(d.observedAt)
  const swept = Number.isFinite(when.getTime())
    ? `${when.toISOString().slice(0, 16).replace('T', ' ')} UTC`
    : 'unknown time'

  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
          background: '#0b0d10',
          color: '#e6edf3',
          padding: '60px 72px',
          fontFamily: 'monospace',
        }}
      >
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          <div style={{ display: 'flex', fontSize: 112, fontWeight: 700, letterSpacing: 6, color: '#4ec9a5' }}>
            ASSAY
          </div>
          <div style={{ display: 'flex', fontSize: 50, lineHeight: 1.15, fontWeight: 700, marginTop: 8 }}>
            balanceOf() is not a share count.
          </div>
        </div>
        <div style={{ display: 'flex', gap: 56 }}>
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            <div style={{ display: 'flex', fontSize: 46, fontWeight: 700 }}>{d.findings.length}</div>
            <div style={{ display: 'flex', fontSize: 18, color: '#8b98a8' }}>PUBLISHED FINDINGS</div>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            <div style={{ display: 'flex', fontSize: 46, fontWeight: 700, color: '#4ec9a5' }}>{`${ok}/${cites}`}</div>
            <div style={{ display: 'flex', fontSize: 18, color: '#8b98a8' }}>CITATIONS REPRODUCED</div>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'flex-end' }}>
            <div style={{ display: 'flex', fontSize: 18, color: '#8b98a8' }}>{`SWEPT ${swept}`}</div>
          </div>
        </div>
        <div style={{ display: 'flex', fontSize: 18, color: '#8b98a8' }}>
          Stock Tokens on Robinhood Chain 4663 · ERC-8056 · independent, not affiliated with Robinhood
        </div>
      </div>
    ),
    {
      width: OG_IMAGE.width,
      height: OG_IMAGE.height,
      headers: { 'Cache-Control': 'public, max-age=300, s-maxage=300' },
    },
  )
}
