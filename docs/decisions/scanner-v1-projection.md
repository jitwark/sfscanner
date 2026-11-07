# ADR: Safe scanner-result-v2 projection to v1

> Status: accepted
> Date: 2026-09-06
> Owner: Scanner maintainer; compatibility review is release-gated

## Context

`scanner-result-v1` and its CLI/browser projections are deployed compatibility surfaces with a
frozen diagnostic code/category union, ordering, summary shape, and legacy scanner identity. V2
needs source identities, capability coverage, applicability, evidence classes, traces, explicit
unknowns, and bounded omissions that v1 cannot represent. Copying only the fields that happen to
fit would allow an indeterminate v2 scan to look complete or clean in v1.

The normative field-by-field rules are in the [v1 projection ledger](../../openspec/changes/world-class-scanner-cli/v1-projection-ledger.md).

## Decision

V1 projection is an explicit, versioned adapter, not a second calculator. It selects only registered
safe facts, rule-revision templates, remediation templates, and closed evidence properties; validates
their exact shape; preserves frozen v1 ordering; and never recomputes prose from partial findings.

Native v1 continues to use the grandfathered opaque `scanner-beta-1` identity. A projected v2 result
reports the registered real engine version `2.0.0` in v1's historically named `scannerVersion` field.
The upgraded validator admits exactly those two values; it does not widen the frozen v1 diagnostic
union or category union. Pre-upgrade validators rejecting projected `2.0.0` is documented as a
truthful-identity compatibility break.

`COMPATIBILITY_PROJECTION_LOSS` is internal v2 state and is never serialized as a v1 diagnostic. If
unsafe loss leaves a projected result indeterminate and no existing v1 indeterminate diagnostic is
already present, the adapter appends one location-free
`{code: 'POLICY_EXECUTION_FAILED', category: 'POLICY'}` sentinel. It omits v1 assessment and
reassuring summary fields whenever the projected status is indeterminate.

## Approved false-clean compatibility breaks

These are the complete approved cases. Each requires projected engine version `2.0.0`, this ADR, a
differential golden containing old and new output, migration text, and an explanation of the old
false-clean path.

| V2 condition | Projected v1 behavior | Why compatibility may break |
| --- | --- | --- |
| Security-consumed duplicate key (`DUPLICATE_SECURITY_KEY`) | Existing `DUPLICATE_JSON_KEY`, `INDETERMINATE` | Frozen v1 previously treated the generic duplicate as degraded and could hide security input loss. |
| Required scoring limit (`REQUIRED_LIMIT_EXCEEDED`) | Existing `ANALYSIS_LIMIT_EXCEEDED`, `INDETERMINATE` | A required analysis budget cannot be presented as a degraded but assessable scan. |
| Required code, expression, or graph parse/source loss | Existing v1 diagnostic, `INDETERMINATE` | V1 classified these failures as degraded even when v2 proves scoring evidence was unavailable. |
| Required graph entry cannot be established | Existing `GRAPH_ANALYSIS_DEGRADED`, `INDETERMINATE` | A partial graph without a valid semantic entry cannot prove reachability, dominance, approval, or sanitization. |
| Required graph work exhausts `maxGraphOperations` | Existing `ANALYSIS_LIMIT_EXCEEDED`, `INDETERMINATE` | Partial SCC, reachability, dominance, or worklist state cannot support a complete security conclusion. |
| Projected hardened taint trace detail has no approved safe v1 representation | Omit `traceLength`/`tracePath`; existing `POLICY_EXECUTION_FAILED` sentinel and `INDETERMINATE` | Raw legacy trace labels are not part of the closed safe-fact registry and cannot be copied blindly. |
| Webhook authentication is malformed or non-string | Omit raw evidence; existing `POLICY_EXECUTION_FAILED` sentinel and `INDETERMINATE` | Native v1 could serialize arbitrary source values and infer authentication from an unsupported shape. |
| Malformed connection index | Existing `MALFORMED_CONNECTION_INDEX`, `INDETERMINATE` | The prior v1 classifier was degraded; silently dropping an edge can hide a security path. |
| No v1 equivalent: required catalogue miss, dependency failure, required/unknown scoring rule, or other unsafe required evidence loss | Existing `POLICY_EXECUTION_FAILED` sentinel, `INDETERMINATE` | V1 has no truthful code for the omitted required stage; a complete/degraded result would be false-clean. |

Optional/report-only omissions remain degraded only when their loss is irrelevant to every v1
conclusion. Native v1 classifiers remain unchanged. `EntrySecurity` remains unchanged until its
separate orchestrator-owned migration.

## Rejected alternatives

- **Map every v2 diagnostic to a new v1 category or code.** Rejected because it breaks the frozen v1
  union and all consumers that validate it.
- **Drop the loss and preserve the old status.** Rejected because omitted required security work can
  become an ordinary clean or graded assessment.
- **Recompute summaries and prose from partial findings.** Rejected because it can create claims not
  supported by registered facts.
- **Relabel `2.0.0` as `scanner-beta-1`.** Rejected because compatibility must not falsify engine identity.

## Compatibility boundary

Only explicit v2-to-v1 projection uses this ledger. Standalone and pipeline native-v1 output,
defaults, ordering, and exit behavior remain frozen. V2-only evidence, traces, applicability, target
identity, capability coverage, omitted counts, and limits are excluded unless a registered safe fact
supports a v1 field. No v1 adapter may emit `COMPATIBILITY_PROJECTION_LOSS` itself.

## Rollback

On a failed projection validator, differential golden, or compatibility review, disable the v2
projection path and continue serving native v1 output. Keep the v2 result available only through its
v2 surface; do not downgrade it into a fabricated v1 assessment. Restore the previous registry and
schema identity from the signed release artifact.

## Owner, evidence, and release gate

The scanner maintainer owns the ledger and adapter. Compatibility owners review every approved break.
The Phase 3 gate requires field/crosswalk coverage, old-validator/new-validator goldens, safe/loss
vectors, frozen ordering, no-secret output, and native-v1 parity. Any registry addition requires new
versioned goldens and a review of this ADR.

## Linked OpenSpec requirements

- [V1 projection ledger](../../openspec/changes/world-class-scanner-cli/v1-projection-ledger.md)
- [Scanner result v2](../../openspec/changes/world-class-scanner-cli/specs/scanner-result-v2/spec.md)
- [Diagnostic and exit registry](../../openspec/changes/world-class-scanner-cli/diagnostic-and-exit-registry.md)
- [Release resolution](../../openspec/changes/world-class-scanner-cli/release-resolution.md)
- [World-class compatibility policy](../../openspec/changes/world-class-scanner-cli/proposal.md)
