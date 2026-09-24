/**
 * Baseline response headers.
 *
 * Deliberately NOT a script-src CSP: the App Router bootstraps with inline scripts, and an
 * enforcing policy shipped untested a week before judging could blank the page. What is here
 * cannot break rendering: no framing, no MIME sniffing, no full-URL referrers, and no
 * x-powered-by. The wallet check calls the Robinhood Chain RPC from the browser, which none of
 * these restrict.
 */
/** @type {import('next').NextConfig} */
export default {
  reactStrictMode: true,
  poweredByHeader: false,
  // Parallel agents and a running dev server each build into their own directory; one shared
  // .next corrupts whichever build finishes second. Vercel sets nothing, so production is `.next`.
  distDir: process.env.NEXT_DIST_DIR || '.next',
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'Content-Security-Policy', value: "frame-ancestors 'none'" },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
        ],
      },
      /**
       * The landing's poster frames, and nothing else. They are versioned by directory (v1, v2…),
       * so a changed frame ships under a new path and a year of caching can never serve a stale one.
       * /attestations/* and /agent-card.json are documents third parties re-fetch to verify, and
       * must never be pinned like this.
       */
      {
        source: '/landing/v1/:path*',
        headers: [{ key: 'Cache-Control', value: 'public, max-age=31536000, immutable' }],
      },
    ]
  },
}
