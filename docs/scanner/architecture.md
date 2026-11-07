# Scanner architecture

> Status: current
> Last verified: 2026-09-04
> Owner: Scanner maintainer
> Source of truth: `packages/scanner-core/src/`, `packages/scanner-cli/src/`, `pipeline/cli/`, `app/src/scanner/`

This describes how a workflow JSON document becomes a finding list, and where the boundaries are
that make the scanner's safety claims ("no network, no code execution, deterministic") true by
construction rather than by convention.

Note on source layout: `packages/scanner-core` is the shared engine consumed by every caller
(browser, CLI, calibration pipeline). `app/src/scanner/` still holds an older, overlapping copy of
some of this logic mid-migration into `packages/scanner-core` — treat `packages/scanner-core` as
authoritative for engine behavior described here.

## The four-layer pipeline

A scan is four independently testable stages. Each stage's test file sits beside its source.

```
   workflow JSON (untrusted string)
          │
          ▼
┌──────────────────────────┐
│ 1. workflow.ts            │  parseWorkflowJson()
│    normalize + budget     │  → NormalizedWorkflow | typed error
└──────────────────────────┘
          │  ok
          ▼
┌──────────────────────────┐
│ 2. engine.ts               │  scanWorkflowCore()
│    run policies+analyzers │  → raw findings + diagnostics
└──────────────────────────┘
          │
          ▼
┌──────────────────────────┐
│ 3. canonical-findings.ts   │  canonicalizeFindings()
│    validate + dedupe +    │  → CanonicalScanFinding[]
│    redact (single exit)   │
└──────────────────────────┘
          │
          ▼
┌──────────────────────────┐
│ 4. presentation-redaction  │  redactScanPresentation()
│    adapter-facing result   │  → browser / CLI / SARIF output
└──────────────────────────┘
```

### 1. `workflow.ts` — normalize and enforce budgets before any policy runs

