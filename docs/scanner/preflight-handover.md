# Offline preflight and handover

> Status: current contract for the offline preflight/handover modules and the preserved output surfaces
> Last verified: 2026-10-29
> Owner: Scanner maintainer
> Source of truth: [`packages/scanner-cli/src/v2/preflight-readiness.ts`](../../packages/scanner-cli/src/v2/preflight-readiness.ts), [`packages/scanner-cli/src/v2/privacy-prepare.ts`](../../packages/scanner-cli/src/v2/privacy-prepare.ts), [`packages/scanner-core/src/result/analysis-completeness.ts`](../../packages/scanner-core/src/result/analysis-completeness.ts), [`pipeline/export/`](../../pipeline/export/), [`packages/scanner-core/src/report/sarif-v2/output.ts`](../../packages/scanner-core/src/report/sarif-v2/output.ts), and [`AGENTS.md`](../../AGENTS.md) rule 9

This page records three things an operator needs before a scanned n8n workflow is handed to another
person or team: what the offline preflight report observes and refuses to claim, which product
formats stay first-class, and the rule that bounds any future expansion of the workflow catalogue.
It is documentation of an implemented contract, not a release or deployment approval.

## Preflight is observation, never clearance

`buildPreflightReadinessReport` in
[`preflight-readiness.ts`](../../packages/scanner-cli/src/v2/preflight-readiness.ts) builds an
offline readiness report from a workflow document. It reads the export, never executes it, mutates
nothing and performs no I/O; the module is bounded and browser-safe by test, so the browser worker
and the CLI can share one contract.

Every report carries the same three refusals in its own payload:

| Field | Value | Meaning |
| --- | --- | --- |
| `schemaVersion` | `n8n-preflight-readiness-v1` | Report identity versioned independently of the scan result schema, so one cannot silently stand in for the other. |
| `safetyClearance` | `NOT_PROVIDED` | The report never certifies a workflow as safe, runnable or fully analyzed. |
| `disclaimer.id` | `NOT_SAFETY_CLEARANCE` | A clean or low-severity scan "does not prove the workflow is bug-free, secure, fully analyzed or runnable, and it does not replace an import, execution, deployment or credential check on the declared target." |

A low aggregate score is therefore not evidence of safety. No finding means "no catalogued evidence
was found in the portion we could analyze" — see [limitations.md](limitations.md). When a workflow
contains a node the scanner does not model, the report keeps that incompleteness instead of logging
an implicit pass.

### Completeness and severity are separate axes

The report keeps the two questions apart:

- `findings` — matched rule evidence: `total`, `bySeverity` counts for `critical | high | medium |
  low | info`, `highestSeverity`, and a stable-sorted `items` list. Severity ranks findings against
  each other. It never summarizes analysis quality. A finding whose severity is not one of those
  five values is rejected with a `TypeError` rather than coerced into an adjacent bucket.
- `completeness` — `status` (`COMPLETE | DEGRADED | INDETERMINATE`) plus the ordered `reasons` that
  produced it. This is the axis that says how much of the workflow was actually read.

The status is derived from the reason list, not from finding counts: no reasons is `COMPLETE`; any
`ANALYSIS_NOT_REPORTED` reason makes the whole report `INDETERMINATE`; every other reason makes it
`DEGRADED`.

| Reason code | What it counts | Grade |
| --- | --- | --- |
| `MALFORMED_NODE_ENTRY` | Node entries skipped because they carry no `type`. | `DEGRADED` |
| `UNKNOWN_NODE_TYPE` | Any node type the report holds no admitted semantic model for, counted fail-closed. That covers types outside the admitted `n8n-nodes-base.` and `@n8n/n8n-nodes-langchain.` prefixes **and** unmodelled types that sit inside those prefixes, such as `n8n-nodes-base.notARealNode`. Identity is resolved against an exact admitted-type table, not a namespace match, so an unrecognised official-prefixed type is never treated as known just because its prefix is familiar. | `DEGRADED` |
| `UNSUPPORTED_NODE` | Nodes the analysis reported as unsupported (`analysis.unsupportedNodes`). | `DEGRADED` |
| `UNRESOLVED_EDGE` | Connection edges that could not be resolved, leaving the reachable graph partial. | `DEGRADED` |
| `AMBIGUITY` | Duplicate or ambiguous members reported by normalization. | `DEGRADED` |
| `TRUNCATED_ANALYSIS` | Analysis stopped at a bound, so retained evidence covers only part of the workflow. | `DEGRADED` |
| `DYNAMIC_PREREQUISITE_VALUE` | A subworkflow id is dynamic and cannot be resolved offline. | `DEGRADED` |
| `PREREQUISITE_INVENTORY_LIMIT` | Parameter traversal reached a complexity ceiling (depth, values or characters), so discovered environment references may be partial. | `DEGRADED` |
| `ANALYSIS_NOT_REPORTED` | The caller supplied no analysis signals at all, so completeness is unknown rather than complete. | `INDETERMINATE` |

