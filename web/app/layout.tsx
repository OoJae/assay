import './globals.css'
import type { ReactNode } from 'react'
import type { Metadata, Viewport } from 'next'
import { OG_IMAGE, SITE } from '@/lib/site'
import { fontVariables } from './fonts'
import { MotionProvider } from './_motion/motion-provider'
import { SiteFooter } from './_components/site-footer'
import { SiteHeader } from './_components/site-header'

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

export const viewport: Viewport = {
  themeColor: '#0D0D0C',
  colorScheme: 'dark',
}

/**
 * Runs before first paint, so CSS can lay out for the visitor's motion preference with no swap
 * after hydration: html[data-motion] is "full" or "reduced", and html[data-data="save"] marks
 * Save-Data. With no JS neither attribute exists, and every page falls back to its static layout.
 * suppressHydrationWarning on <html> is for exactly these attributes.
 */
const PRE_PAINT = `(function(){var h=document.documentElement;try{h.dataset.motion=window.matchMedia('(prefers-reduced-motion: reduce)').matches?'reduced':'full'}catch(e){}try{var c=navigator.connection;if(c&&c.saveData)h.dataset.data='save'}catch(e){}})()`

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={fontVariables} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: PRE_PAINT }} />
      </head>
      <body>
        <a className="skip-link" href="#main">
          Skip to content
        </a>
        <MotionProvider>
          <SiteHeader />
          {children}
          <SiteFooter />
        </MotionProvider>
      </body>
    </html>
  )
}
