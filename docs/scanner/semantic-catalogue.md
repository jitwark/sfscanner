# Scanner v2 semantic catalogue

> Status: admitted built-in catalogue reference; provenance, advisory, and release approvals remain gated
> Last verified: 2026-10-17
> Owner: Scanner maintainer
> Source of truth: [`packages/scanner-core/src/semantics/builtin-catalogue.ts`](../../packages/scanner-core/src/semantics/builtin-catalogue.ts), [`packages/scanner-core/src/semantics/builtin-provenance.ts`](../../packages/scanner-core/src/semantics/builtin-provenance.ts), [`semantic-source-receipts.json`](semantic-source-receipts.json), [`packages/scanner-core/src/semantics/catalogue-admission.ts`](../../packages/scanner-core/src/semantics/catalogue-admission.ts), [`packages/scanner-core/src/semantics/catalogue-resolver.ts`](../../packages/scanner-core/src/semantics/catalogue-resolver.ts), [`packages/scanner-core/src/advisories/`](../../packages/scanner-core/src/advisories/), and [`openspec/changes/world-class-scanner-cli/specs/scanner-semantic-catalogue/spec.md`](../../openspec/changes/world-class-scanner-cli/specs/scanner-semantic-catalogue/spec.md)

The semantic catalogue describes what a workflow node can do and how its fields connect to sources,
sinks, sanitizers, ports, and effects. It is not an advisory spreadsheet, a host inventory, a
severity table, or a vulnerability verdict. The separation is an accepted decision in the
[semantics and advisories ADR](../decisions/scanner-semantics-and-advisories.md).

## Admitted built-in catalogue

The v2 engine currently admits the built-in catalogue with this identity:

| Field | Value |
| --- | --- |
| Schema | `scanner-semantics-v2` |
| ID | `scanner-core-builtins` |
| Version | `2.2.0` |
| Configuration vocabulary | `allowNetwork`, `approvedDomains` |

The records cover the currently catalogued ingress, HTTP/AI, database/file, command/code,
messaging/MCP, subworkflow, and Git node families, plus two pinned non-family records.
`n8n-nodes-base.noOp` is a pure passthrough, so `noop.passthrough` resolves it at exactly version
`1.0.0` instead of raising `SEMANTIC_CATALOGUE_MISS` for a node that only forwards its input.
`n8n-nodes-base.stickyNote` is an annotation with no inputs, outputs, credentials, or effects, so
`annotation.sticky-note` resolves exactly version `1.0.0` with no ports. Any other version of either
node resolves through the generic node fallback below, and both records keep the conservative
catalogue defaults. The source
record list is authoritative; this page intentionally does not duplicate every node record or
invent coverage for unlisted node types.

Each record is closed, versioned, canonically ordered, and digest-bound. Its fields are:

| Field group | Meaning |
| --- | --- |
| Identity and match | `semanticId`, node type, strict version range, and optional operation. |
| Workflow shape | Entry status (`TRIGGER`, `MANUAL`, `SUBWORKFLOW`, or `NONE`), parameter paths, ports, item mode, overwrite paths, error mode, retry mode, and disabled mode. |
| Security interpretation | Authentication marker and recognized values, credential paths, destination paths, effects, and source/sink/sanitizer endpoints. |
| Provenance | HTTPS source URL, source-content digest, receipt review date (`reviewedAt`), and reviewer identity (`reviewer`). |

Catalogue records may describe `EXECUTE_COMMAND`, `EXECUTE_CODE`, file, database, external, message,
tool, or subworkflow effects. They do not assign finding severity, confidence, rule effect, score,
grade, or assessment weight; those belong to the admitted rule and assessment authorities.

## Admission and digest

[`catalogue-admission.ts`](../../packages/scanner-core/src/semantics/catalogue-admission.ts) rejects
unknown keys, malformed arrays, invalid strict SemVer/ranges, invalid pointers or enums, duplicate
IDs/records/configuration keys, invalid provenance, and digest mismatches. It normalizes canonical
ordering before computing the SHA-256 catalogue digest and returns a deeply frozen value.

