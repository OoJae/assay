import Link from 'next/link'
import { loadSweepLive } from '@/lib/findings'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'Pricing — ASSAY' }

const SETTLED_TX = '0x50124847a9228521b829e3b47a2b098f5688e57d147e33764232c4c8f686b96b'
const REPO = 'https://github.com/OoJae/assay'

/**
 * What is purchasable TODAY, and what is not.
 *
 * The distinction is load-bearing: shipping the attestation mechanism is not the same as having
 * customers for it, and a price list that does not say so is the same kind of overclaim this
 * project exists to catch.
 */
const TIERS = [
  {
    name: 'Findings wall',
    price: 'Free',
    state: 'live' as const,
    what: 'Every published finding, its raw return bytes, and the cast command that reproduces it.',
  },
  {
    name: 'assay_true_position()',
    price: '$0.01',
    state: 'live' as const,
    what:
      'The corrected ERC-8056 position for one holder: raw balance, uiMultiplier, share-equivalents, multiplier-adjusted price, oracle hygiene, and an explicit refusal when the read is not safe to act on. Available over x402, MCP (SSE) and as an AgentKit action.',
  },
  {
    name: 'assay_check_contract()',
    price: '$0.25',
    state: 'live' as const,
    what:
      'Audit any address on chain 4663: does its deployed bytecode reference uiMultiplier(), which ' +
      'divergent-multiplier Stock Tokens does it hold, and how many share-equivalents go unaccounted ' +
      'for if those balances are read as share counts. Resolves EIP-1967, beacon and EIP-1167 proxies ' +
      'to the implementation before deciding, and returns PROXY_UNRESOLVED rather than a verdict when ' +
      'it cannot. Priced above the per-position check because it answers a question about a ' +
      'counterparty, which is the one you ask before you act.',
  },
  {
    name: 'Full evidence pack',
    price: '$2.00',
    state: 'roadmap' as const,
    what:
      'Every citation for a subject in one signed document. Not purchasable: OpenServ payWorkflow() enforces a hard $0.10 client-side ceiling, so this needs a different x402 client than the one demonstrated.',
  },
  {
    name: 'Continuous monitoring',
    price: '$19/mo',
    state: 'roadmap' as const,
    what: 'A watched address or agent, re-swept on a schedule. Not purchasable: no recurring billing is wired.',
  },
  {
    name: 'Solicited CLEAN attestation',
    price: '$50.00',
    state: 'roadmap' as const,
    what:
      'An on-chain ERC-8004 ValidationRegistry verdict a subject requested about itself. The mechanism is built and has been exercised once — by ASSAY, on ASSAY. Not purchasable: no third party has bought one, so pricing it as a product would be a claim about demand we cannot make.',
  },
]

export default async function Pricing() {
  const d = await loadSweepLive()
  return (
    <div className="wrap">
      <nav className="navbar">
        <span className="brand">ASSAY</span>
        <Link href="/">Findings</Link>
        <a href={REPO}>Source</a>
      </nav>

      <header className="top">
        <h1>Pricing</h1>
        <p className="lede">
          One line is purchasable today and it is the cheap one. The rest are built, partly built,
          or priced — and each says which. A price list that reads as revenue when it is really a
          roadmap is the same overclaim ASSAY audits other people for.
        </p>
      </header>

      <div className="banner">
        <strong>What the revenue evidence actually is.</strong> Four x402 payments of $0.01 have
        settled on Base, between two wallets this project controls.{' '}
        <a href={`https://basescan.org/tx/${SETTLED_TX}`}>The most recent one is on-chain</a>. That
        proves the <em>rail works end to end</em> — discovery, EIP-3009 authorization, relayed
        settlement, the agent answering, the buyer getting a result. It is{' '}
        <strong>plumbing, not demand</strong>. No external party has paid ASSAY for anything.
      </div>

      <div className="tscroll">
        <table>
          <thead>
            <tr>
              <th style={{ width: 210 }}>Tier</th>
              <th style={{ width: 90 }}>Price</th>
              <th style={{ width: 110 }}>Status</th>
              <th>What it is</th>
            </tr>
          </thead>
          <tbody>
            {TIERS.map((t) => (
              <tr key={t.name} className={t.state === 'roadmap' ? 'withheld' : undefined}>
                <td className="sym">{t.name}</td>
                <td className="mono">{t.price}</td>
                <td>
                  <span className={`rsn ${t.state === 'live' ? 'unverifiable_here' : 'unchecked'}`}>
                    {t.state === 'live' ? 'purchasable' : 'roadmap'}
                  </span>
                </td>
                <td className="sub" style={{ margin: 0 }}>
                  {t.what}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h2 className="h2">Why these two prices are different</h2>
      <p className="sub">
        The OpenServ x402 marketplace lists 473 services, 80 of them active, at a median of $0.02 —
        and 83% of everything ever listed is now dead. A per-position check has to be cheap enough
        to run before <em>every</em> valuation, which is the only pattern that makes an audit
        primitive load-bearing rather than occasional; that is the $0.01 line and it stays there.
      </p>
      <p className="sub" style={{ marginTop: 10 }}>
        <span className="mono">assay_check_contract</span> is a different kind of question. It is
        asked once, about a counterparty, before deciding whether to rely on its accounting — and it
        returns a named verdict with bytecode evidence rather than a number. It is priced as a
        decision, not a lookup. The {d.findings.length} findings on the wall are the reason to call
        either one.
      </p>

      <footer>
        The findings count is read from the current sweep and the payment link is a transaction you
        can open on Basescan. The marketplace figures in the section above — 471 listed services, 77
        active, a $0.01 median — are from a snapshot of{' '}
        <span className="mono">api.openserv.ai/x402-services</span> taken while building this, and
        are not re-fetched. Tiers marked roadmap are not purchasable and no checkout exists for them.
      </footer>
    </div>
  )
}
