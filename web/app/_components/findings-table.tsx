import Link from 'next/link'
import { symbolOf, type Finding } from '@/lib/findings'

export function FindingsTable({ findings, caption }: { findings: Finding[]; caption: string }) {
  return (
    <div className="tscroll">
      <table className="findings">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr>
            <th scope="col" style={{ width: 84 }}>
              Severity
            </th>
            <th scope="col" style={{ width: 74 }}>
              Asset read
            </th>
            <th scope="col">Finding</th>
            <th scope="col" style={{ width: 210 }}>
              Class
            </th>
            <th scope="col" style={{ width: 96 }}>
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
                <Link href={`/f/${encodeURIComponent(f.id)}`} style={{ textDecoration: 'none' }}>
                  {f.title}
                </Link>
              </td>
              <td className="cls">{f.defectClass}</td>
              <td className="verified">
                {f.verification?.reproduced ?? 0}/{f.verification?.checked ?? 0} ✓
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
