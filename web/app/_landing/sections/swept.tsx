'use client'

import { useEffect, useState } from 'react'

/** "40s ago", "4m ago", "2.3h ago", "3d ago". */
function ago(ms: number): string {
  const s = ms / 1000
  if (s < 90) return `${Math.max(0, Math.round(s))}s ago`
  if (s < 5400) return `${Math.round(s / 60)}m ago`
  if (s < 172800) return `${(s / 3600).toFixed(1)}h ago`
  return `${Math.round(s / 86400)}d ago`
}

/**
 * When the board was swept. The server prints the UTC time, which stays true however old the ISR
 * HTML is; the relative age is only ever computed here, in the browser, after mount, and kept
 * current. Past the board's freshness window it says so, in aqua fortis: a stale board is the
 * acid test failing, and the wall marks it the same way.
 */
export function Swept({ observedAt, staleAfter }: { observedAt: string; staleAfter: string }) {
  const [now, setNow] = useState<number | null>(null)
  useEffect(() => {
    setNow(Date.now())
    const t = window.setInterval(() => setNow(Date.now()), 30_000)
    return () => window.clearInterval(t)
  }, [])

  const t = new Date(observedAt).getTime()
  if (!Number.isFinite(t)) return <>at an unknown time</>
  const utc = `${new Date(t).toISOString().slice(0, 16).replace('T', ' ')} UTC`
  if (now === null) return <time dateTime={observedAt}>{utc}</time>
  const stale = now > new Date(staleAfter).getTime()
  return (
    <>
      <time dateTime={observedAt} title={utc}>
        {ago(now - t)}
      </time>
      {stale ? <span style={{ color: 'var(--aqua)' }}> · stale</span> : null}
    </>
  )
}