Two adjacent vocabularies stay distinct on purpose. The preflight status above is computed from
preflight reasons. The scan engine's own status is computed from its diagnostics by
`classifyAnalysisStatus` in
[`analysis-completeness.ts`](../../packages/scanner-core/src/result/analysis-completeness.ts),
where a required stage that could not run (`REQUIRED_STAGE_FAILURE`) is `INDETERMINATE` and bounded
omissions are `DEGRADED`. Prerequisite gaps never upgrade or downgrade the scan status, and a
`COMPLETE` scan is not a clearance either. Unknown and degraded states survive into exports and CI
policy; `--require-complete` turns a degraded result into exit `1` rather than hiding it.

### Prerequisite checklist

`prerequisites` inventories what a recipient must supply before the workflow can run. Every row cites
its evidence path rather than an inference:

| Collection | Per-row evidence | Always unknown |
| --- | --- | --- |
| `credentials` | `credentialType`, `credentialName`, `node`, `nodeType`, pointer `/nodes/<index>/credentials/<type>`, and whether the reference is `ID_AND_NAME`, `ID_ONLY`, `NAME_ONLY` or `EMPTY` | `offlineValidity` and `ownership` are both `UNKNOWN`: an export holds a reference, not a secret, a scope, an expiry or an owner. |
| `communityNodes` | `packageName` (the node type prefix before the last dot), `nodeTypes`, `nodes`, observed `typeVersions` | `packageVersion` is `null` and `installed` is `UNKNOWN`; an export records no npm version and no installation state. |
| `integrations` | `service`, `nodeType`, `nodes`, `credentialTypes` for official, non-utility, non-subworkflow nodes | Whether the remote service is reachable, licensed or configured. |
| `subworkflows` | `node`, pointer `/nodes/<index>/parameters/workflowId`, `targetWorkflowId` when literal, and `resolution` (`LITERAL`, `DYNAMIC`, `ABSENT`) | `targetExistence` is `UNKNOWN`: existence and validity of the referenced workflow cannot be established offline. |
| `environment` | `namespace` (`ENV` or `VARS`), `name`, `evidence` (`source`, `pointer`, `node`, `nodeType`, `typeVersion`) | `value` and `availability` are both `UNKNOWN`: a reference shows an identifier was observed in parameters, not that the variable exists or is populated on a host. |
| `provenance` | `source: 'WORKFLOW_EXPORT'`, `pointer: '/'` | `repository`, `commit`, `licence`, `verification` are `UNKNOWN`: self-declared export IDs and metadata do not prove origin. |

`prerequisites.unknowns` states the standing caveats in the same report, including that disabled
nodes are listed as exported and whether they need their prerequisites at run time is not evaluated.
Credential ownership, validity, missing secrets and live package installation are never inferred
from a workflow export.

### Target-version checks without a migration claim

`target` answers one narrow question: given an explicitly declared n8n target and caller-supplied,
sourced platform facts, does any admitted fact conflict with this workflow?

- `n8nTarget` must be the literal `'1.x'` or `'2.x'`. Anything else — including no declaration —
  yields `declared: null` and status `INDETERMINATE`, with a note that compatibility is unknown.
- Platform facts arrive with the caller. Each `PlatformCompatibilityFactV1` carries its own
  `featureId`, `nodeTypes`, `supportedTargets`, optional `maxTypeVersionByTarget` and its own
  `source`; a fact without a `source` and `nodeTypes` is ignored rather than guessed at.
  `DEFAULT_PLATFORM_FACTS_V1` is empty: no pinned platform fact is admitted yet, so a check run
  without sourced facts finds nothing and says so.
- Node `typeVersion` is compared numerically against the admitted maximum for the declared target,
  and only when the fact declares one. Platform release, node `typeVersion` and npm package version
  are three separate identities and are never substituted for each other.

| Code | Meaning |
| --- | --- |
| `FEATURE_NOT_SUPPORTED_BY_TARGET` | The fact's `supportedTargets` does not include the declared target, and either a matching node exists or the feature was declared required. |
| `TYPE_VERSION_NOT_SUPPORTED_BY_TARGET` | A node's `typeVersion` exceeds the maximum admitted for the declared target. |
| `TYPE_VERSION_UNKNOWN` | The fact admits a maximum, but the node's `typeVersion` is absent or unreadable, so support is unknown. |

