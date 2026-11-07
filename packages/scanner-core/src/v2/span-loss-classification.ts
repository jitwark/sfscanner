import type { ProfileManifestV2 } from '../capabilities/profile-manifest';
import { SAFE_FACT_EVIDENCE_MAPPINGS_V2 } from '../facts/safe-fact-registry';

/**
 * Whether an omitted stored span is presentation-only or security-required.
 *
 * Identity never depends on a span. `astNodeId` is a structural digest of occurrence path, slot,
 * kind, and a payload that recurses through child ids or the token lexeme; node and edge digests
 * read those ids (`createNodeIdentityDigest`, `createEdgeIdentityDigest`), and fact, finding and
 * trace ids canonicalise the resulting subject. The evidence registry's span policies are `NONE` or
 * `OPTIONAL_HALF_OPEN`, so no fact kind demands a span either — a fact with a location-less subject
 * is still classified exactly the same way.
 *
 * Trace evidence is the exception, because a trace step states *where* the classification was
 * observed: a step's subject is resolved through the taint subject validator, which refuses a source
 * member without a stored span, and `materializeTraceV2` answers an unresolvable step with an UNKNOWN
 * trace rather than a partial one. A span budget that drops those spans therefore does not leave a
 * location-less record behind; it removes the classification the trace was carrying, which is the
 * result contract's "identity/security classification depends on an omitted span" case.
 */
const TRACE_EVIDENCE_SCHEMA_IDS: readonly string[] = Object.freeze(['v1.taint', 'v1.agent-control']);

export function spanLossIsSecurityRequired(manifest: ProfileManifestV2): boolean {
  return manifest.capabilities.some((capability) => capability.ruleIds.some((ruleId) => {
    const mapping = SAFE_FACT_EVIDENCE_MAPPINGS_V2.find((entry) => entry.ruleId === ruleId);
    return mapping !== undefined && TRACE_EVIDENCE_SCHEMA_IDS.includes(mapping.evidenceSchemaId);
  }));
}