`parseWorkflowJson(json, options)` (`packages/scanner-core/src/workflow.ts`) turns an untrusted
JSON string into a `NormalizedWorkflow` — a flat node list, a deterministic graph, a byte size, a
node count, and a canonical SHA-256 `fingerprint` computed over key-sorted JSON
(`fingerprintJson`, `canonicalizeJson`). It enforces every input budget listed in
[limitations.md](limitations.md#budget-limits-and-analysis_limit_exceeded) — payload bytes, node
count, connection nesting depth, parameter depth/leaves, and edge count — and returns a typed
rejection **before any policy or analyzer sees the input**:

| Code | Meaning |
| --- | --- |
| `INVALID_JSON` | The string is not parseable JSON |
| `MALFORMED_WORKFLOW` | Missing `nodes`/`connections`, or a node missing `name`/`type` |
| `WORKFLOW_TOO_LARGE` | Exceeds the configured byte budget |
| `WORKFLOW_TOO_COMPLEX` | Exceeds node/edge/connection-depth/parameter budget, with a `cause` field (`NODE_LIMIT`, `EDGE_LIMIT`, `CONNECTION_DEPTH_LIMIT`, `PARAMETER_COMPLEXITY_LIMIT`) so callers can switch on the exact rejection instead of parsing the message string |

Non-fatal problems (a non-object `parameters` value, a duplicate JSON key) do not reject the scan —
they become `parseDiagnostics` entries carried into the result, which is how a later stage can mark
the analysis `INDETERMINATE` without refusing to scan at all. The graph itself
(`workflow-graph.ts`) classifies every connection edge into one of four typed views —
`execution` (`main`), `capability` (`ai_tool`), `context` (the `ai_document`/`ai_memory`/... family),
and `unknown` — which is what lets the taint and AI-capability analyzers reason about *which*
edges carry data versus which merely attach a tool or a model.

### 2. `engine.ts` — run the resolved profile's policies and analyzers

`scanWorkflowCore(workflow, options)` (`packages/scanner-core/src/engine/engine.ts`) takes the
normalized workflow plus a resolved profile's `policies` and optional `analyzers`, runs every
policy, catches per-policy exceptions (`policyFailureCount`, which drives `INDETERMINATE` — see
below) rather than letting one bad policy abort the scan, runs every analyzer, and hands the
combined raw findings to the canonicalization boundary. It also computes `analysisStatus` from the
collected diagnostics and a severity-bucketed `ScanSummary`.

### 3. `canonicalizeFindings` — the single redaction exit boundary

`packages/scanner-core/src/result/canonical-findings.ts` is the **only** place a finding is allowed
to leave the engine. Every policy and analyzer finding — whatever produced it — passes through
here before it can reach a caller. It:

- **structurally validates** each finding (`isScanFinding`) and drops anything malformed, counting
  it in `rejectedCount` rather than throwing;
- **rejects cyclic evidence** (`hasCycle`) so a pathological policy cannot produce an
  unserializable result;
- **deduplicates** deterministically identical findings via a stable-sorted merge key
  (`stableSerialize`), counting collapses in `collapsedCount` — except for findings on an
  "ambiguous" node ID (e.g. a duplicate node name), which are never merged, because merging two
  findings that only *look* identical because their location collided would hide real evidence;
- **redacts** every finding (`redactFinding`, from `redaction/redaction.ts`) — title, location,
  evidence, message, explanation, `whyItMatters`, `possibleImpact`, remediation, and each
  remediation step all pass through the same redaction path; and
- **stamps the policy effect** (`LEGACY_SCORE` or `REPORT_ONLY`) from the rule catalog, so the
  effect that governs scoring is attached at the boundary, not trusted from whatever the policy
  itself claimed.

New policy metadata or location fields must go through this boundary. Adding a second output path
that returns findings without passing through `canonicalizeFindings` would bypass redaction —
that is the one hard rule this module exists to enforce.

### 4. Presentation and adapters

`redactScanPresentation` (`packages/scanner-core/src/presentation-redaction.ts`) wraps the whole
result document — not just individual findings — for whichever adapter is asking:

- **Browser** — `app/src/scanner/scan.worker.ts` runs the pipeline inside a Web Worker. The worker
  has no `fetch`, `XMLHttpRequest`, `WebSocket`, or other network primitive anywhere in its module
  graph; scanning a pasted workflow makes no network request. The worker accepts a `profile` field
  (`'beta-default' | 'beta-hardened'`) per request.
- **CLI** — `packages/scanner-cli/src/scan.ts` and `pipeline/cli/scan-core.ts` run the same
  `scanWorkflowCore` call in Node, with `CLI_PROFILE` hardcoded to `'beta-default'` — the shipped
  CLI does not currently expose `beta-hardened` as an option.
  `pipeline/cli/n8n-scan.ts` is the executable entry point — run it through the root
  `npm run scan:cli` shortcut, and note that `version`, `rules` and `explain` dispatch to the v2
  grammar. `docs/CLI.md` documents its commands, options, and exit codes and is parity-checked
  against `pipeline/cli/cli-contract.ts` by `npm run check:cli-docs`.
- **Calibration pipeline** — `pipeline/calibration/calibration-runner.ts` calls the same
  transport-free seam as the CLI (`scan-core.ts`) to score the synthetic corpus described in
  [calibration.md](calibration.md).

All three adapters call into the same `packages/scanner-core` engine; none of them re-implements
policy logic or redaction.

## Parser adapters — none execute submitted code

| Language | Parser | Version pinned | What it looks for |
| --- | --- | --- | --- |
| Workflow JSON | Momoa | — | Location-aware parsing so findings can carry exact source spans |
| JavaScript (Code/Function nodes) | Acorn | `8.17.0` | AST walk for `eval`/`Function`, `child_process`/`fs`/network module access, `process.env`/`$env`/`$secrets`/`$credentials` member access |
| Python (Code nodes) | `@lezer/python` | `1.1.19` | CST walk for `eval`/`exec`/dynamic import, `subprocess`/`os` process primitives |

All three parse into a syntax tree and read it. None of them evaluates, `eval`s, imports, spawns a
process for, or otherwise runs the submitted source. This is a structural claim, not a policy: the
scanner's dependency graph for `packages/scanner-core` has zero references to `child_process`,
`vm`, `eval`, or `new Function` outside the JavaScript analyzer's own *detection* of those
identifiers as text/AST nodes (verified by grep in the production-readiness audit,
`docs/audit/2026-09-04/02-SCANNER-CLI.md`).

## Policy profiles

`packages/scanner-core/src/policies/profile.ts` resolves a `PolicyProfileId` to a
`PolicyProfileEntry` carrying the policy set, rule catalog, and which analyzers are included:

| Profile | Policies | `includesSourceSpans` | `includesJavaScriptAnalysis` | `includesPythonAnalysis` | `includesTaintAnalysis` |
| --- | ---: | --- | --- | --- | --- |
| `beta-default` | 7, all `LEGACY_SCORE` | false | false | false | false |
| `beta-hardened` | 17 (the 7 plus 10 `REPORT_ONLY`) | true | true | true | true |

`beta-hardened`'s ten additional policies are every one `REPORT_ONLY` in
`packages/scanner-core/src/policy/rule-catalog.ts` (`betaHardenedRuleCatalog`): they are displayed
for review and **never enter the legacy risk score or grade** — the threat model documents the
scoring formula and this boundary in full. There is currently no server-side gate on requesting
`beta-hardened`: the site is a static export with no server route, so profile selection is a
client-side/CLI-side parameter, not an authorization decision made by a backend. The shipped CLI
simply does not offer `beta-hardened` as a choice (`CLI_PROFILE` is a compile-time constant); the
browser worker will run either profile if asked, entirely locally.

Changing `beta-default`'s output (policy ID, severity, summary shape, or completeness state) is a
shipped user-visible behavior change — `app/src/scanner/__fixtures__/beta-default-compatibility.ts`
pins it and fails if it drifts.

## Analysis honesty: `COMPLETE` / `DEGRADED` / `INDETERMINATE`

`classifyAnalysisStatus` (`packages/scanner-core/src/result/analysis-completeness.ts`) turns the
collected diagnostics into one of three statuses:

- **`COMPLETE`** — no diagnostics were emitted. This still means only "no catalogued evidence
  found," not "every possible check succeeded on every byte."
- **`DEGRADED`** — a non-required portion of the analysis may have omitted evidence (a source cap
  was hit, a parse failed, a graph connection was unclassified). The findings that *were* produced
  are still returned.
- **`INDETERMINATE`** — a required stage may have hidden scored risk (`MALFORMED_NODE_PARAMETERS`,
  `POLICY_EXECUTION_FAILED`). An indeterminate result carries no risk assessment or human summary,
  so a failed required stage cannot present as an ordinary reassuring grade.

Every diagnostic code is classified exactly once in `ANALYSIS_DIAGNOSTIC_COMPLETENESS`; there is no
silent default. See [limitations.md](limitations.md) for the full code table and
[threat-model.md](threat-model.md) for what each diagnostic implies for a reviewer.

## Where determinism comes from

`packages/scanner-core` has zero occurrences of `Math.random`, `Date.now`, `new Date()`, or
locale-dependent string ordering (`toLocale*`, `localeCompare`) outside test files — verified by
grep in the production-readiness audit and re-checked while writing this document. Findings are
deduplicated and ordered by a stable structural sort (`stableSerialize` in `canonical-findings.ts`,
`stable-order.ts`), not by insertion order or timestamp, so the same input always produces
byte-identical output regardless of when or how many times it is scanned.
