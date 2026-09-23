/** Addresses and links every page of the wall shares. */

export const SITE = 'https://assay-steel.vercel.app'
export const REPO = 'https://github.com/OoJae/assay'
export const MCP_URL = 'https://sonar.my.id/assay-mcp/sse'
export const FEED_URL = 'https://sonar.my.id/assay-mcp/findings.json'
export const RIGHT_OF_REPLY_DOC = `${REPO}/blob/main/docs/RIGHT-OF-REPLY.md`
export const RIGHT_OF_REPLY_ISSUE = `${REPO}/issues/new?template=right-of-reply.md`

/** Owner of the canonical identity 8453:95374, and the address named in docs/RIGHT-OF-REPLY.md. */
export const OWNER = '0x6328f2fE483922721D94b33eE99e9938Da3b7911'

/**
 * The social card, served by app/og/route.tsx.
 *
 * Declared here rather than through the opengraph-image file convention, because that convention
 * pins the image on the CDN as `immutable, max-age=31536000` behind a build hash: the card went out
 * stating a finding count the wall had stopped showing. Any page that sets its own `openGraph` must
 * repeat this, since Next replaces the whole object rather than merging it.
 */
export const OG_IMAGE = {
  url: '/og',
  width: 1200,
  height: 630,
  alt: 'ASSAY: byte-verified valuation integrity for Stock Tokens on Robinhood Chain',
}

/**
 * Robinhood Chain's terms (§5.7(b)(ii)) require community projects to say this prominently, and a
 * paid tool that grades third parties owes the reader the second half anyway. Rendered on every
 * page from the root layout.
 */
export const DISCLAIMER =
  'ASSAY is an independent project. It is not affiliated with, endorsed by, or officially ' +
  'connected with Robinhood Markets, Inc. or its affiliates, or with Chainlink Labs. "Robinhood ' +
  'Chain" and "Chainlink" are used only to identify the network and the data source. Everything ' +
  'ASSAY publishes or sells is an automated, informational reading of public blockchain state, ' +
  'provided as is and without warranty of any kind. It is not investment, financial, legal or tax ' +
  'advice, it is not a security audit, and a finding is not a statement that any party acted ' +
  'wrongly. Verify independently before acting.'
