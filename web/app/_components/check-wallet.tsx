'use client'

import { useState, type FormEvent } from 'react'
import { BURN_ADDRESS, GUARD_ADDRESS, RH_RPC_URL } from '@/lib/guard'
import type { CheckView } from '@/lib/wallet-check'

type State =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'done'; view: CheckView }
  | { kind: 'error'; message: string }

/**
 * The checker and viem load on the first press of Check, not with the page: loaded eagerly they
 * nearly doubled the wall's first-load JavaScript for a box most visitors never use.
 */
export function CheckWallet({ tokens }: { tokens: Array<{ symbol: string; token: `0x${string}` }> }) {
  const [input, setInput] = useState('')
  const [state, setState] = useState<State>({ kind: 'idle' })

  async function run(address: string) {
    setState({ kind: 'loading' })
    let m: typeof import('@/lib/wallet-check')
    try {
      m = await import('@/lib/wallet-check')
    } catch {
      setState({ kind: 'error', message: 'The checker could not be loaded. Reload the page and try again.' })
      return
    }
    try {
      setState({ kind: 'done', view: m.toView(await m.checkWallet(address, tokens, m.viemGuardReader())) })
    } catch (err) {
      setState({
        kind: 'error',
        message:
          err instanceof m.WalletCheckError ? err.message : 'The check failed unexpectedly. Nothing was concluded.',
      })
    }
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault()
    void run(input)
  }

  if (tokens.length === 0) {
    return (
      <div className="card">
        The wallet check reads the tokens this sweep found with a multiplier other than 1, and this board
        lists none. It will return with the next sweep.
      </div>
    )
  }

  const castHolder = state.kind === 'done' ? state.view.holder : '<holder>'
  const castToken = state.kind === 'done' && state.view.rows[0] ? state.view.rows[0].token : tokens[0]!.token

  return (
    <div className="card">
      <form className="check" onSubmit={onSubmit}>
        <label htmlFor="holder" className="tag">
          Holder address on chain 4663
        </label>
        <div className="check-row">
          <input
            id="holder"
            name="holder"
            className="mono"
            placeholder="0x…"
            autoComplete="off"
            spellCheck={false}
            value={input}
            onChange={(e) => setInput(e.target.value)}
          />
          <button type="submit" className="btn primary" disabled={state.kind === 'loading'}>
            {state.kind === 'loading' ? 'Reading…' : 'Check'}
          </button>
        </div>
        <div className="note">
          No address handy?{' '}
          <button
            type="button"
            className="linkish"
            disabled={state.kind === 'loading'}
            onClick={() => {
              setInput(BURN_ADDRESS)
              void run(BURN_ADDRESS)
            }}
          >
            Try the burn address 0x…dEaD
          </button>
          . Reads {tokens.length} divergent-multiplier Stock Tokens straight from{' '}
          <span className="mono">rpc.mainnet.chain.robinhood.com</span> in your browser. Free; nothing is
          signed or sent to ASSAY.
        </div>
      </form>

      <div aria-live="polite">
        {state.kind === 'error' ? (
          <div className="banner banner--aqua check-error">
            {state.message}
          </div>
        ) : null}
        {state.kind === 'done' ? <Result v={state.view} /> : null}
      </div>

      <details className="terminal">
        <summary>The same call from a terminal</summary>
        <pre>{`cast call ${GUARD_ADDRESS} \\
  "shareEquivalents(address,address)(uint256,bool,string)" \\
  ${castToken} ${castHolder} \\
  --rpc-url ${RH_RPC_URL}`}</pre>
        <div className="note">
          Returns (share-equivalents in the token&apos;s base units, safe, reason). The guard refuses with
          a reason instead of returning a number it cannot stand behind, and it reverts if the token
          address has no code, so pass a Stock Token address.
        </div>
      </details>
    </div>
  )
}

function Result({ v }: { v: CheckView }) {
  return (
    <div className="check-result">
      <div className="meta">
        {v.holder} · block {v.blockNumber} · {v.checked} tokens read, {v.rows.length} held, {v.zero} zero
        {v.unread.length ? `, ${v.unread.length} unread` : ''}
      </div>
      {v.rows.length === 0 ? (
        <p className="sub">
          This address holds none of the {v.checked - v.unread.length} divergent-multiplier tokens that
          could be read at this block, so balanceOf() and the share count agree for it.
        </p>
      ) : (
        <div className="tscroll">
          <table className="table--mid">
            <caption className="sr-only">Raw balance and share-equivalents per token</caption>
            <thead>
              <tr>
                <th scope="col">Token</th>
                <th scope="col">balanceOf() · tokens</th>
                <th scope="col">Share-equivalents</th>
                <th scope="col">Guard</th>
              </tr>
            </thead>
            <tbody>
              {v.rows.map((r) => (
                <tr key={r.token}>
                  <td className="sym">{r.symbol}</td>
                  <td className="mono">{r.balance}</td>
                  <td className="mono">{r.shares ?? '—'}</td>
                  {/* null is a read that failed, not a refusal: "could not check" and "refused" are
                      the distinction the withheld section says most tools blur. A refusal is the
                      acid test failing, so it is aqua; "safe" is a live read, not a re-fetched
                      citation, so it is never gold. */}
                  <td className={r.safe === true ? 'guard-safe' : r.safe === null ? 'meta' : 'guard-refused'}>
                    {r.safe === true ? 'safe ✓' : r.safe === null ? `unread: ${r.reason}` : `refused: ${r.reason}`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {v.unread.length ? (
        <p className="sub">Could not read {v.unread.join(', ')} at this block. Those are unknown, not zero.</p>
      ) : null}
      {v.rows.length ? (
        <p className="sub">
          A wallet, portfolio page or agent that shows the balanceOf() column as a share count is off by
          the multiplier. The paid <span className="mono">assay_true_position</span> adds the USD value from
          the token&apos;s Chainlink feed, with the price, age and heartbeat behind its oracle checks.
        </p>
      ) : null}
    </div>
  )
}
