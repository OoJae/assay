import Link from 'next/link'
import { loadSweepLive } from '@/lib/findings'
import { PAID_ENDPOINTS, PAY_TO } from '@/lib/endpoints'
import { PaywallLink } from '../_components/paywall-link'
import { UseIt } from '../_components/use-it'
import { Reveal } from '../_motion/reveal'

export const dynamic = 'force-dynamic'
// The layout template appends " · ASSAY"; "Pricing — ASSAY" rendered as "Pricing — ASSAY · ASSAY".
export const metadata = { title: 'Pricing' }

const CONTRACT_AUDIT_TX = '0xc192e7b94cdd9b1ae4c77e4602f3fad75067b96b19fd24c6d5d2441a4febc3b2'
const SETTLED_TX_95265 = '0x50124847a9228521b829e3b47a2b098f5688e57d147e33764232c4c8f686b96b'

/**
 * One dated snapshot of the marketplace, used everywhere on this page.
 *
 * The page used to quote 473 / 80 / $0.02 in one section and 471 / 77 / $0.01 in its footer, on the
 * page a judge reads for revenue potential. These are the figures the audit re-measured.
 */
const MARKET = { listed: 479, active: 84, medianActiveUsd: '0.02', asOf: '2026-09-22' }

type State = 'free' | 'live' | 'roadmap'

/**
 * What is purchasable TODAY, and what is not.
 *
 * The distinction is load-bearing: shipping the attestation mechanism is not the same as having
 * customers for it, and a price list that does not say so is the same kind of overclaim this
 * project exists to catch.
 */
const TIERS: Array<{ name: string; price: string; state: State; what: string }> = [
  {
    name: 'Findings wall and feed',
    price: 'Free',
    state: 'free',
    what: 'Every published finding, its raw return bytes, and the cast command that reproduces it; the same board as JSON.',
  },
  {
    name: 'Public MCP',
    price: 'Free',
    state: 'free',
    what:
      'Published findings, a fresh sweep of one ticker, and the verdict alone for a position or a contract: can this position be valued safely, and is this contract multiplier-aware, with no holdings or figures.',
  },
  {
    name: 'ERC8056Guard',
    price: 'Free',
    state: 'free',
    what:
      'An ownerless, view-only contract on chain 4663: share-equivalents for any holder, or a refusal with its reason. The wallet check on the wall calls it from your browser.',
  },
  {
    name: 'assay_true_position()',
    price: '$0.01',
    state: 'live',
    what:
      'The corrected ERC-8056 position for one holder: raw balance, uiMultiplier, share-equivalents, the Chainlink price and USD value, oracle checks, any scheduled multiplier change, and an explicit refusal when the read is not safe to act on. Tokens without a Chainlink feed get the share-equivalents and a refused USD value. Sold over x402; the same open-source code also runs locally as an AgentKit action.',
  },
  {
    name: 'assay_check_contract()',
    price: '$0.25',
    state: 'live',
    what:
      'The named audit of any address on chain 4663: its verdict with bytecode evidence, every holding of every Stock Token whose multiplier is not 1, and how many share-equivalents go unaccounted for if those balances are read as share counts. Resolves EIP-1967, beacon and EIP-1167 proxies ' +
      'to the implementation before deciding, returns PROXY_UNRESOLVED rather than a verdict when it cannot, and returns NOT_APPLICABLE with a role for pools and custody. Priced above the per-position check because it answers a question about a ' +
      'counterparty, which is the one you ask before you act.',
  },
  {
    name: 'Full evidence pack',
    price: '$2.00',
    state: 'roadmap',
    what:
      'Every citation for a subject in one signed document. Not purchasable: no workflow for it exists yet. (This previously blamed a $0.10 ceiling in OpenServ payWorkflow(). That ceiling is only the DEFAULT of the SDK\'s wrapFetchWithPayment, which accepts an explicit one — the $0.25 tier above is paid exactly that way.)',
  },
  {
    name: 'Continuous monitoring',
    price: '$19/mo',
    state: 'roadmap',
    what: 'A watched address or agent, re-swept on a schedule. Not purchasable: no recurring billing is wired.',
  },
  {
    name: 'Solicited mandate attestation',
    price: '$50.00',
    state: 'roadmap',
    what:
      'An on-chain ERC-8004 ValidationRegistry verdict a subject requested about itself, adjudicated by SERV Reasoning against its declared mandate. Only the declared text is graded, so the best outcome is NO_MATERIAL_EXPOSURE_AS_DECLARED (80), never CLEAN. The solicited path is built but has not been exercised: no third party has requested one, and the one attestation on-chain is ASSAY\'s own, self-issued under frozen identity 95265. Not purchasable, because pricing it as a product would be a claim about demand we cannot make.',
  },
]

