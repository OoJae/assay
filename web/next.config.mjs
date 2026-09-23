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
    ]
  },
}