Target status is `INCOMPATIBLE` when any finding other than `TYPE_VERSION_UNKNOWN` exists, `UNKNOWN`
when only `TYPE_VERSION_UNKNOWN` findings exist, and `NO_RECOGNIZED_CHANGE` when none exist.
`migrationTested` is `false` in every case, and the report says so in its notes: this is not a
migration test, it does not prove the workflow imports or executes on the target, and the absence of
a recognized conflict is not migration success. A no-match result is not a successful migration.

### Opt-in privacy preparation

`prepareWorkflowPrivacy` in
[`privacy-prepare.ts`](../../packages/scanner-cli/src/v2/privacy-prepare.ts) prepares a shareable
copy of a workflow. It is additive and opt-in: it runs only when a caller invokes it, it introduces
no automatic rewriting and it never executes a workflow.

The contract is deliberately narrow:

- **Pure and non-destructive.** It takes `workflow` plus optional `internalUrlPlaceholder` and
  `internalHostSuffixes`, returns a fresh deep copy, and never mutates the input. Structure,
  ordering and unrelated values are preserved; the input bytes are untouched.
- **Clean copy plus an exact change list.** The result carries `workflow` (the scrubbed copy),
  `changed`, and `changes` — `{ path, kind, originalExcerpt, replacement }` per replacement, sorted
  by JSON pointer. `kind` is one of `CREDENTIAL`, `HEADER`, `INTERNAL_URL`, `TOKEN`. Excerpts stop
  at 80 characters.
- **A reviewable unified diff.** `diff` is generated from the before/after JSON, with
  `--- workflow.before.json` / `+++ workflow.after.json` headers and `@@ -start,len +start,len @@`
  hunks of `-` and `+` lines. Replacements keep one value per line, so changed lines align
  one-to-one; the diff carries no context lines. No changes produce an empty string.
- **Idempotent reruns.** Values already equal to a placeholder are not recorded again, so
  preparing an already-prepared copy yields no changes and an empty diff.

| What is replaced | How it is recognised | Placeholder |
| --- | --- | --- |
| Credential reference `id` and `name` | Keys under `credentials` in a node | `[REDACTED_CREDENTIAL_ID]`, `[REDACTED_CREDENTIAL_NAME]` |
| Sensitive HTTP header values | `value` in `/headerParameters/parameters/` entries whose `name` is `authorization`, `proxy-authorization`, `cookie`, `set-cookie`, `x-api-key`, `x-auth-token`, `x-access-token`, `x-secret`, `x-api-token`, `api-key` or `apikey` | `[REDACTED_HEADER_VALUE]` |
| Internal endpoints | Absolute URLs whose host is `localhost`, `0.0.0.0`, loopback/private/link-local IPv4 or IPv6 (including IPv4-mapped), a dotless host, or ends in `.local`, `.internal`, `.localdomain`, `.lan`, `.home.arpa`, `.corp`, `.intranet` (extendable) | `https://internal.example.invalid/...` (overridable) |
| Webhook path and id | `path` on an `n8n-nodes-base.webhook` node, and `webhookId` | `[REDACTED_WEBHOOK_PATH]`, `[REDACTED_WEBHOOK_ID]` |
| Secret parameter values and embedded tokens | `parameters` keys such as `password`, `token`, `secret`, `client_secret`, `private_key`, `access_token`; plus bearer/basic credentials and `?token=`-style query values inside strings | `[REDACTED_TOKEN]` |

The result states its own limit rather than leaving it to prose: `completeRedactionGuaranteed` is
the literal `false`, and `disclaimer` is the exported constant `PRIVACY_PREPARE_DISCLAIMER_V1`,
which reads "Heuristic and rule-bounded privacy preparation. Does NOT guarantee complete secret or
PII removal. The raw diff and change excerpts contain the original removed values and are sensitive
local review material; never share or upload them." Redaction is rule-bounded, so an unrecognised
secret shape survives; any unresolved redaction failure blocks a "safe to share" claim. Credential
reference ids are identifiers, not automatically secrets, while credential names and literal
authorization values can be sensitive — this is why both are replaced and both are listed in
`changes`. The sanitized `workflow` copy and the `diff` are different objects with different
handling: the copy is the shareable artifact, while the diff and `originalExcerpt` values stay
local review material.

Neither contract is a command in the CLI surface: `sfscanner --schema v2 --help` lists no
preflight or prepare command. The package exports them as module contracts from the package root
and `./v2/*` subpaths, but no standalone CLI command or browser worker wiring exists. They are
versioned module contracts for the surfaces that will call them; documentation of the contract is
not a claim that the CLI exposes it.

