import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'

export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'info'

export interface Evidence {
  claim: string
  chainId: number
  contract: string
  call: string
  rawReturn: string
  blockNumber: string
  explorerUrl: string
  observedAt: string
}

export interface Finding {
  id: string
  defectClass: string
  severity: Severity
  subject: string
  title: string
  statement: string
  impact: { basisPoints?: number; percent?: number; note: string }
  evidence: Evidence[]
  methodologyVersion: string
  detectedAt: string
  verification: {
    checked: number
    reproduced: number
    mismatched: number
    pruned: number
    verifiedAt: string
  }
}

export interface ChainNote {
  id: string
  severity: Severity
  title: string
  statement: string
  sources: string[]
  observedAt: string
}

export interface SweepData {
  blockNumber: string
  observedAt: string
  assetsScanned: number
  feedsAvailable: number
  marketClosed: boolean
  cohort: { size: number; stale: number; clockHint: boolean }
  findings: Finding[]
  rejected: Array<{ reason: string; detail: string; finding: { id: string; subject: string } }>
  chainNotes: ChainNote[]
  stats: Record<string, number>
  errors: Array<{ symbol: string; error: string }>
}

const EMPTY: SweepData = {
  blockNumber: '0',
  observedAt: new Date(0).toISOString(),
  assetsScanned: 0,
  feedsAvailable: 0,
  marketClosed: false,
  cohort: { size: 0, stale: 0, clockHint: false },
  findings: [],
  rejected: [],
  chainNotes: [],
  stats: {},
  errors: [],
}

/**
 * Load the published sweep.
 *
 * Checks web/data first, then the repo-root data/. The prebuild step copies the root artifact
 * into web/data because Vercel only bundles files inside the project root — reading '../data'
 * works locally and silently yields an empty board once deployed.
 */
export function loadSweep(): SweepData {
  const candidates = [
    path.join(process.cwd(), 'data', 'findings.json'),
    path.join(process.cwd(), '..', 'data', 'findings.json'),
  ]
  for (const p of candidates) {
    if (!existsSync(p)) continue
    try {
      return { ...EMPTY, ...(JSON.parse(readFileSync(p, 'utf8')) as Partial<SweepData>) }
    } catch {
      /* try the next candidate */
    }
  }
  return EMPTY
}

export const SEV_RANK: Record<Severity, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
  info: 4,
}

export function symbolOf(subject: string): string {
  return subject.split(' ')[0] ?? subject
}
