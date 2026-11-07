# Scanner documentation

**Latest Candidate8 status-only verification — October29:** [report](../audit/2026-10-29-candidate8-verification/REPORT.md), [source findings](../audit/2026-10-29-candidate8-verification/SOURCE-REVIEW.md), [candidate/requirements](../audit/2026-10-29-candidate8-verification/CANDIDATE-REQUIREMENTS.md), and [public delivery](../audit/2026-10-29-candidate8-verification/DELIVERY-REVIEW.md). Candidate8is locally staged; CLI readiness is integrated. Original product/quality acceptance and public delivery remain open. Earlier review banners below are historical. No new plan or prompt.

**Current review — 2026-10-29:** start with [programme status](programme-status.md), [review](../audit/2026-10-29-completion-review/REPORT.md), [plan](../superpowers/plans/2026-10-29-product-integration-and-delivery.md), [prompt](../audit/2026-10-29-completion-review/IMPLEMENTATION-START-PROMPT.md) and [master](../audit/2026-10-24-master-remediation/MASTER-REPORT.md). Candidate6 is staged locally; dependency audit is clean. Module logic/integration, exact staged-byte reopen, original quality admission and public delivery remain open.

**Current programme status — 2026-10-24:** start with [implementation/verification status](programme-status.md), [master audit](../audit/2026-10-24-master-remediation/MASTER-REPORT.md) and [final remediation plan](../superpowers/plans/2026-10-24-scanner-final-remediation.md). Fresh source/component checks do not update release artifacts or admit v2 hardened. The original five chunks and48 leaves remain the programme identity; no current aggregate percentage has been accepted. Existing v1/v2 reference boundaries below remain applicable.

> Status: current documentation index; v1 remains the native compatibility surface and v2 is explicitly versioned.
> Last verified: 2026-10-28
> Owner: Scanner maintainer
> Source of truth: [`packages/scanner-core/src/v2/scan-workflow.ts`](../../packages/scanner-core/src/v2/scan-workflow.ts), [`packages/scanner-core/src/v2/admitted-registry.ts`](../../packages/scanner-core/src/v2/admitted-registry.ts), and [`contracts/`](../../contracts/)

The scanner reads an n8n workflow JSON document and reports deterministic, policy-driven findings
against it — locally, offline, and without ever running the workflow's own code. It is the
project's core product. This page indexes what it does, how the documents in this folder fit
together, and what makes it different from pasting a workflow into a general-purpose model.

## Version boundary

The repository contains two intentionally distinct scanner surfaces:

- **Native v1** keeps its grandfathered `scanner-beta-1` engine identity, `scanner-result-v1`
  result schema, `scanner-limits-v1` limits, and existing `beta-default`/`beta-hardened`
  behavior. The existing v1 pages in this index remain historical/current product documentation;
  they are not silently rewritten to describe v2.
- **Explicit v2** is the bytes-first [`scanWorkflowV2`](../../packages/scanner-core/src/v2/scan-workflow.ts)
  surface. The admitted authority is `secureflow-scanner@2.0.0` with
  `beta-default@2.0.0`, `scanner-result-v2`, and `scanner-limits-v2`. The defined
  `beta-hardened@2.0.0` manifest is not admitted or selectable by v2 merely because its source
  files exist. Native v1 hardened analysis remains available through its existing adapter.

The v2 pages below describe the admitted core, its closed contracts, normalization and semantic
boundaries, and the explicit v1 projection. They do not promote v2 to a public entry identity,
rights decision, deployment, or release approval; see
[migration-v1-v2.md](migration-v1-v2.md) for those boundaries.

## What makes this distinctive