## Preserved product formats

Existing products are kept while evidence is gathered, not removed because a research note
recommends it. Seven output surfaces stay first-class:

| Surface | Format | Producer | Status |
| --- | --- | --- | --- |
| Scanner result | `json` (default) | `--format json` | Supported |
| Scanner result | `ndjson` (`header`, `result`, `summary` records) | `--format ndjson` | Supported |
| Scanner and CI | SARIF 2.1.0 with CWE tags | `--format sarif`, [`sarif-v2/output.ts`](../../packages/scanner-core/src/report/sarif-v2/output.ts) | Supported |
| Scanner result | `table` (human-readable) | `--format table` | Supported |
| Public dataset bundle | NDJSON shards plus a manifest | [`pipeline/export/ndjson.ts`](../../pipeline/export/ndjson.ts) | Supported |
| Public dataset bundle | SQLite (published V4 bundle: schema version 3, FTS5 `workflow_search` table) | [`pipeline/export/sqlite.ts`](../../pipeline/export/sqlite.ts) | Supported |
| Public dataset bundle | Excel `.xlsx` — `README`, `Workflows`, `Findings`, `Integrations`, `Tags`, `Triggers`, `Provenance`, `Requirements`, `Release Metadata`, `Data Dictionary`, `Preflight Coverage`, `Preflight Evidence` sheets (12 in the published V4 bundle) | [`pipeline/export/excel.ts`](../../pipeline/export/excel.ts) | Supported |

No format is deprecated. Specifically:

- SARIF and the CI ingestion it enables, the JSON result, NDJSON streaming, the SQLite database and
  the Excel workbook all remain supported first-class surfaces. None is a fallback for another.
- A research recommendation does not rename a package, remove Excel, remove bounded semantics, or
  create a second canonical JSON authority. The shipped JSON result schema stays the single
  canonical JSON identity.
- Deprecating any format in future requires usage or cost evidence, an owner decision, migration or
  export access for affected users, and explicit documentation of the change. A proposed user count
  or conversion threshold is an experiment, not measured demand and not an acceptance gate.
- Excel is a lossy view and says so: a cell holds at most 32,767 characters, a clipped cell is
  counted with its field as `excelTruncatedCells` / `excelTruncatedFields` on the `Release Metadata`
  sheet, and the complete value is always in the NDJSON and SQLite artifacts of the same release.

The bundle's reopen checks read the generated SQLite database and workbook back and compare logical
values, relationships, missing/unknown states, identifier types and formula treatment against the
canonical projection; file existence and row counts alone are not treated as evidence.

## Bounded catalogue expansion policy

The catalogue grows only from entries whose provenance is established, and the quality claim grows
only from authentic evidence. Both rules are admission rules, not editorial preferences.

**Provenance is never inferred.** An entry enters the catalogue only when acquisition establishes
all four of: the source repository, the commit, the path within that repository, and an established
licence at acquisition (per-item evidence is required only for redistribution, so most entries are
link-only). If any of them cannot be established, the entry is dropped — never defaulted, never
guessed from a title, a URL shape or a model's description. This is [`AGENTS.md`](../../AGENTS.md)
rule 9 (provenance) together with rule 8 (model output is prose only), and they are the rules that
keep model output out of licences, authors, security verdicts, counts and links.

**Authentic quality admission cannot be bypassed.** No synthetic, generated or unverified dataset
stands in for authentic evidence when a quality threshold is claimed. Model-generated labels are not
ground truth; they may support development, never admission. The synthetic calibration corpus is
labelled as synthetic and dev/holdout-scoped precisely so it cannot be mistaken for the authentic
admission basis. Any expansion also keeps distribution trust separate from catalogue size: a
registry probe that establishes package metadata does not establish source or host equivalence, and
validation happens through consented, completed user tasks without uploading raw workflows and
without silent tracking.

## Verification

```powershell
npm run check:docs       # authoritative prose, referenced paths and corpus figures
npm run check:cli-docs   # docs/CLI.md and docs/scanner/cli-v2.md against the help/parser authority
npx vitest run packages/scanner-cli/src/v2/preflight-readiness.test.ts packages/scanner-cli/src/v2/privacy-prepare.test.ts
```

The module tests hold the contracts above: the report schema and its `NOT_PROVIDED` clearance, the
completeness/severity separation, the always-unknown prerequisite facts, the target statuses with
`migrationTested: false`, the single clean copy and diff, idempotent reruns, `__proto__` safety, and
the bounded, host-API-free module shape.
