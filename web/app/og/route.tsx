import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ImageResponse } from 'next/og'
import { loadSweepLive } from '@/lib/findings'
import { OG_IMAGE } from '@/lib/site'
import { AssayLockup } from '../_brand/mark'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const TOUCHSTONE = '#0D0D0C'
const CUPEL = '#EEEAE2'
const ASH = '#8C877E'
const STREAK = '#D6B25E'
const RULE = 'rgba(185, 190, 196, 0.24)'

/**
 * The brand faces, as static instances. Satori reads neither woff2 nor variable-font axes, so the
 * files next/font serves the site cannot be reused here. These are the exact cuts the site sets
 * through its axes (Bodoni Moda italic at opsz 96; Martian Mono at wdth 112.5 for stamps and 87.5
 * for figures), subset to Latin-1 punctuation and ASCII, about 45 KB together. Literal paths, so
 * output file tracing ships them with the function. A font that fails to load is left out and
 * Satori's default face stands in; the card still renders.
 */
async function loadFonts() {
  const load = async (file: string, name: string, weight: 400 | 500, style: 'normal' | 'italic') => {
    try {
      return { name, data: await readFile(file), weight, style }
    } catch {
      return null
    }
  }
  const fonts = await Promise.all([
    load(join(process.cwd(), 'app/og/fonts/bodoni-moda-italic-96.ttf'), 'Display', 400, 'italic'),
    load(join(process.cwd(), 'app/og/fonts/martian-mono-wide-500.ttf'), 'Stamp', 500, 'normal'),
    load(join(process.cwd(), 'app/og/fonts/martian-mono-condensed-400.ttf'), 'Figure', 400, 'normal'),
  ])
  return fonts.filter((f) => f !== null)
}

/**
 * The social card, GENERATED from the current sweep rather than shipped as a binary.
 *
 * It used to be app/opengraph-image.tsx, and its comment said rendering from the live loader made
 * a stale count "impossible by construction". It did not: that file convention is served as
 * `immutable, max-age=31536000` behind a build hash, so the first render after each deploy was the
 * card for a year. This route sets its own five-minute cache, and because X and others cache cards
 * on their own terms anyway, the counts are printed with the sweep time and source they belong to.
 *
 * ASSAY is the largest thing on the card: Robinhood Chain's terms (§5.7(b)(iii)) require a
 * project's own name to be more prominent than any use of theirs. The lockup is 88px tall; the one
 * line that names Robinhood Chain is 17px. Gold appears once, on the reproduced count, and only
 * when every citation reproduced: that is the one thing on the card that was byte-compared.
 */
export async function GET() {
  const [d, fonts] = await Promise.all([loadSweepLive(), loadFonts()])
  const cites = d.findings.reduce((n, f) => n + (f.verification?.checked ?? 0), 0)
  const ok = d.findings.reduce((n, f) => n + (f.verification?.reproduced ?? 0), 0)
  const when = new Date(d.observedAt)
  const swept = Number.isFinite(when.getTime())
    ? `${when.toISOString().slice(0, 16).replace('T', ' ')} UTC`
    : 'unknown time'
  const source = d.source === 'live' ? 'LIVE BOARD' : 'COMMITTED SNAPSHOT'

  const label = { display: 'flex', fontFamily: 'Stamp', fontSize: 14, letterSpacing: 1.8, color: ASH } as const
  const figure = { display: 'flex', fontFamily: 'Figure', fontSize: 54, letterSpacing: -1.5, lineHeight: 1 } as const

  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          background: TOUCHSTONE,
          color: CUPEL,
          padding: '64px 72px 52px',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', color: CUPEL }}>
            <AssayLockup height={88} title="" />
          </div>
          <div style={label}>VALUATION INTEGRITY FOR STOCK TOKENS</div>
        </div>

        <div
          style={{
            display: 'flex',
            marginTop: 52,
            fontFamily: 'Display',
            fontStyle: 'italic',
            fontSize: 70,
            lineHeight: 1.02,
            letterSpacing: -1.2,
            // Breaks after "balance": the claim is the second line, whole.
            maxWidth: 680,
          }}
        >
          a Stock Token balance is not a share count.
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', marginTop: 'auto' }}>
          <div style={{ display: 'flex', borderTop: `1px solid ${RULE}`, paddingTop: 26, gap: 64 }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div style={figure}>{String(d.findings.length)}</div>
              <div style={label}>PUBLISHED FINDINGS</div>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div style={{ ...figure, color: cites > 0 && ok === cites ? STREAK : CUPEL }}>{`${ok}/${cites}`}</div>
              <div style={label}>CITATIONS REPRODUCED</div>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div style={figure}>{d.blockNumber}</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <div style={label}>{`BLOCK · SWEPT ${swept}`}</div>
                <div style={label}>{source}</div>
              </div>
            </div>
          </div>
          <div style={{ display: 'flex', marginTop: 30, fontFamily: 'Figure', fontSize: 17, color: ASH }}>
            Stock Tokens on Robinhood Chain 4663 · ERC-8056 · independent, not affiliated with Robinhood
          </div>
        </div>
      </div>
    ),
    {
      width: OG_IMAGE.width,
      height: OG_IMAGE.height,
      fonts,
      headers: { 'Cache-Control': 'public, max-age=300, s-maxage=300' },
    },
  )
}
