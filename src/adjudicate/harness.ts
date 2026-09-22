import { METHODOLOGY_VERSION as RUBRIC_VERSION } from './methodology.js'
import type { Adjudication } from './serv.js'

/**
 * Shared bookkeeping for the measurement harnesses.
 *
 * WHY THIS EXISTS. The four harnesses each wrote artifacts their own way, and three of them wrote
 * "convenience pointers" over committed files — including data/braid-ab.json, the single run that
 * looked decisive and was later retracted, which is the evidence FOR that retraction. They were
 * also keyed by the adjudicator rubric version alone, and the rubric is not the only input: the
 * finding text changed under an unchanged rubric, so a new run was indistinguishable from the one
 * it would have replaced.
 */

/**
 * Where an artifact goes. Rubric + detection methodology + run id — the three things that decide
 * what a number means. Never a fixed path: a fixed path is how a measurement overwrites its own
 * history.
 */
export function artifactPath(name: string, detectionVersion: string, runId: string): string {
  return `data/${name}-${RUBRIC_VERSION}-${detectionVersion}-${runId}.json`
}

/** Sortable, filesystem-safe. Stamped here so every harness uses the same shape. */
export function newRunId(): string {
  return new Date().toISOString().replace(/[:.]/g, '-')
}

export interface UsageSummary {
  calls: number
  withUsage: number
  promptTokens: number
  completionTokens: number
  /** gpt-5.6-luna list price. A LOWER BOUND — see `basis`. */
  estimatedUsd: number
  medianLatencyMs: number | null
  basis: string
}

/** gpt-5.6-luna: $0.25 per M input, $1.50 per M output. */
const PRICE_IN = 0.25 / 1_000_000
const PRICE_OUT = 1.5 / 1_000_000

export function summariseUsage(adjudications: Adjudication[]): UsageSummary {
  const withUsage = adjudications.filter((a) => a.meta.usage)
  const promptTokens = withUsage.reduce((n, a) => n + (a.meta.usage?.promptTokens ?? 0), 0)
  const completionTokens = withUsage.reduce((n, a) => n + (a.meta.usage?.completionTokens ?? 0), 0)
  const lat = adjudications.map((a) => a.meta.latencyMs).sort((x, y) => x - y)
  return {
    calls: adjudications.length,
    withUsage: withUsage.length,
    promptTokens,
    completionTokens,
    estimatedUsd: Number((promptTokens * PRICE_IN + completionTokens * PRICE_OUT).toFixed(4)),
    medianLatencyMs: lat.length ? lat[Math.floor(lat.length / 2)]! : null,
    basis:
      'Token counts as reported in each SERV response, priced at gpt-5.6-luna list. A lower bound: ' +
      'Kronos compiles the reasoning prompt generator-side and that cost may not appear per ' +
      'response. The console bill for the API key is authoritative.',
  }
}

/** What every artifact records about its inputs, so a reader can tell what a number was measured on. */
export function provenance(detectionVersion: string, inputHashes: string[]) {
  const distinct = [...new Set(inputHashes)]
  return {
    rubricVersion: RUBRIC_VERSION,
    detectionMethodologyVersion: detectionVersion,
    // One hash per distinct user message. Several means several fixtures, not drift.
    inputHashes: distinct,
  }
}
