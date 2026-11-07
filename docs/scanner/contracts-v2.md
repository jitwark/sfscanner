# Scanner v2 contracts

> Status: admitted-core contract reference; external conformance remains gated
> Last verified: 2026-10-17
> Owner: Scanner maintainer
> Source of truth: [`contracts/scanner-v2-result.ts`](../../contracts/scanner-v2-result.ts), [`contracts/scanner-v2-source.ts`](../../contracts/scanner-v2-source.ts), [`contracts/scanner-v2-evidence.ts`](../../contracts/scanner-v2-evidence.ts), [`contracts/scanner-limits-v2.ts`](../../contracts/scanner-limits-v2.ts), and [`openspec/changes/world-class-scanner-cli/result-v2-contract.md`](../../openspec/changes/world-class-scanner-cli/result-v2-contract.md)

This page is the map to the closed v2 request, result, evidence, capability, diagnostic, limits, and
identity contracts. It documents the admitted `beta-default@2.0.0` path; the existing v1 contracts
remain unchanged and are covered by [migration-v1-v2.md](migration-v1-v2.md).

## Request and tool failures

The direct v2 entrypoint is [`scanWorkflowV2`](../../packages/scanner-core/src/v2/scan-workflow.ts).
Its request is bytes-first:

```ts
type ScanWorkflowV2Request = {
  bytes: Uint8Array;
  profile: { id: string; version: string };
  target?: unknown;
  limits?: unknown;
  approvedDomains?: readonly string[];
};
```

The input record, profile reference, target, limits, and approved-domains list are closed data; an
empty approved-domains list is treated as absent. Omitted target facts become unknown target values;
omitted limits resolve to the frozen v2 defaults. The initial admitted profile
is exactly `beta-default@2.0.0`. A malformed request, unknown target configuration key, non-admitted
profile, invalid source, or invariant failure returns a stable v2 failure code and no fabricated
result. Host timeout and cancellation are host outcomes; core does not read a clock.

The failure vocabulary is closed in the entrypoint and includes UTF-8/JSON/workflow failures,
configuration and profile admission failures, semantic/rule admission failures, invariant and
serialization failures, and host timeout/cancellation codes. The v2 CLI maps these through its
separate exit contract in [`exit-reducer.ts`](../../packages/scanner-cli/src/v2/exit-reducer.ts);
failure text is generic and must not contain source content, secrets, exception text, or absolute
paths.

## Result envelope

Every successful result has `schemaVersion: "scanner-result-v2"` and these top-level records:

| Record | Contract and purpose |
| --- | --- |
| `engine` | `id`, strict engine `version`, and `buildDigest`; current admitted identity is `secureflow-scanner@2.0.0`. |
| `input` | Exact-byte `rawSha256`, normalized `semanticSha256`, `ambiguitySha256`, ambiguity count, and UTF-8 byte count. |
| `profile` | Admitted profile `id` and version; current v2 profile is `beta-default@2.0.0`. |
| `ruleset` | Rule-pack ID/version/digest and `VERIFIED` or `UNVERIFIED` signature status. In v2 this is the built-in authority interpretation of a compiled, digested artifact; it is not an Ed25519 verification, and no external pack is admitted (see [`key-rotation.md`](key-rotation.md)). |
| `semantics` | Semantic catalogue ID/version/digest. |
| `target` | Canonical target context and its `contextDigest`. |
| `limits` | `scanner-limits-v2`, limits digest, and one usage row per measured budget (`MEASURED_LIMIT_IDS`). |
| `analysis` | Capability execution rows, diagnostics, and aggregate `COMPLETE`, `DEGRADED`, or `INDETERMINATE` status. |
| `workflow` | Safe workflow overview and normalized edge counts. |
| `facts` / `traces` | Registered safe evidence and bounded trace steps. |
| `findings` | Registered rule findings with safe references, conclusion, applicability, and evidence class. |
| `assessment` | A scoring result, or `null` whenever analysis is indeterminate. |
| `stats` | Rejected/collapsed candidate counts, omitted findings, and canonical serialized byte count. |

[`scanner-v2-result.ts`](../../contracts/scanner-v2-result.ts) rejects unknown keys, malformed
nested records, invalid enum values, unsafe strings, duplicate references, dangling references,
invalid ordering, and inconsistent status/assessment combinations. JSON is canonicalized with the
repository's `secureflow-canonical-json-v1` serializer before digest and serialized-byte checks.

## Source, subjects, and evidence

Source and semantic representations are intentionally distinct. The parser-owned source graph is
internal; safe facts are the only source-derived values allowed into a serialized result.