/* The status is a stamp on each tariff card: sterling for free, cupel for what can be bought, a
   dashed ash outline for what cannot. */
const STATUS: Record<State, { label: string; cls: string }> = {
  free: { label: 'free', cls: 'stamp--free' },
  live: { label: 'purchasable', cls: 'stamp--live' },
  roadmap: { label: 'roadmap', cls: 'stamp--roadmap' },
}

export default async function Pricing() {
  const d = await loadSweepLive()
  return (
    <>
      <main id="main" className="wrap">
        <header className="top">
          <h1 className="page-title">Pricing</h1>
          <p className="lede">
            Two lines are purchasable today: the ${PAID_ENDPOINTS.truePosition.priceUsd.toFixed(2)} position
            check and the ${PAID_ENDPOINTS.checkContract.priceUsd.toFixed(2)} contract audit. Three things
            are free. The rest are built, partly built, or priced, and each says which. A price list that
            reads as revenue when it is really a roadmap is the same overclaim ASSAY audits other people
            for.
          </p>
          <div className="actions">
            <PaywallLink className="btn primary" href={PAID_ENDPOINTS.truePosition.paywall}>
              Try the ${PAID_ENDPOINTS.truePosition.priceUsd.toFixed(2)} position check
            </PaywallLink>
            <PaywallLink className="btn" href={PAID_ENDPOINTS.checkContract.paywall}>
              Audit a contract · ${PAID_ENDPOINTS.checkContract.priceUsd.toFixed(2)}
            </PaywallLink>
            <Link className="btn" href="/wall#check">
              Check a wallet · free
            </Link>
          </div>
        </header>

        <div className="banner">
          <strong>What the revenue evidence actually is.</strong> Five x402 payments have settled on Base.
          Four of $0.01 went to the wallet of identity 95265 (
          <a href={`https://basescan.org/tx/${SETTLED_TX_95265}`}>the latest</a>), which is now frozen
          because its signing key was lost; one{' '}
          <a href={`https://basescan.org/tx/${CONTRACT_AUDIT_TX}`}>$0.25 contract audit</a> went to{' '}
          <span className="mono">{PAY_TO}</span>, the current payee. Every paying and receiving wallet was
          this project&apos;s own. That proves the <em>rail works end to end</em> — discovery, EIP-3009
          authorization, relayed settlement, the agent answering, the buyer getting a result. It is{' '}
          <strong>plumbing, not demand</strong>. No external party has paid ASSAY for anything.
        </div>

        <section className="ledger" aria-labelledby="tiers-h">
          <Reveal as="h2" className="h2" id="tiers-h">
            Tiers
          </Reveal>
          <ul className="tariff" aria-label="Every tier, its price, and whether it can be bought today">
            {TIERS.map((t) => (
              <li key={t.name} className={`tariff__card tariff__card--${t.state}`}>
                <div className="tariff__top">
                  <h3 className="tariff__name">{t.name}</h3>
                  <span className={`stamp ${STATUS[t.state].cls}`}>{STATUS[t.state].label}</span>
                </div>
                <p className="tariff__price">{t.price}</p>
                <p className="tariff__what">{t.what}</p>
              </li>
            ))}
          </ul>
        </section>

        <UseIt missingFeeds={d.stats?.missingFeeds} assetsScanned={d.assetsScanned} />

        <section className="ledger" aria-labelledby="why-h">
          <Reveal as="h2" className="h2" id="why-h">
            Why these two prices are different
          </Reveal>
          <p className="sub">
            The OpenServ x402 marketplace listed {MARKET.listed} services on {MARKET.asOf}, {MARKET.active}{' '}
            of them active, at a median active price of ${MARKET.medianActiveUsd}; about{' '}
            {Math.round((1 - MARKET.active / MARKET.listed) * 100)}% of everything listed was inactive. A
            per-position check has to be cheap enough to run before <em>every</em> valuation, which is the
            only pattern that makes an audit primitive load-bearing rather than occasional; that is the
            $0.01 line and it stays there.
          </p>
          <p className="sub">
            <span className="mono">assay_check_contract</span> is a different kind of question. It is
            asked once, about a counterparty, before deciding whether to rely on its accounting — and it
            returns a named verdict with bytecode evidence rather than a number. It is priced as a
            decision, not a lookup. The {d.findings.length} findings on the wall are the reason to call
            either one.
          </p>
        </section>

        <footer>
          The findings count is read from the current sweep and each payment link is a transaction you can
          open on Basescan. The marketplace figures above are a snapshot of{' '}
          <span className="mono">api.openserv.ai/x402-services</span> from {MARKET.asOf} and are not
          re-fetched. Tiers marked roadmap are not purchasable and no checkout exists for them.
        </footer>
      </main>
    </>
  )
}
