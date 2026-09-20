import './globals.css'
import type { ReactNode } from 'react'

export const metadata = {
  title: 'ASSAY — valuation integrity for Robinhood Chain',
  description:
    'Independent, byte-verified audit of how agents value tokenized equities on Robinhood Chain.',
}

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