[`builtin-provenance.ts`](../../packages/scanner-core/src/semantics/builtin-provenance.ts) binds each
built-in record's `sourceDigest` to the committed receipt
[`semantic-source-receipts.json`](semantic-source-receipts.json): the digest covers that record's
supporting package files as the receipt records them, `reviewedAt` is the receipt packages' fetch
date, and `reviewer` is the agent review label `scanner-core-semantics-agent-review` — an explicit
agent review, not a human sign-off. A changed upstream byte or a changed supporting-file list
changes that record's digest, and with it the catalogue digest; a record with no receipt entry
fails closed with `INVALID_PROVENANCE` rather than falling back to a repeated default digest.

A catalogue record's provenance fields are data required by admission, not evidence that an external
review or release gate has occurred. The runtime's built-in catalogue is the admitted authority for
the current v2 path. Adding or changing a record requires a new digest and the corresponding
profile, fixture, parity, and release review; a file placed beside the source cannot silently alter
admission.

## Resolver precedence

[`catalogue-resolver.ts`](../../packages/scanner-core/src/semantics/catalogue-resolver.ts) resolves
without network access. Its deterministic precedence is:

1. exact node type with a matching version range;
2. a matching canonical alias and version range, when aliases are supplied by the caller; or
3. a generic wildcard node-type record with a matching version range.

Within the selected node-type candidates, an exact operation beats a node-default (`operation: null`)
record. The resolver chooses a single most-specific range only when that range is a strict subset of
every competing match. Equal or incomparable matches fail with `SEMANTIC_CATALOGUE_AMBIGUOUS`; an
invalid catalogue is rejected rather than selected by incidental array order. No nearest version,
lexical fallback, or live package lookup is used.

The direct v2 scan resolves each normalized node against the built-in catalogue using its node type,
normalized `typeVersion`, and available operation field. No nearest version, lexical match, or live
package lookup is used, and the admitted catalogue itself carries no wildcard record.

A node the catalogue does not model is resolved by the **generic node fallback**
([`packages/scanner-core/src/semantics/generic-fallback.ts`](../../packages/scanner-core/src/semantics/generic-fallback.ts),
[ADR](../decisions/ADR-generic-node-semantic-fallback.md)): a frozen record with
`semanticId: 'generic.fallback'`, main-in → main-out passthrough ports, `READ_EXTERNAL` and
`WRITE_EXTERNAL` effects, `UNKNOWN` error/retry modes, and no claim about destinations,
authentication, operations, or parameters. It is synthesised at the resolution seam, so the admitted
catalogue digest does not move. The owning capability emits **two** diagnostics at degraded
requiredness (`required: false`) once per readable fallback node, at that node's source location and in
registry order: `SEMANTIC_CATALOGUE_MISS` (no admitted record) and
`GENERIC_NODE_UNMODELED_CAPABILITY` (the verdict rests on unmodelled-capability defaults;
destinations are unknown, not audited-and-empty). Both are `DEGRADED`/assessment-eligible, and the
report renders both, so a reader can see which nodes rest on the assumption. The parameter, credential,
secret-indicator, and URL audits run for these nodes exactly
as for modelled ones — the fallback changes what the engine assumes about data flow, never whether it
looks.

The fallback applies only when the node's fields were readable. A genuinely unresolved node keeps only
`SEMANTIC_CATALOGUE_MISS` at the caller's requiredness: a **required** miss is `INDETERMINATE` with the
assessment withheld, an **optional** miss is `DEGRADED`/eligible and does not withhold it by itself;
an unreadable `type` refuses the scan with `SEMANTIC_CATALOGUE_INVALID`.

## Target context is separate

Node `typeVersion` identifies the serialized node shape being interpreted. It is not proof of the
installed n8n version or deployment. [`target-context.ts`](../../packages/scanner-core/src/semantics/target-context.ts)
defines the separate target input:

| Target field | What it represents |
| --- | --- |
| `n8nVersion` | Installed or claimed n8n version, strict SemVer when supplied. |
| `edition` | `COMMUNITY`, `ENTERPRISE`, `CLOUD`, or `UNKNOWN`. |
| `deployment` | `SELF_HOSTED`, `CLOUD`, or `UNKNOWN`. |
| `role` | `OWNER`, `ADMIN`, `MEMBER`, or `UNKNOWN`. |
| `taskRunner` | `LEGACY`, `NATIVE`, or `UNKNOWN`. |
| `communityPackages` | Canonical package names with optional strict versions. |
| `configuration` | Catalogue-vocabulary keys with `ENABLED`, `DISABLED`, or `UNKNOWN` state. |
| `contextDigest` | Digest of the normalized target body, excluding the digest field itself. |

Target packages and configuration keys are sorted canonically; duplicates are invalid. Unknown
configuration keys are a pre-scan `UNKNOWN_CONFIGURATION_KEY` error rather than an ignored setting.
Missing known facts normalize to `UNKNOWN`, and target facts are never guessed from node type,
workflow labels, or a source URL. The target digest is bound into the v2 semantic input identity.

## Destinations and ingress

Semantic interpretation inventories destination fields independently of allowlist configuration.
[`semantic-context.ts`](../../packages/scanner-core/src/capabilities/semantic-context.ts) uses the
catalogue's destination paths to create `destination.v2` facts for literal, dynamic, and unknown
authority values. URL parsing is local; a reachable URL is never contacted. An empty approved-domain
configuration does not make destination inventory disappear.

Ingress semantics use versioned authentication values for supported webhook, form, chat, and manual
entry nodes. Missing, empty, or unrecognized authentication values are not treated as authenticated.
The structural `WEBHOOK_EXPOSURE` policy remains a rule decision over admitted evidence; semantic
catalogue records do not assign its severity or score.

## Advisories are a different artefact family

Advisory types and admission are defined in [`advisory-schema.ts`](../../packages/scanner-core/src/advisories/advisory-schema.ts)
and [`advisory-admission.ts`](../../packages/scanner-core/src/advisories/advisory-admission.ts).
An admitted advisory record carries:

- a primary identifier and aliases;
- canonical package name, raw publisher affected range, normalized strict-SemVer clauses, fixed
  versions and branches;
- explicit edition, deployment, role, package, configuration, or version prerequisites;
- optional publisher/version CVSS data; and
- HTTPS source URL, source digest, review marker, reviewer identity, and review state.

Quarantined records do not enter the admitted advisory set. Invalid ranges, duplicate identifiers
or aliases, unsafe provenance, invalid package names, and digest mismatches reject admission.
Advisory prose and URLs never become scanner rules or score metadata.

[`advisory-applicability.ts`](../../packages/scanner-core/src/advisories/advisory-applicability.ts)
evaluates applicability locally:

| Evidence state | Result |
| --- | --- |
| Required target version/package/prerequisite is missing | `UNKNOWN` |
| Advisory is not admitted | `UNKNOWN` |
| Known version is fixed or outside the affected range | `NOT_APPLICABLE` |
| A required prerequisite is known and fails | `NOT_APPLICABLE` |
| All required version and prerequisites are known and match | `APPLICABLE` |

Workflow capability evidence may be reported without claiming that a host advisory applies. The
current `scanWorkflowV2` path passes the explicit empty advisory catalogue from
[`semantic-context.ts`](../../packages/scanner-core/src/capabilities/semantic-context.ts); no live
advisory service or scan-time network resolution is implied by the advisory contracts.

## Unknowns and non-claims

A catalogue miss on an unreadable node, an ambiguous match, a missing target fact, dynamic
destination authority, an unrecognized authentication marker, or a quarantined advisory is explicit
uncertainty. Uncertainty is never converted to a *nearest* semantic record, `NOT_APPLICABLE`, or a
clean security conclusion. The generic node fallback is not a nearest-record match and not a clean
reading: it is a fixed, conservative assumption, its record claims nothing about the node's fields,
and every node it covers is labelled with a degraded coverage diagnostic. Required/scoring unknown
evidence can still make the result `INDETERMINATE`; optional/report-only loss is `DEGRADED`.

This document does not claim that the built-in catalogue covers all n8n node types, that semantic
records prove runtime execution, that an advisory applies to any deployment, or that provenance,
legal, CI, deployment, signing, publication, or independent human review gates have passed. It also
does not claim that a fallback record describes what an unmodelled node actually does.