| Contract | Meaning |
| --- | --- |
| `SourceMemberRefV2` | RFC 6901 pointer, ancestor occurrence path, source `astNodeId`, and nullable span. |
| `NodeRefV2` | Source ordinal and source reference, with an explicit ID/name only when unambiguous, plus `identityDigest`. |
| `EdgeRefV2` | Source/target labels, optional uniquely resolved endpoints, connection type, source/target ports, source reference, ordinal, and `RESOLVED`/`AMBIGUOUS`/`UNRESOLVED` state. |
| `SubjectV2` | Exactly one of `WORKFLOW`, `NODE`, `EDGE`, or `SOURCE`; subject identity never uses display prose. |
| `SafeFactV2` | Registered kind, subject, and allowlisted scalar/list properties; no raw source, credentials, arbitrary objects, URLs, or exception text. |
| `TraceV2` | Bounded `CONFIDENTIALITY`, `INTEGRITY`, or `CONTROL` steps whose fact references resolve exactly. |
| `FindingV2` | Rule identity and authority metadata plus evidence class, conclusion, applicability, subject, fact/trace references, and remediation ID. |

The exact TypeScript shapes are in [`scanner-v2-source.ts`](../../contracts/scanner-v2-source.ts) and
[`scanner-v2-evidence.ts`](../../contracts/scanner-v2-evidence.ts). Fact kinds, subject kinds,
required properties, enums, owners, and v1 evidence projections are closed by
[`safe-fact-registry.ts`](../../packages/scanner-core/src/facts/safe-fact-registry.ts); its registry
is not a general-purpose object serialization API.

## Capability execution and rule authority

The capability scheduler and profile manifest are the source for execution identity and dependency
order: [`scheduler.ts`](../../packages/scanner-core/src/capabilities/scheduler.ts) and
[`profile-manifest.ts`](../../packages/scanner-core/src/capabilities/profile-manifest.ts). The
admitted default profile has these required rows, in order:

| Capability | Depends on | Rule ownership |
| --- | --- | --- |
| `source-normalization` | — | Source fingerprint fact |
| `workflow-insights` | `source-normalization` | Workflow summary/function/integration facts |
| `structural-policies` | `source-normalization` | `N8N_EXECUTE_COMMAND`, `N8N_CODE_NODE`, `RAW_AUTH_HEADER`, `RAW_SECRET_INDICATOR`, `UNAPPROVED_DOMAIN`, `UNKNOWN_NODE_PACKAGE`, `WEBHOOK_EXPOSURE` |
| `assessment` | `workflow-insights`, `structural-policies` | Assessment construction |
| `presentation-facts` | `assessment` | Presentation-safe result facts |

Each selected capability has one execution record with ID, version, requiredness, status, examined,
analyzed, skipped and omitted counts, and diagnostic references. A failed dependency is `SKIPPED`
with `DEPENDENCY_UNAVAILABLE`; it does not reuse stale output. Candidate validators reject unknown
rules, unregistered facts, duplicate IDs, malformed references, and unsafe shapes. Rule effect,
severity, confidence, revision, and remediation identity come from the admitted rule view, not from
an analyzer candidate.

The defined hardened manifest contains optional/report-only code, graph, taint, and agentic rows,
but the v2 admitted registry currently contains only the default manifest. Hardened source presence
is not v2 scoring or coverage authority.

## Diagnostics and completeness

The closed diagnostic registry is [`registry.ts`](../../packages/scanner-core/src/diagnostics/registry.ts)
and the result validator consumes the same vocabulary. Every code has a category, aggregate effect,
assessment eligibility, and v1 projection disposition. Capability-scoped codes use selected
requiredness; fixed parser, limit, graph, policy, and compatibility codes retain their registered
effect.

The status lattice is `NONE < DEGRADED < INDETERMINATE`:

- `COMPLETE` requires every selected capability to be completed, zero omitted counts, valid
  references, and no diagnostic with a non-`NONE` effect.
- `DEGRADED` records safe loss in optional/report-only analysis or presentation evidence.
- `INDETERMINATE` records required/scoring loss, security-relevant ambiguity, malformed security
  evidence, or another condition that could hide a conclusion. Assessment is `null`.

Diagnostic `observed`, `maximum`, and `omitted` values are bounded evidence, not permission to
silently discard required work. Unknown diagnostics fail result validation rather than defaulting to
an effect.

## Limits and accounting

[`scanner-limits-v2.ts`](../../contracts/scanner-limits-v2.ts) extends the frozen v1 limits without
changing v1 defaults. Current v2 defaults are:

