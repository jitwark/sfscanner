# Scanner limitations

> Status: current native-v1 limitations; explicit v2 boundary documented
> Last verified: 2026-10-19
> Owner: Scanner maintainer
> Source of truth: [`packages/scanner-core/src/v2/scan-workflow.ts`](../../packages/scanner-core/src/v2/scan-workflow.ts), [`packages/scanner-core/src/facts/safe-fact-registry.ts`](../../packages/scanner-core/src/facts/safe-fact-registry.ts), [`contracts/scanner-limits-v2.ts`](../../contracts/scanner-limits-v2.ts), and the native-v1 sources and audit listed below

A security tool that publishes its blind spots earns more trust than one that does not. This page
lists what the scanner does **not** detect, so a clean or low-severity result is read correctly:
"no catalogued evidence found in the portion we could analyze," never "this workflow is safe."

For what the scanner *does* detect, see the [rule reference](rule-reference.md) and
[policy inventory](policy-inventory.md). For how a result can be `DEGRADED` or `INDETERMINATE`
rather than clean, see [architecture.md](architecture.md#analysis-honesty-complete--degraded--indeterminate).

## Explicit v2 boundary and deferred authority

The detailed limits below retain their native-v1 meaning and history. The explicit v2 path is
separately versioned: only `secureflow-scanner@2.0.0` with `beta-default@2.0.0` and built-in
authority is admitted. `beta-hardened@2.0.0` is defined but not admitted; custom/remote declarative
packs, Ed25519 signature verification, and live key rotation are not v2 features. Native v1
behavior and its `scanner-beta-1` identity remain available for compatibility and rollback.

V2 adds bounded document, member/element, duplicate-key, source-span, expression, graph, taint,
redaction, evidence, serialized-result, and rule-operation budgets under
[`scanner-limits-v2.ts`](../../contracts/scanner-limits-v2.ts). These bounds make omissions visible;
they do not expand coverage or turn a partial scan into a clean result. Missing facts remain
`UNKNOWN`; required/scoring loss is `INDETERMINATE` with no assessment. A node type the semantic
catalogue does not model is not treated as clean either: it is covered by the conservative generic
fallback ([ADR](../decisions/ADR-generic-node-semantic-fallback.md)) — main-in → main-out passthrough,
`READ_EXTERNAL`/`WRITE_EXTERNAL`, no claim about destinations or parameters — and every such node
carries **two** degraded coverage diagnostics: `SEMANTIC_CATALOGUE_MISS` (the node type has no
admitted catalogue record) and `GENERIC_NODE_UNMODELED_CAPABILITY` (the verdict rests on
unmodelled-capability defaults; destinations are unknown, not audited-and-empty). A grade that
includes fallback nodes therefore rests on a labelled assumption rather than on modelled behaviour.
The fallback runs the seven policies scored by the admitted `beta-default@2.0.0` profile; the ten
advisory analyzers in `beta-hardened@2.0.0` are defined but not admitted and do not run. A genuinely
unresolved node keeps only `SEMANTIC_CATALOGUE_MISS` at the caller's requiredness: a required miss is
`INDETERMINATE` with no assessment, an optional miss is `DEGRADED`/eligible and does not null the
assessment by itself. An unreadable node `type` still refuses the scan.
V2 does not claim host vulnerability/version detection, credential-store inspection, workflow execution,
or runtime service behavior.

### Q01 local source correctness checkpoints

The current development source canonicalizes admitted decimal string node versions such as `"2"`
and `"2.0"` to `"2.0.0"`, preserving existing numeric normalization and unsupported string evidence.
The internal Python security capability now binds each comma-separated module import independently,
including aliases and the distinction between unaliased and aliased dotted imports. Existing
from-import, reassignment and lexical-shadowing behavior remains covered by focused regressions.
The internal JavaScript capability tracks static named imports and simple destructured members
of an unshadowed direct builtin `require`. Computed, nested, rest and default patterns do not
establish module provenance; their bound locals shadow outer bindings. Destructuring assignment
clears earlier provenance. Exhausted binding-pattern analysis reports its limit and emits no
partial source facts. These are bounded static indicators, not proof of runtime execution.
The binding model does not establish dynamic reachability or track runtime closure/alias mutation.
Code capabilities remain outside the admitted `beta-default` profile; these fixes do not activate
hardened analysis or rescan the catalogue. Local source tests do not establish that deployed or
npm-distributed bytes already contain these changes.

### v2 budget states: enforced, dormant, and unwired

`ADMITTED_LIMIT_STATES` in [`scanner-limits-v2.ts`](../../contracts/scanner-limits-v2.ts) is the
single classification of every `ScannerLimitsV2` numeric field, and no help surface restates it:

| State | Fields | Meaning |
| --- | --- | --- |
| `WIRED` (19) | `maxBytes`, `maxNodes`, `maxEdges`, `maxConnectionDepth`, `maxParameterDepth`, `maxParameterLeaves`, `workerDeadlineMs`, `maxSyntaxNodes`, `maxDocumentDepth`, `maxMembersAndElements`, `maxRawEdges`, `maxDuplicateKeys`, `maxDiagnostics`, `maxStoredSourceSpans`, `maxSourceWork`, `maxFindings`, `maxEvidenceBytes`, `maxSerializedResultBytes`, `maxRuleOperations` | Read by the admitted `beta-default@2.0.0` path. `workerDeadlineMs` is here because the CLI worker host enforces it. |
| `DORMANT` (5) | `maxExpressionTokens`, `maxCodeSyntaxNodes`, `maxGraphOperations`, `maxTaintStates`, `maxTraceStepsPerFinding` | Read only by the code, value-flow, taint, and graph analyzers of `beta-hardened@2.0.0`, which is defined but not admitted. |
| `UNWIRED` (2) | `maxRedactionPatches`, `maxRedactedArtifactBytes` | No shipped path reads them; they bound the development-only redaction-v2 work. |

Result `limits.usage` contains rows only for measured budgets: `maxBytes`, `maxNodes`, `maxEdges`,
`maxConnectionDepth`, `maxParameterDepth`, `maxParameterLeaves`, `maxSyntaxNodes`, `maxRawEdges`,
`maxDuplicateKeys`, `maxDiagnostics`, `maxStoredSourceSpans`, `maxSourceWork`, and `maxFindings`
(`MEASURED_LIMIT_IDS`). Enforced budgets with no per-scan counter are enforced at their own stage —
`maxDocumentDepth` and `maxMembersAndElements` by the source parser, `workerDeadlineMs` by the
worker host, `maxEvidenceBytes` and `maxRuleOperations` by candidate validation, and
`maxSerializedResultBytes` after composition — and therefore emit no row rather than a fabricated
`examined: 0`. Dormant and unwired budgets emit no row at all. The limits document and its digest
still cover all 26 fields.

`maxConnectionDepth` bounds nested connection *objects*, not a linear chain: a 5,000-node chain is
admitted. It is not a graph-path or hop limit, so a long workflow does not violate it.

### 5,000-node admission and the stored-span boundary

The node admission ceiling is `maxNodes = 5000`; the stored-span budget is
`maxStoredSourceSpans = 25000`. For the minimal fixture used by
`packages/scanner-core/src/v2/capacity-audit.test.ts` (four members per node, one connection record
per non-tail node), the engine's own result classifies:

| Nodes | Result | Stored spans | Classification |
| ---: | --- | --- | --- |
| 2,083 | `COMPLETE` | 24,992 examined, 0 omitted | last complete count |
| 2,084 | `DEGRADED` | 25,004 examined, 4 omitted | `OPTIONAL_LIMIT_EXCEEDED`; presentation-only |
| 5,000 | admitted (`DEGRADED`) | 59,996 examined, 34,996 omitted | node ceiling not reached |
| 5,001 | rejected | n/a | `WORKFLOW_TOO_COMPLEX` / `NODE_LIMIT` |

`spanLossIsSecurityRequired(BETA_DEFAULT_PROFILE_MANIFEST)` is `false`, so the stored-span loss at
and below 5,000 nodes is presentation-only and the assessment is retained. No budget was increased:
the classification above is the current engine's, not a new limit. The boundary is a property of
the document shape — a five-member node charges 13 spans rather than 12 and moves the complete
boundary to 1,923 nodes.

Fresh-process timing and throughput are **UNRUN** in this remediation wave: the evidence command
`node scripts/measure-workflow-capacity.mjs > docs/audits/2026-10-19-production-readiness/evidence/capacity-audit.jsonl`
is scheduled once in the final verification wave. No elapsed-time or capacity figure here is a
measurement of that command.

## The several meanings of “24”

There is no 24-node workflow cap. The number appears in five unrelated places, and none of them
bounds the size of a workflow the scanner admits:

| Meaning | Value | Source |
| --- | ---: | --- |
| Distinct node types in the built-in semantic catalogue | 31 types across 32 records | `packages/scanner-core/src/semantics/builtin-catalogue.ts` |
| Flowchart preview nodes drawn per workflow | 24 | `app/src/ui/detail/node-flowchart-fallback.ts` |
| Hub page size | 24 | `HUB_PAGE_SIZE` |
| Static hubs per kind | 24 | `MAX_STATIC_HUBS_PER_KIND` |
| JSON-LD entries projected per page | 24 | `app/src/seo/json-ld.ts` |

The first row is the current catalogue (`31` distinct types across `32` records; the existing
`httpRequest` pair is the one duplicate record). Before the D-01 catalogue expansion it read 24
distinct types across 25 records — that is history, not the current catalogue, and neither number
is a workflow limit.

The scanner admission limit is 5,000 nodes. An unmodelled node receives the conservative fallback
and both degraded coverage codes (`SEMANTIC_CATALOGUE_MISS` and
`GENERIC_NODE_UNMODELED_CAPABILITY`); it is never rejected merely for being outside the catalogued
families. The fallback runs the seven policies scored by the admitted `beta-default@2.0.0` profile;
the ten advisory analyzers in `beta-hardened@2.0.0` are defined but not admitted and do not run.

## Structural limits, not maturity gaps

These are not "not implemented yet." They follow directly from the product's own safety
commitment — single-workflow, static, offline, no code execution — so removing them would mean
giving up a property the scanner exists to guarantee.

### Instance-wide credential over-scoping

The scanner reads one workflow JSON document at a time. It has no visibility into an n8n
instance's credential store, which credentials exist, which workflows share them, or whether a
credential referenced by this workflow is scoped far more broadly than this workflow needs. A
named 2026 third-party assessment finding (over-scoped shared credentials) is exactly this shape,
and no single-workflow scanner can see it. `RAW_SECRET_INDICATOR` and `RAW_AUTH_HEADER` only catch
secret material embedded directly in the JSON, not the separate question of what a managed
credential reference is allowed to touch.

### Known-vulnerable n8n version detection

Fixtures are pinned to a specific n8n source commit (see [policy-inventory.md](policy-inventory.md#primary-sources-and-version-caveats)),
and the manifest records a `compatibilityTarget`, but no rule reads or warns about the *n8n
instance version* a workflow was authored for or will run on. The scanner cannot see which CVEs
apply to a deployment — including the six CVEs disclosed in one day and `CVE-2026-33663`
documented in [the threat model](threat-model.md#why-this-matters-now--the-2026-n8n-incident-record) — because
a workflow JSON document does not carry n8n's own version number.

### Community-node reputation and known-malicious lists

`UNKNOWN_NODE_PACKAGE` flags any node type outside the `n8n-nodes-base.` and `@n8n/` namespaces —
once per package prefix, per workflow (`packages/scanner-core/src/policies/package-and-webhook-policies.ts`).
That is a namespace check, not a reputation check. It cannot tell a well-maintained community node
from an abandoned or malicious one; it does not check npm publish history, download counts, known
CVEs, or any block/allow list, because the scanner has no network access to consult one and no
local list is maintained today.

### Runtime behavior

No analyzer executes JavaScript, Python, n8n expressions, shell commands, SQL, or a workflow node.
Every finding is a static-shape claim about the submitted JSON — evidence that a pattern exists,
never proof that a branch runs, that an exploit succeeds, or that a value is empty at runtime.
Obfuscation, dynamic property names, computed `require`/`import` targets, and code assembled at
runtime from data the scanner cannot see are all outside reach by construction.

## `$env` and secret-variable leakage — resolving the open question

An earlier audit pass marked this `UNVERIFIED`. Reading the code resolves it, with caveats:

**What is detected.** `packages/scanner-core/src/analyzers/code/javascript-analysis.ts` treats
`$env`, `$secrets`, and `$credentials` as tracked roots (`secretRoots`), and separately recognizes
`process.env`, `import.meta.env`, and `globalThis.process.env` (`isEnvironmentPath`). A Code or
Function node's **JavaScript** source that reads `process.env.TOKEN` or `$env.SOME_TOKEN` is defined
to produce a `JAVASCRIPT_DYNAMIC_EXECUTION` finding with indicator `ENVIRONMENT_ACCESS` or
`SECRET_ACCESS` respectively — confirmed directly by a test case in `javascript-analysis.test.ts`
that asserts `process.env.TOKEN;` yields exactly that indicator. The analyzer is defined for
`beta-hardened`, which is not admitted, so no shipped scan produces the finding.

**What is not detected, and why this is only a partial answer:**

- **Parsing is all-or-nothing per code node.** JavaScript is parsed by Acorn, which returns a
  complete AST or throws; a syntax-invalid node yields `JAVASCRIPT_PARSE_FAILED` with no findings
  from that node, and the required-stage mapping makes the core result `INDETERMINATE` rather than
  clean or merely degraded. The scanner does not fabricate findings from a partial JavaScript AST.
  Python uses a lossless CST traversal, so findings parsed before a later syntax error are retained
  and `PYTHON_PARSE_FAILED` is emitted alongside them; the resulting required-stage failure is still
  `INDETERMINATE`.
- **Python code is not covered.** `python-analysis.ts` only recognizes `eval`/`exec`/dynamic
  import and `subprocess`/`os` process primitives (`SUBPROCESS_METHODS`, `isOsProcessMember`).
  There is no equivalent of `secretRoots` or `isEnvironmentPath` in the Python analyzer, so
  `os.environ.get('TOKEN')` in a Python Code node is invisible to the scanner today.
- **n8n's own expression syntax is not covered.** A parameter value like
  `={{ $env.TOKEN }}` written directly into an ordinary node field (an HTTP Request header, a Set
  node value, anything outside a Code node's source) is never parsed by Acorn — it is a string,
  and the taint-expression parser (`taint-expressions.ts`) has no `$env`/`$secrets`/`$credentials`
  root in its own reference resolution (`taint-expression-references.ts`). So the far more common
  path — pasting `{{ $env.API_KEY }}` straight into a parameter — is not flagged by any rule.
- **This signal belongs to the `beta-hardened` profile, which is defined but not admitted or
  selectable.** The shipped `beta-default` path runs no JavaScript analysis and no shipped scan sees
  it. If the hardened profile is admitted later, the finding remains `REPORT_ONLY` and does not
  affect the risk score or grade.

Net: the analyzer that detects direct `process.env`/`$env`/`$secrets`/`$credentials` **member access
written as JavaScript inside a Code node** is defined but not admitted, so no shipped profile reports
it. It does not detect the same leakage pattern in Python or in n8n's own expression language.

## Expression literals in `RAW_AUTH_HEADER` and `RAW_SECRET_INDICATOR`

`RAW_AUTH_HEADER` and `RAW_SECRET_INDICATOR` treat the literal text a workflow ships verbatim as
material, not the runtime values an expression produces. A lone RFC 7235 scheme token (`Bearer `,
`Basic `, `Digest `, `HOBA `, `Mutual `, `Negotiate `, `Token `) beside a managed
`{{ $credentials.… }}` reference is public protocol text and produces only the INFO header signal;
any other literal text beside the expression keeps the raw/HIGH result (`=Bearer abc123`).

A complete provider token inside a single- or double-quoted string value of an expression
(`={{"sk_live_…"}}`) is literal text in the JSON and is reported as a raw secret; a quoted property
name (`$json["sk_live_…"]`) is not a value and is ignored. The scan is bounded and never evaluates
the expression. It does not decode escape sequences — the raw two-character escape is kept, so an
escaped fragment cannot be spliced into a token — and it does not join fragments. Unquoted
template-literal text is not scanned (a quoted string inside a template expression is expression
text and is scanned), so `\x73k_live_…`, provider text written as bare template text such as
`` `sk_live_…` ``, and concatenated token halves remain outside detection.

## Data exfiltration destination policy

`TAINTED_REQUEST_URL` reports when untrusted input reaches an HTTP Request URL, and
`UNAPPROVED_DOMAIN` reports when a URL's hostname is outside an operator-supplied allowlist — but
the allowlist is opt-in and empty by default (`UNAPPROVED_DOMAIN` returns no findings at all when
no list is supplied). Neither rule evaluates *what* data reaches a given destination, whether that
destination is a known exfiltration channel, or whether an AI agent's HTTP tool is unrestricted by
design. The audit's proposed `AGENT_EGRESS_UNRESTRICTED` rule (an AI agent with an HTTP tool and no
domain allowlist) does not exist yet.

## Budget limits and `ANALYSIS_LIMIT_EXCEEDED`

Every analyzer is bounded so that no input can make a scan run indefinitely. Hitting a bound
degrades the result rather than silently truncating it — the scan reports `ANALYSIS_LIMIT_EXCEEDED`
and the analysis status moves to `DEGRADED`. These are the current defaults:

| Bound | Value | Source |
| --- | ---: | --- |
| Workflow payload | 1,536,000 bytes | `DEFAULT_SCANNER_LIMITS.maxBytes` |
| Nodes | 5,000 | `DEFAULT_SCANNER_LIMITS.maxNodes` |
| Graph edges | 10,000 | `DEFAULT_SCANNER_LIMITS.maxEdges` |
| Connection nesting depth | 64 | `DEFAULT_SCANNER_LIMITS.maxConnectionDepth` |
| Parameter object depth | 64 | `DEFAULT_SCANNER_LIMITS.maxParameterDepth` |
| Parameter leaf values | 10,000 | `DEFAULT_SCANNER_LIMITS.maxParameterLeaves` |
| JavaScript/Python source per node | 100,000 bytes each | `MAX_JAVASCRIPT_SOURCE_BYTES`, `MAX_PYTHON_SOURCE_BYTES` |
| JavaScript AST / Python CST nodes visited | 10,000 each | `MAX_JAVASCRIPT_AST_NODES`, `MAX_PYTHON_CST_NODES` |
| Findings per JavaScript/Python source | 10 | `MAX_FINDINGS_PER_SOURCE` (each analyzer) |
| Taint findings per scan | 50 | `MAX_TAINT_FINDINGS` |
| Taint propagation updates | `nodes × 15 + 1`, capped at 20,000 | `MAX_TAINT_STATE_UPDATES`, `updateBudget()` |
| AI capability findings per scan | 25 | `MAX_AI_CAPABILITY_FINDINGS` |
| Hardened analyzer findings per scan | 100 | documented in `policy-inventory.md` |

A workflow that exceeds the payload/node/edge/depth budgets is rejected before any policy runs
(`WORKFLOW_TOO_LARGE` / `WORKFLOW_TOO_COMPLEX`, see [architecture.md](architecture.md)) — those are
not `ANALYSIS_LIMIT_EXCEEDED` cases, they are scans that never start. The per-analyzer caps above
are the ones that can produce a partial, `DEGRADED` result for a workflow that *did* start scanning.

## Coverage against the documented 2026 n8n incident record

Assessed against the incidents in [the threat model](threat-model.md#why-this-matters-now--the-2026-n8n-incident-record):

| Risk | Covered? | Note |
| --- | --- | --- |
| Code-node RCE | Yes | `N8N_CODE_NODE`, `JAVASCRIPT_DYNAMIC_EXECUTION`, `PYTHON_DYNAMIC_EXECUTION` |
| Execute Command injection | Yes | `N8N_EXECUTE_COMMAND`, `TAINTED_COMMAND` |
| Hardcoded credentials | Yes | `RAW_SECRET_INDICATOR`, `RAW_AUTH_HEADER`, provider-token patterns |
| Unauthenticated webhooks | Yes | `WEBHOOK_EXPOSURE` |
| SSRF via HTTP Request | Yes | `TAINTED_REQUEST_URL`, `UNAPPROVED_DOMAIN` |
| SQL injection | Yes | `TAINTED_SQL_QUERY` |
| Path traversal | Yes | `TAINTED_FILE_PATH` |
| Prompt injection into AI agents | Yes | `TAINTED_AI_PROMPT` |
| Over-permissioned agent tools | Yes | `AI_AGENT_UNGATED_TOOL` |
| Community-node supply chain | Partial | `UNKNOWN_NODE_PACKAGE` flags the namespace only — no reputation or known-malicious list |
| Data exfiltration via agent HTTP tools | Partial | `TAINTED_REQUEST_URL` covers taint; egress-destination policy is a separate, unbuilt rule |
| `$env` / secret-variable leakage | Partial | See the dedicated section above — JavaScript-only, hardened-only, `REPORT_ONLY` |
| Credential over-scoping across workflows | No | Single-workflow analysis cannot see instance-wide credential sharing |
| Known-vulnerable n8n version detection | No | No rule reads or warns about the target n8n version |

## What "clean" and "low severity" actually mean

A `COMPLETE` status with no findings means the current profile found no catalogued evidence in the
portion of the workflow it could analyze — not that the workflow is safe, not that every node was
inspected, and not that the profile covers every risk in the table above. A `LOW` severity finding
(for example `N8N_CODE_NODE`, which fires on node type alone) is a review prompt, not a safety
grade. See [threat-model.md](threat-model.md) for the full trust-boundary breakdown and
[calibration.md](calibration.md) for what the false-positive/false-negative evidence does and does
not establish.

## Labels that are escaped or redacted, and how findings are located

A workflow or node **label** that contains failure-shaped or credential-shaped text is not published
verbatim. Text matching the engine's failure shapes (for example a name such as `Error: boom`) is escaped in
the published output, and text matching the credential shapes (a name or separator such as `Token:`, or a
credential value such as `sk-…`, `AKIA…`, `eyJ…`) is redacted. So a label in a report, in the CLI's JSON
output or in a SARIF subject may not read exactly as the name in the workflow — `Receive Exception Request`
can appear in a form that is not searchable by that string.

Because of that, **findings are located by identity rather than by name**: every node reference carries an
ordinal and an identity digest, computed at normalization and untouched by this sanitisation, so a consumer
can join a finding to its node without depending on the label text. Labels that are emptied by redaction are
published with a visible replacement marker rather than as an empty string.

## `NO_RESULT` rows in the 2026-10-20 catalogue

Eighteen bound inputs were read under the admitted v2 identity and produced no native result; they
publish `scanFreshness: NO_RESULT` with no grade, no result digest and no body reference. The engine's
own refusal code is `SEMANTIC_CATALOGUE_INVALID` for all eighteen. Categorised from the originating
validation (counts only; no workflow text is reproduced):

- 14 inputs contain a node type outside the engine's node-type grammar (whitespace in the type name);
- 3 inputs carry a short, non-canonical `typeVersion` string that is not strict semver;
- 1 input carries an empty `operation` parameter where the semantic query expects a value or absence.

None of these is caused by the semantic records added in this release, and none is retried into a
verdict: admission is fail-closed, so the row stays an explicit refusal rather than a clean or
historical result.
