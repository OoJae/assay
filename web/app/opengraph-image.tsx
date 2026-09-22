import { ImageResponse } from 'next/og'
import { loadSweep } from '@/lib/findings'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const alt = 'ASSAY — byte-verified valuation integrity for Robinhood Chain'
export const size = { width: 1200, height: 630 }
export const contentType = 'image/png'

/**
 * The social card is GENERATED from the current sweep rather than shipped as a binary.
 *
 * A hand-made og.png would state a finding count that drifts from the wall the moment the next
 * sweep lands — publishing a number we no longer stand behind, on the surface most people see and
 * least people click through from. Rendering it from the same loader the page uses makes that
 * impossible by construction.
 */
export default async function Image() {
  const d = loadSweep()
  const cites = d.findings.reduce((n, f) => n + (f.verification?.checked ?? 0), 0)
  const ok = d.findings.reduce((n, f) => n + (f.verification?.reproduced ?? 0), 0)

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
          padding: '64px 72px',
          fontFamily: 'monospace',
        }}
      >
        <div style={{ display: 'flex', fontSize: 22, letterSpacing: 4, color: '#8b98a8' }}>
          ASSAY · ROBINHOOD CHAIN 4663 · ERC-8056
        </div>
        <div style={{ display: 'flex', fontSize: 62, lineHeight: 1.12, fontWeight: 700 }}>
          Every cited byte was re-fetched and compared.
        </div>
        <div style={{ display: 'flex', gap: 56 }}>
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            <div style={{ display: 'flex', fontSize: 54, fontWeight: 700 }}>{d.findings.length}</div>
            <div style={{ display: 'flex', fontSize: 20, color: '#8b98a8' }}>PUBLISHED FINDINGS</div>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            <div style={{ display: 'flex', fontSize: 54, fontWeight: 700, color: '#4ec9a5' }}>
              {`${ok}/${cites}`}
            </div>
            <div style={{ display: 'flex', fontSize: 20, color: '#8b98a8' }}>CITATIONS REPRODUCED</div>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            <div style={{ display: 'flex', fontSize: 54, fontWeight: 700 }}>{d.assetsScanned}</div>
            <div style={{ display: 'flex', fontSize: 20, color: '#8b98a8' }}>ASSETS SWEPT</div>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            <div style={{ display: 'flex', fontSize: 54, fontWeight: 700, color: '#e8c547' }}>
              {(d.rejected ?? []).length}
            </div>
            <div style={{ display: 'flex', fontSize: 20, color: '#8b98a8' }}>WITHHELD</div>
          </div>
        </div>
      </div>
    ),
    size,
  )
}