- **Deterministic.** Every finding comes from a hand-written policy or a bounded static analyzer —
  never from a model. Findings are stable-sorted and deduplicated, so the same input always
  produces byte-identical output. See [architecture.md](architecture.md#where-determinism-comes-from).
- **Offline, no code execution.** JSON, JavaScript, and Python are all *parsed*, never run. The
  browser scanner has no network primitive in its Web Worker — a pasted workflow never leaves the
  browser. See [architecture.md](architecture.md#parser-adapters--none-execute-submitted-code).
- **It tells you when it could not finish looking.** Most static scanners return "no findings" for
  a file they failed to fully analyze, indistinguishable from a genuinely clean result. This one
  reports an explicit `COMPLETE` / `DEGRADED` / `INDETERMINATE` status alongside every scan, so a
  parse failure or a hit-budget cap is never presented as a clean bill of health. See
  [architecture.md](architecture.md#analysis-honesty-complete--degraded--indeterminate).
- **It publishes its own blind spots.** See [limitations.md](limitations.md) for what the scanner
  cannot see, including one open question (`$env` leakage) resolved by reading the code rather
  than left as a guess.

## The four rule families

Seventeen policy IDs across two profiles — seven shipped by default, ten more under a
report-only "hardened" profile. Full detail, examples, and proposed CWE/OWASP mappings are in the
[rule reference](rule-reference.md) and [policy inventory](policy-inventory.md); this is the map:

| Family | Policies | What it looks for |
| --- | --- | --- |
| **Direct policies** | `N8N_EXECUTE_COMMAND`, `N8N_CODE_NODE`, `RAW_AUTH_HEADER`, `RAW_SECRET_INDICATOR`, `UNAPPROVED_DOMAIN`, `UNKNOWN_NODE_PACKAGE`, `WEBHOOK_EXPOSURE` | Node-local patterns: capability nodes, raw secrets, unauthenticated triggers, unapproved egress, unofficial packages. Shipped in `beta-default`. |
| **Embedded-code analysis** | `JAVASCRIPT_DYNAMIC_EXECUTION`, `PYTHON_DYNAMIC_EXECUTION` | Bounded AST/CST inspection of Code-node source (Acorn for JavaScript, `@lezer/python` for Python) for dynamic-execution and capability-access primitives, without running the code. |
| **Taint-flow analysis** | `TAINTED_COMMAND`, `TAINTED_SQL_QUERY`, `TAINTED_REQUEST_URL`, `TAINTED_FILE_PATH`, `TAINTED_CODE_INPUT`, `TAINTED_REQUEST_HEADER`, `TAINTED_AI_PROMPT` | Inter-node dataflow: whether data that entered the workflow from a webhook, inbound message, or external response reaches a dangerous sink (a shell command, a SQL query, a file path, an AI prompt) through the graph's `main` execution edges. |
| **Agentic AI** | `AI_AGENT_UNGATED_TOOL` | Whether an AI agent that receives untrusted (tainted) input and holds at least one connected tool has a catalogued human-approval gate on every path into it. |

The embedded-code, taint-flow, and agentic-AI families are all `beta-hardened`-only and
`REPORT_ONLY` — they never move the risk score. See
[architecture.md](architecture.md#policy-profiles) for why, and
[threat-model.md](threat-model.md#completeness-effects-and-scoring) for the scoring formula they
are deliberately excluded from.

## Every document in this folder

| Document | What it covers |
| --- | --- |
| [architecture-v2.md](architecture-v2.md) | The admitted v2 core boundaries: parser/admission, normalization, capability scheduling, analysis, canonical result, redaction, presentation adapters, and retained v1 compatibility. |
| [contracts-v2.md](contracts-v2.md) | The closed v2 request/result, source/evidence, capability, diagnostic, limits, identity, scoring, and v1 projection contracts. |
| [normalization-v2.md](normalization-v2.md) | Bytes-first parsing, BOM and offsets, source-preserving identity, deterministic ordering, bounded work, duplicate-key security semantics, and explicit unknown outcomes. |
| [semantic-catalogue.md](semantic-catalogue.md) | Versioned node semantics, deterministic resolver precedence, target-context separation, destination inventory, and separate advisory applicability. |
| [migration-v1-v2.md](migration-v1-v2.md) | Native `scanner-beta-1` preservation, explicit v2 selection, safe v2-to-v1 projection, compatibility breaks, rollback, and owner-gated public identity changes. |
| [architecture.md](architecture.md) | The shipped v1 pipeline (normalize → policies/analyzers → canonical redaction → presentation), its parser adapters, and its compatibility-source note. |
| [rule-reference.md](rule-reference.md) | Machine-generated, parity-checked against the runtime rule catalog and limits contract — policy IDs, effects, default severities/confidence, the diagnostic vocabulary, and the shared v1 limits table. Do not edit by hand. |
| [policy-inventory.md](policy-inventory.md) | The full, hand-maintained v1 detail behind every rule: threat and evidence, remediation, completeness caveats, minimal triggering JSON examples, and proposed CWE/OWASP mappings. |
| [limitations.md](limitations.md) | What the v1 scanner does not detect, why some of those are structural rather than temporary, its budget limits, and the resolved `$env`-leakage question. |
| [threat-model.md](threat-model.md) | The v1 assets, trust boundaries, attacker/mistake cases, incident record, and scoring/diagnostics contract. |
| [cli-v2.md](cli-v2.md) | The v2 CLI: commands, options, result formats, limits named by help, and the exit contract. |
| [preflight-handover.md](preflight-handover.md) | Offline preflight and handover: prerequisite checklist, target-version checks, opt-in privacy preparation, preserved output formats, and the bounded catalogue expansion policy. |
| [rule-authoring-v2.md](rule-authoring-v2.md) | The closed v2 rule language, admitted safe-fact vocabulary, and the pack review path. |
| [key-rotation.md](key-rotation.md) | The authorised-but-unbuilt Ed25519 trust store, key rotation, and revocation procedure. |
| [deprecation.md](deprecation.md) | Versioning, rule/diagnostic identity invariants, and the deprecation procedure. |
| [security-and-disclosure.md](security-and-disclosure.md) | Safe report handling, the private reporting route, and severity/response boundaries. |
| [calibration.md](calibration.md) | The v1 synthetic calibration corpus, dev/holdout split, precision/recall method, and synthetic-versus-real evidence caveat. |
| [calibration-v2.md](calibration-v2.md) | The development-only v2 calibration harness, case contract, and split rules. |
| [calibration-v2-results.md](calibration-v2-results.md) | Its dated results record: zero settled cases and 30 unresolved, `HUMAN_REQUIRED`. |
| [release-runbook.md](release-runbook.md) | The staged release and rollback procedure — prepared-only, with no release or deployment authorization. |
| [release-v2-readiness-report.md](release-v2-readiness-report.md) | The dated 2026-09-09 readiness record for the superseded `codex/release-v2` candidate, carrying a dated correction banner. |
| [`../scanner-false-positive-review.md`](../scanner-false-positive-review.md) | The historical v1 false-positive review against an earlier n8n-templates-derived corpus. Kept separate from `calibration.md`'s newer synthetic corpus. |

## Where the code lives

[`packages/scanner-core/src/v2/`](../../packages/scanner-core/src/v2/) is the explicit v2
entrypoint and authority assembly. The v2 CLI in
[`packages/scanner-cli/src/v2/`](../../packages/scanner-cli/src/v2/) calls that direct package
surface. The browser scanner selects v2 by default through
[`runScanV2`](../../app/src/scanner/run-scan.ts), which drives the `scan-v2` message in
[`app/src/scanner/scan.worker.ts`](../../app/src/scanner/scan.worker.ts); the worker's native
`scan` message and the pipeline's native-v1 path remain compatibility adapters while convergence
evidence is pending. [`pipeline/calibration/`](../../pipeline/calibration/) contains separate v1 and v2
calibration harnesses; each document states which one it describes. See
[architecture-v2.md](architecture-v2.md) and [migration-v1-v2.md](migration-v1-v2.md).

```powershell
npm run scan:cli -- --help                   # CLI entry point; see docs/CLI.md
npx vitest run packages/scanner-core/src     # scanner-core test suite
npm run check:scanner-docs                   # rule-reference.md ↔ rule-catalog.ts parity
npm run check:scanner-calibration            # calibration corpus gate
```

## The no-model-findings boundary

Findings, severities, and risk grades are produced only by deterministic code. Rights decisions and
licence classifications come from acquisition and rights records, not model inference. Model output
never becomes a finding, severity, grade, or rights decision. The reasoning, and what changing it
would cost, is recorded in [`ADR: Scanner findings are deterministic, never model output`](../decisions/ADR-deterministic-scanner-findings.md).