| Limit | Default | Limit | Default |
| --- | ---: | --- | ---: |
| `maxBytes` | 1536000 | `maxNodes` | 5000 |
| `maxEdges` | 10000 | `maxConnectionDepth` | 64 |
| `maxParameterDepth` | 64 | `maxParameterLeaves` | 10000 |
| `workerDeadlineMs` | 30000 | `maxSyntaxNodes` | 250000 |
| `maxDocumentDepth` | 256 | `maxMembersAndElements` | 250000 |
| `maxRawEdges` | 50000 | `maxDuplicateKeys` | 1000 |
| `maxDiagnostics` | 1000 | `maxStoredSourceSpans` | 25000 |
| `maxSourceWork` | 1000000 |  |  |
| `maxExpressionTokens` | 100000 | `maxCodeSyntaxNodes` | 250000 |
| `maxGraphOperations` | 1000000 | `maxTaintStates` | 250000 |
| `maxTraceStepsPerFinding` | 100 | `maxFindings` | 5000 |
| `maxRedactionPatches` | 10000 | `maxRedactedArtifactBytes` | 1536000 |
| `maxEvidenceBytes` | 1536000 | `maxSerializedResultBytes` | 5000000 |
| `maxRuleOperations` | 1000000 |  |  |

All budgets are non-negative safe integers; `maxDiagnostics` is at least one so the reserved
exhaustion record remains representable. Boundary values are inclusive. A source boundary failure
returns a typed item failure; an isolated capability boundary produces required or optional limit
evidence according to its manifest row. Every result usage row records maximum, examined, omitted,
and exhaustion state. Rows exist only for the measured budgets; every other budget's state is
declared once in `ADMITTED_LIMIT_STATES` and stated in `--help`, never published as a literal-zero
row. The full outcome table is in
[`result-v2-contract.md`](../../openspec/changes/world-class-scanner-cli/result-v2-contract.md).

`ADMITTED_LIMIT_STATES` in [`scanner-limits-v2.ts`](../../contracts/scanner-limits-v2.ts) is the
single classification for every one of the 26 numeric fields:

| State | Meaning | Result usage |
| --- | --- | --- |
| `WIRED` (22) | Consumed by the admitted `beta-default` path. | A row only when a real per-scan counter exists. |
| `DORMANT` (2) | Consumed only by an unadmitted profile. | No row. |
| `UNWIRED` (2) | No shipped consumer. | No row. |

Exactly 13 of the `WIRED` fields carry a `MEASURED_LIMIT_IDS` counter, so a scan reports at most 13
usage rows. A budget without a counter is enforced where it is consumed and is not reported as
`examined: 0`.

## Identity and ordering

- `rawSha256` hashes the exact input bytes, including an accepted UTF-8 BOM.
- `semanticSha256` binds the canonical normalized security workflow and ambiguity records to the
  target `contextDigest`; `ambiguitySha256` separately identifies canonical ambiguity records.
- Fact IDs hash registered kind, canonical subject identity, and canonical properties. Finding IDs
  hash rule revision, evidence class, conclusion, applicability, subject identity, and sorted fact/
  trace references. Prose does not affect identity.
- Capabilities follow profile order; diagnostics follow capability and registry order; facts and
  traces sort by ID; findings sort by severity, rule, subject identity, and finding ID; target
  packages sort by name/version and configuration by key.
- Optional fields are absent, nullable fields are explicit `null`, and scores are integers in the
  closed range 0–100.

Composition and validation meet at [`compose-result.ts`](../../packages/scanner-core/src/result-v2/compose-result.ts);
identity and scoring implementations are [`identities.ts`](../../packages/scanner-core/src/result-v2/identities.ts)
and [`scoring.ts`](../../packages/scanner-core/src/result-v2/scoring.ts).

## Scoring and v1 projection

Only `SCORING` findings that are `APPLICABLE` and `OBSERVED` enter the v2 assessment. Report-only,
potential, unknown, and not-applicable findings remain visible but are excluded by the scoring
contract. A required unknown or omitted condition suppresses the assessment entirely.

The explicit v2-to-v1 adapter is [`v1-projector.ts`](../../packages/scanner-core/src/compat/v1-projector.ts);
its registry and templates are [`v1-registry.ts`](../../packages/scanner-core/src/compat/v1-registry.ts).
It validates safe facts and registered templates, preserves frozen v1 ordering, maps representable
fields, and reports real engine version `2.0.0` rather than relabelling it `scanner-beta-1`. Any
unsafe projection loss is indeterminate and uses only the frozen v1 diagnostic vocabulary. Native
v1 still uses its grandfathered identity; see [migration-v1-v2.md](migration-v1-v2.md).

## Non-claims

This contract reference does not claim that every defined capability is admitted, that hardened or
advisory analysis is available in v2, or that local contract validation is external conformance. It
does not claim external CI, human adjudication, legal or rights approval, deployment, signing,
publication, full-corpus rescan, or merge success.
