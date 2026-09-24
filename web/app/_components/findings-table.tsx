import Link from 'next/link'
import { symbolOf, type Finding } from '@/lib/findings'

export function FindingsTable({ findings, caption }: { findings: Finding[]; caption: string }) {
  return (
    <div className="tscroll">
      <table className="findings">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr>
            <th scope="col" className="col-sev">
              Severity
            </th>
            <th scope="col" className="col-sym">
              Asset read
            </th>
            <th scope="col">Finding</th>
            <th scope="col" className="col-cls">
              Class
            </th>
            <th scope="col" className="col-ev">
              Evidence
            </th>
          </tr>
        </thead>
        <tbody>
          {findings.map((f) => (
            <tr key={f.id}>
              <td>
                <span className={`sev ${f.severity}`}>{f.severity}</span>
              </td>
              <td className="sym">{symbolOf(f.subject)}</td>
              <td>
                <Link className="row-link" href={`/f/${encodeURIComponent(f.id)}`}>
                  {f.title}
                </Link>
              </td>
              <td className="cls">{f.defectClass}</td>
              {/* Gold means every citation re-fetched and matched: N of N. A partial count is still
                  printed, in cupel, so gold never covers a citation that was not reproduced. */}
              <td
                className={
                  (f.verification?.checked ?? 0) > 0 && f.verification?.reproduced === f.verification?.checked
                    ? 'verified'
                    : 'verified verified--partial'
                }
              >
                {f.verification?.reproduced ?? 0}/{f.verification?.checked ?? 0} ✓
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
