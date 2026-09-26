import { PAID_ENDPOINTS } from '@/lib/endpoints'
import { MCP_HTTP_URL, MCP_URL, REPO } from '@/lib/site'
import { PaywallLink } from '../../_components/paywall-link'
import { Reveal } from '../../_motion/reveal'
import { TransitionLink } from '../../_motion/transition-link'
import s from './sections.module.css'

const GUARD_NPM = 'https://www.npmjs.com/package/erc8056-guard'

/**
 * Use it: the five ways in, as a tariff, in the order a buyer meets them: check a wallet, ask
 * for the verdict, pay for the position, pay for the named audit, then build the check into your
 * own code. Prices, capability names and links come from lib/endpoints and lib/site, which
 * test/wall-data.test.ts holds to the agent's own source, so this list cannot quote a price the
 * endpoint does not charge. What each one returns is the wall's own description of it
 * (components/use-it), shortened, never widened.
 */
export function UseIt() {
  const tp = PAID_ENDPOINTS.truePosition
  const cc = PAID_ENDPOINTS.checkContract
  const usd = (n: number) => `$${n.toFixed(2)}`

  return (
    <section className={s.section} aria-labelledby="use-h">
      <div className={s.wrap}>
        <div className={s.rule}>
          <span className="label">Use it</span>
          <span className="label">Three free · two paid, x402 in USDC on Base</span>
        </div>
        <Reveal as="h2" id="use-h" className={`display t-section ${s.head}`}>
          check it free. pay for the full answer.
        </Reveal>

        <ul className={s.tariff}>
          <li className={s.item}>
            <p className={s.price}>Free</p>
            <div className={s.what}>
              <h3 className={s.itemHead}>Check a wallet</h3>
              <p className={s.body}>
                Paste any address. Your browser reads <span className={s.call}>balanceOf()</span> beside the share
                count for every Stock Token whose multiplier is not 1, straight from the chain. Nothing is signed or
                sent to ASSAY.
              </p>
            </div>
            <div className={s.act}>
              <TransitionLink className="btn primary btn--sm" href="/wall#check">
                Check a wallet
              </TransitionLink>
            </div>
          </li>

          <li className={s.item}>
            <p className={s.price}>Free</p>
            <div className={s.what}>
              <h3 className={s.itemHead}>The MCP verdict</h3>
              <p className={s.body}>
                Ask whether a position can be valued safely, or whether a contract reads the multiplier. You get the
                verdict and the reason, over MCP, with no key.
              </p>
              {/* The fallback is a shell comment, so pasting the whole box runs the HTTP line only. */}
              <pre className={s.cmd} data-lenis-prevent="">
                <code>
                  {`claude mcp add --transport http assay ${MCP_HTTP_URL}\n# SSE-only clients: claude mcp add --transport sse assay ${MCP_URL}`}
                </code>
              </pre>
            </div>
            <div className={s.act} />
          </li>

          <li className={s.item}>
            <p className={s.price}>{usd(tp.priceUsd)}</p>
            <div className={s.what}>
              <h3 className={s.itemHead}>
                <span className={s.call}>{tp.capability}</span>(symbol, holder)
              </h3>
              <p className={s.body}>
                One position at one block: the raw balance, <span className={s.call}>uiMultiplier()</span>, the share
                count and the token&apos;s decimals, with the feed price, its age and the USD value.
              </p>
            </div>
            <div className={s.act}>
              <PaywallLink className="btn btn--sm" href={tp.paywall}>
                Pay {usd(tp.priceUsd)}
              </PaywallLink>
            </div>
          </li>

          <li className={s.item}>
            <p className={s.price}>{usd(cc.priceUsd)}</p>
            <div className={s.what}>
              <h3 className={s.itemHead}>
                <span className={s.call}>{cc.capability}</span>(address)
              </h3>
              <p className={s.body}>
                One contract, named: every holding it has of a Stock Token whose multiplier is not 1, the
                share-equivalents it leaves out, the USD held, and the <span className={s.call}>eth_call</span>{' '}
                citations behind each number.
              </p>
            </div>
            <div className={s.act}>
              <PaywallLink className="btn btn--sm" href={cc.paywall}>
                Pay {usd(cc.priceUsd)}
              </PaywallLink>
            </div>
          </li>

          <li className={s.item}>
            <p className={s.price}>Free</p>
            <div className={s.what}>
              <h3 className={s.itemHead}>
                <span className={s.call}>erc8056-guard</span> on npm
              </h3>
              <p className={s.body}>
                The TypeScript helper for ERC8056Guard, an ownerless, view-only contract on Robinhood Chain that
                returns a holder&apos;s share count, or a refusal with its reason.
              </p>
              <pre className={s.cmd} data-lenis-prevent="">
                <code>npm i erc8056-guard viem</code>
              </pre>
            </div>
            <div className={s.act}>
              <a className="btn btn--sm" href={GUARD_NPM}>
                View on npm
              </a>
            </div>
          </li>
        </ul>

        <p className={s.fine}>
          Payment settles before the task runs, so check a symbol or an address with the free MCP first. Request
          bodies and the 402 flow are on the <TransitionLink href="/pricing">pricing page</TransitionLink>; the
          source is on <a href={REPO}>GitHub</a>.
        </p>
      </div>
    </section>
  )
}
