import { PAID_ENDPOINTS, PAY_TO, curlFor } from '@/lib/endpoints'
import { CHAINLINK_FEEDS_URL, loadPricedSymbols } from '@/lib/feeds'
import { FEED_URL, MCP_URL, REPO } from '@/lib/site'
import { GUARD_ADDRESS } from '@/lib/guard'

/**
 * How to buy, call or integrate ASSAY, on the wall and on /pricing.
 *
 * Neither page used to carry an endpoint URL, a request body or a buy link: the only purchase path
 * that worked was the author's own script, and the paywall pages OpenServ hosts for both services
 * were linked from nowhere. What the free surfaces return is stated next to what each price adds,
 * so a buyer knows before paying which question costs money.
 */
export async function UseIt({ missingFeeds, assetsScanned }: { missingFeeds?: number; assetsScanned?: number }) {
  const priced = await loadPricedSymbols()
  const tp = PAID_ENDPOINTS.truePosition
  const cc = PAID_ENDPOINTS.checkContract

  return (
    <section aria-labelledby="use-it">
      <h2 className="h2" id="use-it">
        Use it
      </h2>
      <p className="sub">
        Free first: this wall, the wallet check, the on-chain guard and the public MCP. Pay for the full
        answer. Both paid calls are x402, settled in USDC on Base to{' '}
        <span className="mono">{PAY_TO}</span>. In a browser, the paywall page is OpenServ&apos;s: it asks
        you to connect a Base wallet holding USDC, and the input fields appear only after you connect. An
        agent pays the trigger URL directly.
      </p>

      <div className="offers">
        <div className="offer">
          <div className="tag">${tp.priceUsd.toFixed(2)} · {tp.capability}(symbol, holder)</div>
          <p>
            <strong>Free on MCP:</strong> whether this position can be valued safely, and if not, why:
            the confidence, the refusal reason, which oracle checks completed, and any scheduled
            multiplier change.
          </p>
          <p>
            <strong>${tp.priceUsd.toFixed(2)} adds the position:</strong> raw balance, uiMultiplier(),
            share-equivalents, the token&apos;s decimals, and the feed, price, age and heartbeat behind those
            checks, with the USD value, all read at one block.
          </p>
          <div className="actions">
            <a className="btn primary" href={tp.paywall}>
              Pay ${tp.priceUsd.toFixed(2)} in the browser
            </a>
          </div>
          <div className="meta">x402 trigger · {tp.trigger}</div>
        </div>
        <div className="offer">
          <div className="tag">${cc.priceUsd.toFixed(2)} · {cc.capability}(address)</div>
          <p>
            <strong>Free on MCP:</strong> the verdict alone (NOT_AWARE, AWARE, NOT_APPLICABLE with its
            role, PROXY_UNRESOLVED, TOO_SMALL, or no code), with the code hash, the block and whether the
            reading is conclusive.
          </p>
          <p>
            <strong>${cc.priceUsd.toFixed(2)} adds the audit:</strong> every holding of every Stock
            Token whose on-chain multiplier is not 1, the share-equivalents unaccounted for, the USD held
            (null when any holding is unpriced or unread, never a silent zero), and the eth_call
            citations behind each number.
          </p>
          <div className="actions">
            <a className="btn primary" href={cc.paywall}>
              Pay ${cc.priceUsd.toFixed(2)} in the browser
            </a>
          </div>
          <div className="meta">x402 trigger · {cc.trigger}</div>
        </div>
      </div>

      <h3 className="h3">From code</h3>
      <pre>{curlFor(tp)}</pre>
      <p className="sub">
        The audit takes the same shape with <span className="mono">{`"payload":{"address":"0x…"}`}</span>.
        Any x402 client can pay; with <span className="mono">wrapFetchWithPayment</span>, pass a ceiling
        of at least the price, because its default of $0.10 refuses the $0.25 call before sending it. The
        reply is <span className="mono">{'{status, settleTxHash, output: {value}}'}</span>, and{' '}
        <span className="mono">output.value</span> is itself a JSON string. OpenServ allows 60 seconds
        per call. The input schemas are in the <a href="/agent-card.json">agent card</a>.
      </p>
      <p className="sub">
        <strong>Before you pay.</strong> Payment settles before the task runs. A bad input comes back as{' '}
        <span className="mono">ok: false</span> JSON with an <span className="mono">errorClass</span> and
        a <span className="mono">retryable</span> flag, and whether OpenServ still settles a task that
        errors is not verified, so check a symbol or address with the free MCP first.
      </p>

      <h3 className="h3">Which tokens get a USD answer at $0.01</h3>
      {priced.ok ? (
        <p className="sub">
          These {priced.symbols.length} tickers have a Chainlink feed on chain 4663, so the $0.01 call can
          value them: <span className="mono">{priced.symbols.join(' ')}</span>. Every other Stock Token
          {typeof missingFeeds === 'number' && typeof assetsScanned === 'number' && assetsScanned > 0
            ? ` (${missingFeeds} of ${assetsScanned} in this sweep${priced.symbols.includes('CRWD') ? '' : ', CRWD among them'})`
            : ''}{' '}
          returns the corrected share-equivalents with the USD value refused, because there is no on-chain
          price to use. A priced token whose feed is past its heartbeat, as the 24/5 feeds are for part
          of every weekend, comes back <span className="mono">degraded</span> with the feed&apos;s age
          stated. Listed from the{' '}
          <a href={CHAINLINK_FEEDS_URL}>Chainlink directory</a> the paid call reads, re-read hourly.
        </p>
      ) : (
        <p className="sub">
          The <a href={CHAINLINK_FEEDS_URL}>Chainlink feed directory</a> could not be read just now, so the
          priced tickers are not listed. A token with a feed there gets a USD value at $0.01; any other
          gets the corrected share-equivalents with the USD value refused.
        </p>
      )}

      <h3 className="h3">Free, no key</h3>
      <ul className="sub list">
        <li>
          <strong>MCP over SSE:</strong> <span className="mono">{MCP_URL}</span>, for example{' '}
          <span className="mono">claude mcp add --transport sse assay {MCP_URL}</span>. Tools:{' '}
          <span className="mono">assay_findings</span>, <span className="mono">assay_check_symbol</span>,
          and the verdict-only <span className="mono">assay_check_contract</span> and{' '}
          <span className="mono">assay_true_position</span>.
        </li>
        <li>
          <strong>Raw feed:</strong> <span className="mono">{FEED_URL}</span>, the JSON this wall reads.
        </li>
        <li>
          <strong>ERC8056Guard on chain 4663:</strong>{' '}
          <a className="mono" href={`https://sourcify.dev/#/lookup/${GUARD_ADDRESS}`}>
            {GUARD_ADDRESS}
          </a>
          , ownerless and view-only. <span className="mono">shareEquivalents(token, holder)</span> returns
          the share count or a refusal with its reason; <span className="mono">positionValue</span> adds
          the feed price. The TypeScript helper is on npm as{' '}
          <a href="https://www.npmjs.com/package/erc8056-guard">
            <span className="mono">erc8056-guard</span>
          </a>{' '}
          (<a href={`${REPO}/tree/main/packages/erc8056-guard`}>source</a>).
        </li>
      </ul>
    </section>
  )
}
