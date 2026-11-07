# Scanner v1 to v2 migration

> Status: compatibility boundary and migration plan; no public identity or release promotion
> Last verified: 2026-10-17
> Owner: Scanner maintainer; public and compatibility changes remain owner-gated
> Source of truth: [`packages/scanner-core/src/compat/v1-projector.ts`](../../packages/scanner-core/src/compat/v1-projector.ts), [`packages/scanner-core/src/compat/v1-registry.ts`](../../packages/scanner-core/src/compat/v1-registry.ts), [`openspec/changes/world-class-scanner-cli/v1-projection-ledger.md`](../../openspec/changes/world-class-scanner-cli/v1-projection-ledger.md), and [`openspec/changes/world-class-scanner-cli/specs/scanner-community-hub-migration/spec.md`](../../openspec/changes/world-class-scanner-cli/specs/scanner-community-hub-migration/spec.md)

This document makes the v1/v2 boundary explicit. It does not rewrite [native v1 architecture](architecture.md),
[v1 policy inventory](policy-inventory.md), or historical v1 evidence. V2 is an explicit, versioned
scanner path; it is not a silent replacement for the native v1 result or for Community Hub's public
entry identity.

## Two identities, both intentional

| Surface | Engine identity | Result schema | Limits schema | Profile boundary |
| --- | --- | --- | --- | --- |
| Native v1 | `scanner-beta-1` | `scanner-result-v1` | `scanner-limits-v1` | Existing `beta-default` and `beta-hardened` behavior remains available. |
| Explicit v2 | `secureflow-scanner@2.0.0` | `scanner-result-v2` | `scanner-limits-v2` | Only `beta-default@2.0.0` is admitted. |
| Explicit v2-to-v1 projection | `engine.version` is `2.0.0` in v1's `scannerVersion` field | `scanner-result-v1` | V1 fields only | Projected profile registry initially contains `beta-default@2.0.0`. |

Native v1 identity is authoritative for native v1 output. The v1 source identity is
[`scanner-version.ts`](../../packages/scanner-core/src/scanner-version.ts), the v1 result schema is
[`scanner-result.ts`](../../contracts/scanner-result.ts), and the shared v1 limits are
[`scanner-limits.ts`](../../contracts/scanner-limits.ts). V2's admitted identities are assembled in
[`admitted-registry.ts`](../../packages/scanner-core/src/v2/admitted-registry.ts) and entered through
[`scanWorkflowV2`](../../packages/scanner-core/src/v2/scan-workflow.ts).

The defined `beta-hardened@2.0.0` manifest is not admitted or selectable on the v2 path. This does
not remove or downgrade native v1 hardened behavior. A source file, profile name, or rule catalogue
entry does not itself authorize v2 admission.

## Selecting a surface

Selection must be visible in the host invocation:

| Host | Native v1 path | Explicit v2 path |
| --- | --- | --- |
| CLI | A command without the v2 schema marker is dispatched to the existing v1 runner. | `n8n-scan --schema v2 ...` is parsed by [`arguments.ts`](../../packages/scanner-cli/src/v2/arguments.ts) and run by [`cli-runner.ts`](../../packages/scanner-cli/src/v2/cli-runner.ts). |
| Browser Worker | A `scan` message keeps the existing v1 worker path. | A `scan-v2` message accepts the explicitly supported `beta-default` profile and calls the v2 core from [`scan.worker.ts`](../../app/src/scanner/scan.worker.ts). |
| Pipeline wrapper | The native v1 command remains available through [`package-wrapper.ts`](../../pipeline/cli/package-wrapper.ts). | V2 commands dispatch to the package v2 runner through the same wrapper. |
| Calibration | The v1 calibration documents and runner retain their v1 contract. | The v2 calibration harness is separately documented in [`calibration-v2.md`](calibration-v2.md). |

The explicit v2 CLI, browser, and pipeline paths consume direct scanner-core behavior. The browser
UI currently selects v2 by default — `runScanV2` in
[`run-scan.ts`](../../app/src/scanner/run-scan.ts), used by `scanner-client.tsx` — while the
worker's native `scan` message remains available as the v1 path. Existing
v1 adapters and duplicate host logic remain migration evidence until parity, lifecycle, and rollback
gates pass. No host may infer v2 selection from a result's shape or silently relabel native v1
output.

## Safe v2-to-v1 projection

[`projectResultV2ToV1`](../../packages/scanner-core/src/compat/v1-projector.ts) is an explicit
adapter, not a second calculator. [`v1-registry.ts`](../../packages/scanner-core/src/compat/v1-registry.ts)
contains the supported engine/profile registry, rule revisions, templates, diagnostic crosswalk, and
safe evidence projections. The adapter validates a v2 result, selects only registered facts and
closed template fields, preserves frozen v1 order, and rejects unsafe input or unknown authority.

The projected v1 identity rule is deliberately truthful:

- native v1 continues to use `scanner-beta-1`;
- a projected v2 result uses the real `2.0.0` engine version in v1's historically named
  `scannerVersion` field; and
- pre-upgrade consumers that accept only `scanner-beta-1` may reject this projected value. That is a
  documented identity compatibility break, not permission to falsify the engine version.

### Compatibility fields

The field-by-field normative source is the
[v1 projection ledger](../../openspec/changes/world-class-scanner-cli/v1-projection-ledger.md). The
projection keeps these boundaries:

