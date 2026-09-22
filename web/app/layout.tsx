import './globals.css'
import type { ReactNode } from 'react'
import type { Metadata } from 'next'

const SITE = 'https://assay-steel.vercel.app'

export const metadata: Metadata = {
  metadataBase: new URL(SITE),
  title: {
    default: 'ASSAY — valuation integrity for Robinhood Chain',
    template: '%s · ASSAY',
  },
  description:
    'Independent, byte-verified audit of how agents value tokenized equities on Robinhood Chain. Every published citation is re-fetched from chain state and byte-compared.',
  openGraph: {
    type: 'website',
    siteName: 'ASSAY',
    url: SITE,
    title: 'ASSAY — valuation integrity for Robinhood Chain',
    description:
      'ERC-8056 corporate actions move uiMultiplier(), not balances. ASSAY sweeps the chain and publishes only findings whose every citation reproduces byte-for-byte.',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'ASSAY — valuation integrity for Robinhood Chain',
    description:
      'Byte-verified findings on Robinhood Chain 4663. Publishes what it withheld, too.',
  },
}

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
