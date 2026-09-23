import Link from 'next/link'
import type { Integrators } from '@/lib/findings'
import { fmtUsd, integratorView, listJoin } from '@/lib/present'

/**
 * The other side of the trade: who holds divergent-multiplier Stock Tokens, as an aggregate.
 *
 * It used to read "25 of 66 contracts cannot call uiMultiplier()", which was wrong three ways. The
 * counts were (address, token) pairs, so 66 was far fewer contracts. "25 of 66 cannot" implied 41
 * can, when none of them referenced it. And AMM pools and custody wallets sat inside the 25,
 * although they hold reserves, never report a share count and never need the multiplier. Pools
 * now have their own line, and the headline says what the data says: none reference it.
 */
export function IntegratorPanel({ agg, namedWithheld }: { agg: Integrators; namedWithheld?: number }) {
  const v = integratorView(agg)
  const closing = (
    <>
      What this establishes is the <strong>absence of a call</strong>, not the presence of a mistake.
      Proxies are resolved to their implementation (EIP-1967, beacon, EIP-1167) before any verdict.{' '}
      <strong>No contract is named on this page</strong>
      {typeof namedWithheld === 'number' && namedWithheld > 0
        ? `; ${namedWithheld} findings that would name one are withheld from it`
        : ''}
      . The named audit of any address, with its bytecode evidence, is the paid{' '}
      <span className="mono">assay_check_contract</span> call (<Link href="/pricing">pricing</Link>).
    </>
  )

  if (v.shape === 'pairs') {
    return (
      <div className="banner" style={{ borderColor: 'var(--high)' }}>
        <strong>
          {/* "No contract" overclaimed on a board with unresolved proxies, which are exactly the ones no
              claim is made about; the distinct-shape headline already counts only resolved contracts. */}
          {v.aware === 0
            ? `No ${v.proxyUnresolved > 0 ? 'resolved ' : ''}contract seen moving divergent-multiplier Stock Tokens references uiMultiplier()`
            : `${v.aware} contract holdings seen moving divergent-multiplier Stock Tokens reference uiMultiplier()`}
          {v.proxyUnresolved === 1
            ? ' (1 proxy could not be resolved; no claim is made about it)'
            : v.proxyUnresolved > 1
              ? ` (${v.proxyUnresolved} proxies could not be resolved; no claim is made about them)`
              : ''}
        </strong>
        <div style={{ marginTop: 8 }}>
          This board predates distinct counting, so its figures are (contract, token) holdings, not
          contracts: {v.notAwareHoldings} of {v.holdings} contract holdings carry at least{' '}
          <strong>{fmtUsd(v.usdNotAware)}</strong> with no <span className="mono">uiMultiplier()</span>{' '}
          selector in their bytecode. AMM pools and custody wallets, which never need the multiplier, are
          still inside that figure. The next sweep counts distinct contracts and gives them their own line.
        </div>
        <div className="meta" style={{ marginTop: 10, lineHeight: 1.8 }}>
          {closing}
        </div>
      </div>
    )
  }

  const floor = (unpriced: number) => (unpriced > 0 ? 'at least ' : '')
  return (
    <div className="banner" style={{ borderColor: 'var(--high)' }}>
      <strong>
        {v.aware === 0 ? 'None' : v.aware} of the {v.resolved} contracts seen moving divergent-multiplier
        Stock Tokens {v.aware === 1 ? 'references' : 'reference'} <span className="mono">uiMultiplier()</span>
        .
        {v.notApplicableShare !== null && v.notApplicableShare > 0.5
          ? ` Most of the value they hold sits in pools and custody that never need it.`
          : ''}
      </strong>
      <div style={{ marginTop: 8 }}>
        The table names the asset that was <em>read</em>; this is the other side. Of {v.scanned} addresses
        seen moving these tokens, {v.contracts} are contracts
        {v.proxyUnresolved === 1
          ? ', and 1 of those is a proxy that could not be resolved, so no claim is made about it'
          : v.proxyUnresolved > 1
            ? `, and ${v.proxyUnresolved} of those are proxies that could not be resolved, so no claim is made about them`
            : ''}
        .
      </div>
      <ul className="list" style={{ marginTop: 8 }}>
        <li>
          <strong>
            {v.notAware} {v.notAware === 1 ? 'contract' : 'contracts'} could be exposed.
          </strong>{' '}
          {v.notAware === 1 ? 'It holds' : 'They hold'} {floor(v.unpricedNotAware)}
          <strong>{fmtUsd(v.usdNotAware)}</strong> of these tokens, with no{' '}
          <span className="mono">uiMultiplier()</span> selector in their logic and no pool or custody
          fingerprint: {v.sharesUnaccounted.toFixed(2)} share-equivalents go unaccounted for if those
          balances are read as share counts.
          {v.unpricedNotAware > 0
            ? ` The dollar figure leaves out ${v.unpricedNotAware} holdings in tokens with no Chainlink feed.`
            : ''}
        </li>
        <li>
          <strong>
            {v.notApplicable} {v.notApplicable === 1 ? 'contract never needs' : 'never need'} it.
          </strong>{' '}
          {v.roles.length
            ? listJoin(v.roles.map((r) => `${r.contracts} ${r.label}`))
            : 'Pools, pool managers, custody wallets and distributors'}{' '}
          hold {floor(v.unpricedNotApplicable)}
          <strong>{fmtUsd(v.usdNotApplicable)}</strong>. They keep reserves or custody and never report a
          share count, so lacking the multiplier is not an exposure; each is recognised from the functions
          its bytecode implements.
          {v.notApplicableShare !== null
            ? ` That is ${Math.round(v.notApplicableShare * 100)}% of the priced value these contracts hold.`
            : ''}
        </li>
        <li>
          {v.tooSmall} too small to hold valuation logic; {v.noHolding} held none of these tokens at the
          block
          {v.unreadContracts > 0 ? `; ${v.unreadContracts} whose balances could not be read` : ''}.
        </li>
      </ul>
      <div className="meta" style={{ marginTop: 10, lineHeight: 1.8 }}>
        Coverage: holders of {v.assetsScanned.length} tokens whose multiplier is more than{' '}
        {v.minDivergencePct ?? 0.2}% from 1.
        {v.assetsBelowCutoff.length
          ? ` ${v.assetsBelowCutoff.length} divergent tokens under that cutoff were not scanned (${v.assetsBelowCutoff.join(', ')}).`
          : ''}
        {v.assetsUnread.length ? ` ${v.assetsUnread.join(', ')} could not be re-read and were skipped.` : ''}{' '}
        {closing}
      </div>
    </div>
  )
}