| V1 field or group | V2 source and projection rule |
| --- | --- |
| `schemaVersion` | Constant `scanner-result-v1`. |
| `scannerVersion` | Registered `engine.version`; native and projected identities are not relabelled. |
| `policyProfile` | Registered `profile.id`; the initial projected v2 profile is `beta-default`. |
| `analysisStatus` | V2 status unless any unsafe projection loss forces `INDETERMINATE`. |
| `analysisDiagnostics[]` | Registered v2-to-v1 diagnostic crosswalk, with frozen v1 ordering. |
| `workflow.*` | Safe overview fields such as name, node/edge counts, payload size, complexity, and subworkflow state. V1 `connectionCount` comes from its dedicated compatibility fact, not the v2 edge counter. |
| `functionSummary.*` | Exactly one registered `workflow.function.v1` fact; prose is not recomputed from findings. |
| `integrations[]` | Registered `integration.v1` facts, with frozen service ordering and safe list fields. |
| Finding identity/effect/severity/confidence | Registered rule and safe evidence mapping; unknown rules and arbitrary candidate metadata do not project. |
| Finding location/evidence | Unambiguous node/source references, safe RFC 6901 paths and spans, and registered v1 evidence properties only. Raw source, secrets, traces, applicability prose, and unknown properties are excluded. |
| `riskAssessment`, `summary`, `humanSummary` | Emitted only for complete/degraded safe projection with required risk facts and assessment; omitted for `INDETERMINATE`. |

`COMPATIBILITY_PROJECTION_LOSS` is internal v2 state. It is never serialized as a new v1 code.
When required loss would otherwise leave no truthful v1 diagnostic, the adapter uses the existing
location-free `POLICY_EXECUTION_FAILED` sentinel and an indeterminate result.

## Reconciled differences and approved breaks

The accepted [safe v1 projection ADR](../decisions/scanner-v1-projection.md) governs intentional
false-clean compatibility breaks. The differences are not accidental drift:

| V2 evidence or boundary | Native/old v1 behavior | Safe projected behavior |
| --- | --- | --- |
| Security-consumed duplicate key | Generic `DUPLICATE_JSON_KEY` could remain degraded. | Project to `DUPLICATE_JSON_KEY` with `INDETERMINATE`; required security input cannot look assessable. |
| Required scoring limit | `ANALYSIS_LIMIT_EXCEEDED` could be degraded. | Project to `ANALYSIS_LIMIT_EXCEEDED` with `INDETERMINATE`. |
| Required code, expression, or graph loss | V1 could expose a degraded result. | Keep the registered v1 diagnostic but make the projection indeterminate. |
| Required graph entry or graph work loss | A partial graph could appear assessable. | Project to the existing graph/limit diagnostic with `INDETERMINATE`. |
| Malformed connection index | Prior v1 classification could be degraded. | Preserve `MALFORMED_CONNECTION_INDEX` as indeterminate. |
| Required catalogue/dependency/unknown-rule loss | V1 has no detailed equivalent. | Use the existing `POLICY_EXECUTION_FAILED` sentinel and `INDETERMINATE`. |
| Hardened trace detail | V1 trace fields are not a safe closed representation. | Omit trace detail; if the omission is required, use the sentinel and indeterminate status. |
| Malformed webhook authentication | Native v1 could inspect an unsupported shape. | Omit raw evidence and use safe loss/indeterminate handling. |
| V2 engine identity | Relabelling v2 as `scanner-beta-1` would be false. | Emit registered `2.0.0`; pre-upgrade v1 validators may reject it. |

Native v1 classifiers, defaults, ordering, and output shape are not changed by these projected
breaks. V2-only evidence such as applicability, target identity, capability coverage, traces,
omitted counts, and v2-only limits is omitted unless a registered safe fact supports a v1 field.

## Rollback and convergence

If a v2 schema, authority, parity, projector, or host gate fails:

1. keep native v1 adapters and goldens authoritative;
2. disable v2 selection at the host boundary;
3. retain the failed v2 artifact as evidence; and
4. do not silently downgrade an emitted v2 result into a fabricated v1 assessment.

A v2-to-v1 projector failure may be represented by a host's existing indeterminate fallback, but it
must not become an ordinary grade or clean result. Duplicate browser/pipeline implementations are
not deleted until the approved byte-parity and rollback evidence exists.

## Public identity, rights, and release ownership

Scanner readiness does not authorize a public identity migration. [`EntrySecurity`](../../contracts/index.ts)
and committed entry artifacts remain on their existing v1-compatible contract. Changes to
`EntrySecurity`, public entry projections, catalogue identity, rights/permission fields, disclosure,
MCP behavior, deployment, signing, publication, or release pointers require a separately approved
orchestrator-owned change with its own evidence and rollback artifact.

The local implementation and focused tests do not establish external gates. The following remain
unperformed unless an owner records them elsewhere:

- external CI and clean-install cross-platform validation;
- independent security, compatibility, documentation, human-adjudication, legal, and rights review;
- full-corpus acquisition/rescan and an old/new result diff;
- browser/deployed-origin, emitted Worker no-network, or hosting validation;
- signed release manifest, SBOM, provenance, deployment, npm/GitHub publication, or repository merge.

The [v2 release readiness report](release-v2-readiness-report.md) is the local evidence record for
those pending dispositions; it does not convert them into approvals. It is the dated 2026-09-09
record for the superseded `codex/release-v2` candidate and now carries a dated correction banner,
so [`check-scanner-evidence-freshness.mjs`](../../scripts/check-scanner-evidence-freshness.mjs)
no longer treats it as current evidence.

## Non-claims

This migration page does not claim that all adapters are converged, that
beta-hardened is admitted on v2, that an advisory applies to a host, that rights or legal review has
passed, or that a v2 result changes any public entry identity.
