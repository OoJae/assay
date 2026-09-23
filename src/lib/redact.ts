/**
 * What may reach a public surface.
 *
 * The class below names a third-party CONTRACT rather than an asset. Such findings are withheld from
 * every public surface — the wall, /findings.json, the committed data files, the free MCP tools —
 * and a name is returned only through the paid $0.25 audit. A NOT_AWARE verdict establishes the
 * absence of a call, not the presence of a mistake, and a contract that merely custodies a token
 * should not be findable by name on a public page over a risk it may not carry.
 *
 * Every public path goes through here, including `rejected[]`: stripping `findings` and leaving the
 * same rows in `rejected` published the names anyway.
 */
export const NAMED_INTEGRATOR_CLASS = 'INTEGRATOR_NOT_MULTIPLIER_AWARE'

export function isNamedIntegrator(f: { defectClass?: string } | null | undefined): boolean {
  return f?.defectClass === NAMED_INTEGRATOR_CLASS
}

/** Strip named-integrator findings. Applied wherever a payload can reach the public. */
export function withoutNamedIntegrators<T extends { defectClass: string }>(findings: T[]): T[] {
  return findings.filter((f) => !isNamedIntegrator(f))
}

/** A snapshot safe to publish: named integrators removed from both `findings` and `rejected`. */
export function redactSnapshot<
  S extends { findings: Array<{ defectClass: string }>; rejected?: Array<{ finding: { defectClass: string } }> },
>(snap: S): S {
  return {
    ...snap,
    findings: withoutNamedIntegrators(snap.findings),
    ...(snap.rejected ? { rejected: snap.rejected.filter((r) => !isNamedIntegrator(r.finding)) } : {}),
  }
}
