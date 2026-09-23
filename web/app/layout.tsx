import './globals.css'
import type { ReactNode } from 'react'
import type { Metadata } from 'next'
import { DISCLAIMER, OG_IMAGE, SITE } from '@/lib/site'

// "Stock Tokens", never "tokenized equities": Robinhood Chain's terms (§5.7(j)) name the approved
// terminology, and this description is the meta tag on every page.
const DESCRIPTION =
  'Independent, byte-verified audit of how agents value Stock Tokens on Robinhood Chain. Every published citation is re-fetched from chain state and byte-compared. Not affiliated with Robinhood.'

export const metadata: Metadata = {
  metadataBase: new URL(SITE),
  title: {
    default: 'ASSAY — valuation integrity for Stock Tokens',
    template: '%s · ASSAY',
  },
  description: DESCRIPTION,
  openGraph: {
    type: 'website',
    siteName: 'ASSAY',
    url: SITE,
    title: 'ASSAY — valuation integrity for Stock Tokens',
    description:
      'ERC-8056 corporate actions move uiMultiplier(), not balances. ASSAY sweeps Robinhood Chain and publishes only findings whose every citation reproduces byte-for-byte. Independent; not affiliated with Robinhood.',
    images: [OG_IMAGE],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'ASSAY — valuation integrity for Stock Tokens',
    description: 'Byte-verified findings on Robinhood Chain 4663. Shows what its verifier withheld, too.',
    images: [OG_IMAGE.url],
  },
}

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <div className="wrap">
          {children}
          <footer className="disclaimer">{DISCLAIMER}</footer>
        </div>
      </body>
    </html>
  )
}
