# Scanner policy inventory

> Status: current
> Last verified: 2026-09-04
> Owner: Scanner maintainer
> Source of truth: `packages/scanner-core/src/policy/rule-catalog.ts`, policy/analyzer modules, and `scanner-beta-1`

This inventory describes every active policy in the two shipped profiles. It records the catalog
defaults; a policy may emit a narrower severity for a specific evidence shape. `LEGACY_SCORE` is
the runtime effect name for findings that participate in the existing risk grade. `REPORT_ONLY`
findings are displayed for review and do not change the risk grade. Neither effect is a proof of
exploitability or safety.

## Profile coverage

`beta-default` has seven `LEGACY_SCORE` policies. `beta-hardened` is defined with those seven plus
ten `REPORT_ONLY` policies from bounded JavaScript, Python, taint, and AI capability analysis; the
profile is not admitted or selectable, so those advisory policies do not run in a shipped scan.

| Profile | Policy count | Effect boundary | Completeness boundary |
| --- | ---: | --- | --- |
| `beta-default` | 7 | Scored findings from the declarative policy set | Node source spans exist from normalization; no code-source, JavaScript/Python, taint, or AI analyzer coverage |
| `beta-hardened` | 17 | The same 7 scored policies plus 10 defined advisory policies; not admitted or selectable | Analyzer diagnostics and caps are defined, but no shipped scan runs the advisory analyzers |

## Active policies

The severity and confidence columns are catalog defaults (`defaultSeverity`, `defaultConfidence`).
Precision is the catalog's current calibration label, not a measured probability. The **CWE**
column is shipped as `cweIds` (and, for the two agentic rules, `owaspAgenticIds`) on each
`RuleCatalogEntry` in `packages/scanner-core/src/policy/rule-catalog.ts`, and surfaced as
`external/cwe/cwe-###` / `owasp-agentic/<slug>` tags on each rule's SARIF `reportingDescriptor` by
`app/src/scanner/report/report-sarif.ts`; see
[CWE and OWASP mapping notes](#cwe-and-owasp-mapping-notes) below for what each mapping does and
does not claim, and for the mappings this review rejected or narrowed.

| Profiles | Policy ID | CWE | Threat and evidence | Effect / default severity / confidence | Remediation | Completeness and blind spots |
| --- | --- | --- | --- | --- | --- | --- |
| Both | `N8N_EXECUTE_COMMAND` | CWE-78 [^cap] | Exact `n8n-nodes-base.executeCommand` node; evidence is the node type. Configured command/capability details are not inspected. | `LEGACY_SCORE` / CRITICAL / HIGH; precision HIGH. | Remove when unnecessary; otherwise isolate the worker/host, restrict command capability, and require change review. | Does not inspect host permissions, container/task-runner isolation, configured command semantics, or whether the branch executes. |
| Both | `N8N_CODE_NODE` | CWE-94 [^cap] | Exact Code and legacy Function/Function Item types; evidence is node type. This is custom-code anatomy, not a vulnerability finding. | `LEGACY_SCORE` / LOW / HIGH; precision HIGH. | Review source, remove unnecessary scripting, and require approval for production changes. | Presence is covered in both profiles; source behavior requires hardened analyzers and can be unavailable, unsupported, or unparsable. |
| Both | `RAW_AUTH_HEADER` | CWE-798 (literal) / CWE-522 (expression) | Direct `Authorization` header in object or name/value parameter form. Literal values emit HIGH; expression/credential-driven values emit INFO. | `LEGACY_SCORE` / HIGH / MEDIUM; precision MEDIUM. | Use managed n8n credentials or an approved secret reference; rotate any exposed token. | It cannot resolve credentials or distinguish every safe header construction. Raw headers in unrecognized parameter shapes are missed. |
| Both | `RAW_SECRET_INDICATOR` | CWE-798 | Recursive parameter evidence: provider-shaped sensitive value, secret-named literal, or secret-named structure. Expressions/placeholders are suppressed. | `LEGACY_SCORE` / HIGH / MEDIUM; precision MEDIUM. Actual severity is HIGH for sensitive values, MEDIUM for secret-named literals, LOW for naming/structure only; sensitive values have HIGH confidence, key signals MEDIUM. | Move material to n8n credentials/approved secret manager, rotate exported material, then re-scan. | Pattern-based and finite; unknown encodings, split/derived values, credential-store contents, and runtime output are not covered. |
| Both | `UNAPPROVED_DOMAIN` | none [^domain] | Fully parseable `http`/`https` URLs whose lowercase hostname is not an exact match for an operator-supplied approved-domain list. | `LEGACY_SCORE` / MEDIUM / HIGH; precision HIGH. | Supply and review an allowlist, use intended endpoints, and review data sent to every destination. | Inactive when the list is empty. Exact host matching does not validate ownership, TLS, DNS, SSRF controls, path/query safety, or response behavior. |
| Both | `UNKNOWN_NODE_PACKAGE` | CWE-1357 | One finding per package prefix for node types outside `n8n-nodes-base.` and `@n8n/`. Evidence is the namespace/package prefix. | `LEGACY_SCORE` / LOW / MEDIUM; precision MEDIUM. | Verify package source, publisher, version, permissions, and review status before installation/use. | Namespace is not provenance or malware analysis. Private, fabricated, renamed, or behaviorally risky nodes can be missed or misclassified. |
| Both | `WEBHOOK_EXPOSURE` | CWE-306 | Exact `n8n-nodes-base.webhook` node with missing authentication or the string `none`. | `LEGACY_SCORE` / MEDIUM / MEDIUM; precision MEDIUM. | Configure appropriate authentication and independently review gateway, signature, replay, rate, and authorization controls. | Checks only the node parameter marker; it cannot see an API gateway, IP allowlist, signature verification, downstream authorization, or deployment exposure. |
| Hardened | `JAVASCRIPT_DYNAMIC_EXECUTION` | CWE-95 [^js] | Selected Code/Function JavaScript source parsed by Acorn: dynamic code, child-process, filesystem, network, or selected environment/credential access APIs. Evidence is indicator/member and numeric source offsets, never source text. | `REPORT_ONLY` / HIGH / HIGH; precision HIGH. | Review the exact source span, remove unnecessary capability, constrain runtime modules, and validate all inputs/outputs. | Source cap 100,000 bytes, AST cap 10,000, ten findings/source, and selected syntax/API catalog only. Parse/source/variant diagnostics degrade completeness. |
| Hardened | `PYTHON_DYNAMIC_EXECUTION` | CWE-95 [^py] | Selected `python`/`pythonNative` source parsed by Lezer: eval/exec/import primitives, subprocess methods, OS command/process methods, aliases, and bounded `getattr`/literal composition. | `REPORT_ONLY` / HIGH / MEDIUM; precision MEDIUM. | Review source and runtime policy, remove unnecessary process capability, and constrain inputs. | Source/CST/finding caps are bounded. Subprocess use is reported even when `shell=False`; this is a capability prompt, not proof of shell injection. Unsupported syntax, parser failure, and runtime behavior are blind spots. |
| Hardened | `TAINTED_COMMAND` | CWE-78 | Selected inbound/external sources reach `executeCommand.command` over reviewed `main` execution edges. Trace is bounded and node-scoped. | `REPORT_ONLY` / CRITICAL / MEDIUM; precision MEDIUM. | Validate/allowlist command arguments, avoid shell capabilities, and isolate or remove the sink. | Sources/sinks are exact catalogs; unknown nodes/edges and dynamic references reduce recall. No field-level dataflow or execution proof. |
| Hardened | `TAINTED_SQL_QUERY` | CWE-89 | Selected external input reaches `postgres`, `mySql`, or `microsoftSql` query fields. | `REPORT_ONLY` / HIGH / MEDIUM; precision MEDIUM. | Use parameterized query features, constrain input, and review database permissions. | Exact sink/node catalog; SQL parsing, query semantics, schema, parameter binding, and runtime values are not analyzed. |
| Hardened | `TAINTED_REQUEST_URL` | CWE-918 | Selected external input reaches exact `n8n-nodes-base.httpRequest.url`. | `REPORT_ONLY` / HIGH / MEDIUM; precision MEDIUM. | Allowlist destinations, validate URL components, and constrain outbound network access. | Does not prove SSRF, DNS/TLS behavior, response trust, or coverage of URL-building nodes not in the catalog. |
| Hardened | `TAINTED_FILE_PATH` | CWE-22 | Selected external input reaches catalogued file selectors/paths on `readWriteFile`, `readBinaryFile`, or `writeBinaryFile`. | `REPORT_ONLY` / HIGH / MEDIUM; precision MEDIUM. | Constrain paths to an approved directory, canonicalize/validate names, and restrict filesystem permissions. | Exact fields and node types only; no path canonicalization, symlink, binary-content, host, or runtime permission analysis. |
| Hardened | `TAINTED_CODE_INPUT` | CWE-94 | Selected external input reaches code fields on Code/Function/Function Item nodes. | `REPORT_ONLY` / HIGH / MEDIUM; precision MEDIUM. | Do not construct executable source from untrusted data; remove the flow or validate and isolate it. | Node-scoped rather than field-scoped taint; no JavaScript/Python execution or proof that source is subsequently evaluated. |
| Hardened | `TAINTED_REQUEST_HEADER` | CWE-113 | Selected external input reaches an HTTP Request header value in the catalogued parameter shape. | `REPORT_ONLY` / MEDIUM / MEDIUM; precision MEDIUM. | Allowlist header names/values, avoid forwarding inbound authorization, and use managed credentials. | Exact HTTP Request shape only; no downstream proxy policy, credential merge, or recipient behavior. `encodeURIComponent` clears only header taint in the current sanitizer model. |
| Hardened | `TAINTED_AI_PROMPT` | CWE-77 [^prompt] + OWASP Agentic: Prompt Injection | Selected external input reaches prompt/text fields on catalogued LangChain agent/chain nodes. | `REPORT_ONLY` / MEDIUM / LOW; precision LOW. | Treat inbound text as untrusted, separate instructions from data, constrain tools, and add human approval for consequential actions. | Does not run a model or prove prompt injection, model behavior, hidden context, or tool execution. Only catalogued nodes and reviewed connection types are modeled. |
| Hardened | `AI_AGENT_UNGATED_TOOL` | CWE-269 + OWASP Agentic: Excessive Agency | An AI agent has at least one reviewed `ai_tool` edge, receives modeled taint, and lacks a catalogued human gate dominating every path. | `REPORT_ONLY` / MEDIUM / LOW; precision LOW. | Add and test a human approval gate for consequential tools; minimize tools and validate arguments. | Structural gate evidence is not proof of meaningful review. Unrecognized tools/gates, hidden calls, alternate branches, and actual operator intent are not inferred. |

### CWE and OWASP mapping notes

These mappings are **shipped**: `packages/scanner-core/src/policy/rule-catalog.ts` carries them as
`cweIds`/`owaspAgenticIds` on every `RuleCatalogEntry`, and
`app/src/scanner/report/report-sarif.ts` surfaces them as `properties.tags` on each rule's SARIF
`reportingDescriptor` (`external/cwe/cwe-###`, the form CodeQL and GitHub's own queries emit so
code scanning recognizes it, plus `owasp-agentic/<slug>` for the two agentic rules — GitHub has no
defined tag form for OWASP Agentic, so this is a readable label for tag-based filtering only). The
table stays deliberately conservative about rules where a single CWE does not cleanly fit, and
`UNAPPROVED_DOMAIN` is intentionally left with no CWE (`RULES_WITHOUT_CWE` in `rule-catalog.ts`) —
see the `[^domain]` footnote below.

- [^cap]: `N8N_EXECUTE_COMMAND` and `N8N_CODE_NODE` flag **capability**, not a confirmed
  vulnerability: the finding fires on node type alone, before any input reaches the command or
  code. CWE-78/CWE-94 name the category of risk the node *enables*, not a proven injection. The
  taint-flow rules (`TAINTED_COMMAND`, `TAINTED_CODE_INPUT`) are the ones with an actual
  source-to-sink claim under the same CWE IDs.
- [^domain]: `UNAPPROVED_DOMAIN` was reviewed against the audit's proposed CWE-918 (SSRF) and that
  mapping is **rejected here** as inaccurate, not merely conservative. SSRF requires an
  attacker-influenced destination; `UNAPPROVED_DOMAIN` fires on any URL outside an allowlist,
  including one hardcoded by the workflow's own author with no external input involved. CWE-918
  is reserved for `TAINTED_REQUEST_URL`, which is the rule with an actual tainted-destination
  claim. `UNAPPROVED_DOMAIN` is an egress-allowlist control gap; no CWE ID names that class
  precisely, so this inventory leaves it unmapped rather than force a fit.
- [^js]: `JAVASCRIPT_DYNAMIC_EXECUTION` fires on eight different indicators (`EVAL`,
  `FUNCTION_CONSTRUCTOR`, `CHILD_PROCESS_*`, `FILESYSTEM_ACCESS`, `NETWORK_ACCESS`,
  `ENVIRONMENT_ACCESS`, `SECRET_ACCESS`, module `IMPORT`/`REQUIRE`) under one policy ID. CWE-95
  ("Eval Injection") accurately describes only the `EVAL`/`FUNCTION_CONSTRUCTOR` indicators. The
  child-process indicator is closer to CWE-78, filesystem access to CWE-73, and
  environment/secret access has no precise CWE match at all. One CWE per policy ID is a
  simplification; a future per-indicator mapping would be more accurate than this table can be.
- [^py]: Same caveat as JavaScript: CWE-95 fits the `EVAL`/`EXEC`/`DYNAMIC_IMPORT` indicators
  precisely; the `SHELL_SUBPROCESS` indicator (`subprocess.run`, `os.system`, etc.) is closer to
  CWE-78 and is reported as a capability prompt even when `shell=False`, per the rule's own
  documented limitation above.
- [^prompt]: There is no CWE dedicated to LLM prompt injection. CWE-77 ("Command Injection") is
  used here as the nearest structural analogy — untrusted data reaching an interpreter that
  blends instructions and data — not a literal match. The OWASP Agentic Top 10 "Prompt Injection"
  category is the more precise, purpose-built taxonomy tag for this rule; treat it as primary and
  CWE-77 as a bridge for tooling that only understands CWE.
- `AI_AGENT_UNGATED_TOOL` → CWE-269 was reviewed against the alternative CWE-862 (Missing
  Authorization). Both are defensible: CWE-269 frames the agent as holding privilege it should
  not autonomously exercise; CWE-862 frames the missing wait/approval node as a missing
  authorization check on a sensitive action. CWE-269 is kept as proposed because the OWASP
  Agentic "Excessive Agency" pairing is doing the precise work either way.

## Minimal triggering examples

Each fragment is the smallest `nodes`/`connections` shape that trips the rule, given as the input
to `parseWorkflowJson`. Taint and AI examples require the workflow graph shown — a same-node
literal does not propagate. All examples assume the `beta-hardened` profile for the ten
`REPORT_ONLY` rows; the first seven run under `beta-default` too.

### `N8N_EXECUTE_COMMAND`

```json
{ "nodes": [
  { "id": "1", "name": "Run", "type": "n8n-nodes-base.executeCommand", "parameters": { "command": "ls -la" } }
], "connections": {} }
```

### `N8N_CODE_NODE`

```json
{ "nodes": [
  { "id": "1", "name": "Code", "type": "n8n-nodes-base.code", "typeVersion": 2,
    "parameters": { "language": "javaScript", "jsCode": "return items;" } }
], "connections": {} }
```

### `RAW_AUTH_HEADER`

```json
{ "nodes": [
  { "id": "1", "name": "HTTP", "type": "n8n-nodes-base.httpRequest", "parameters": {
    "headerParameters": { "parameters": [
      { "name": "Authorization", "value": "Bearer sk_live_abc123" } ] } } }
], "connections": {} }
```

### `RAW_SECRET_INDICATOR`

```json
{ "nodes": [
  { "id": "1", "name": "Set", "type": "n8n-nodes-base.set",
    "parameters": { "apiKey": "AKIAABCDEFGHIJKLMNOP" } }
], "connections": {} }
```

### `UNAPPROVED_DOMAIN`

Scanned with `approvedDomains: ["api.example.com"]` — a scan-request option, not part of the
workflow JSON itself:

```json
{ "nodes": [
  { "id": "1", "name": "HTTP", "type": "n8n-nodes-base.httpRequest",
    "parameters": { "url": "https://evil.example.com/collect" } }
], "connections": {} }
```

### `UNKNOWN_NODE_PACKAGE`

```json
{ "nodes": [
  { "id": "1", "name": "Custom", "type": "n8n-nodes-community-foo.customNode", "parameters": {} }
], "connections": {} }
```

### `WEBHOOK_EXPOSURE`

```json
{ "nodes": [
  { "id": "1", "name": "Webhook", "type": "n8n-nodes-base.webhook",
    "parameters": { "authentication": "none" } }
], "connections": {} }
```

### `JAVASCRIPT_DYNAMIC_EXECUTION`

```json
{ "nodes": [
  { "id": "1", "name": "Code", "type": "n8n-nodes-base.code", "typeVersion": 2, "parameters": {
    "language": "javaScript",
    "jsCode": "eval(items[0].json.expr); require('child_process').exec('ls');" } }
], "connections": {} }
```

### `PYTHON_DYNAMIC_EXECUTION`

```json
{ "nodes": [
  { "id": "1", "name": "Code", "type": "n8n-nodes-base.code", "typeVersion": 2, "parameters": {
    "language": "pythonNative",
    "pythonCode": "import subprocess\nsubprocess.run(cmd, shell=True)" } }
], "connections": {} }
```

### `TAINTED_COMMAND`

```json
{ "nodes": [
  { "id": "w", "name": "Webhook", "type": "n8n-nodes-base.webhook", "parameters": {} },
  { "id": "s", "name": "Run", "type": "n8n-nodes-base.executeCommand",
    "parameters": { "command": "={{ $json.cmd }}" } }
], "connections": { "Webhook": { "main": [[ { "node": "Run", "type": "main", "index": 0 } ]] } } }
```

### `TAINTED_SQL_QUERY`

```json
{ "nodes": [
  { "id": "w", "name": "Webhook", "type": "n8n-nodes-base.webhook", "parameters": {} },
  { "id": "s", "name": "Postgres", "type": "n8n-nodes-base.postgres",
    "parameters": { "query": "={{ $json.q }}" } }
], "connections": { "Webhook": { "main": [[ { "node": "Postgres", "type": "main", "index": 0 } ]] } } }
```

### `TAINTED_REQUEST_URL`

```json
{ "nodes": [
  { "id": "w", "name": "Webhook", "type": "n8n-nodes-base.webhook", "parameters": {} },
  { "id": "s", "name": "HTTP", "type": "n8n-nodes-base.httpRequest",
    "parameters": { "url": "={{ $json.target }}" } }
], "connections": { "Webhook": { "main": [[ { "node": "HTTP", "type": "main", "index": 0 } ]] } } }
```

### `TAINTED_FILE_PATH`

```json
{ "nodes": [
  { "id": "w", "name": "Webhook", "type": "n8n-nodes-base.webhook", "parameters": {} },
  { "id": "s", "name": "Read File", "type": "n8n-nodes-base.readWriteFile",
    "parameters": { "fileSelector": "={{ $json.path }}" } }
], "connections": { "Webhook": { "main": [[ { "node": "Read File", "type": "main", "index": 0 } ]] } } }
```

### `TAINTED_CODE_INPUT`

```json
{ "nodes": [
  { "id": "w", "name": "Webhook", "type": "n8n-nodes-base.webhook", "parameters": {} },
  { "id": "s", "name": "Code", "type": "n8n-nodes-base.code", "typeVersion": 2,
    "parameters": { "language": "javaScript", "jsCode": "={{ $json.script }}" } }
], "connections": { "Webhook": { "main": [[ { "node": "Code", "type": "main", "index": 0 } ]] } } }
```

### `TAINTED_REQUEST_HEADER`

```json
{ "nodes": [
  { "id": "w", "name": "Webhook", "type": "n8n-nodes-base.webhook", "parameters": {} },
  { "id": "s", "name": "HTTP", "type": "n8n-nodes-base.httpRequest", "parameters": {
    "headerParameters": { "parameters": [
      { "name": "X-Forward", "value": "={{ $json.header }}" } ] } } }
], "connections": { "Webhook": { "main": [[ { "node": "HTTP", "type": "main", "index": 0 } ]] } } }
```

### `TAINTED_AI_PROMPT`

```json
{ "nodes": [
  { "id": "w", "name": "Webhook", "type": "n8n-nodes-base.webhook", "parameters": {} },
  { "id": "s", "name": "Agent", "type": "@n8n/n8n-nodes-langchain.agent",
    "parameters": { "text": "={{ $json.message }}" } }
], "connections": { "Webhook": { "main": [[ { "node": "Agent", "type": "main", "index": 0 } ]] } } }
```

### `AI_AGENT_UNGATED_TOOL`

The tool attaches via an `ai_tool` edge (capability graph), separate from the `main` execution
edge that carries the untrusted input:

```json
{ "nodes": [
  { "id": "w", "name": "Webhook", "type": "n8n-nodes-base.webhook", "parameters": {} },
  { "id": "a", "name": "Agent", "type": "@n8n/n8n-nodes-langchain.agent", "parameters": {} },
  { "id": "t", "name": "HTTP Tool", "type": "n8n-nodes-base.httpRequestTool", "parameters": {} }
], "connections": {
  "Webhook": { "main": [[ { "node": "Agent", "type": "main", "index": 0 } ]] },
  "HTTP Tool": { "ai_tool": [[ { "node": "Agent", "type": "ai_tool", "index": 0 } ]] }
} }
```

Adding a `n8n-nodes-base.wait` node (with `resume: "form"`) or a catalogued `sendAndWait` node on
every path into `Agent` removes the finding — that is the catalogued human gate the rule looks for.

## Analyzer and diagnostic contract

Hardened analysis is advisory and bounded. JavaScript and Python each cap source at 100,000 bytes,
AST/CST work at 10,000 nodes, and findings at ten per source. Taint analysis uses only `main`
execution edges, caps findings at 50, and traces paths to depth 64. Hardened analyzer findings are
capped at 100 per scan. These caps can omit evidence and therefore are not clean outcomes.

The complete diagnostic vocabulary is maintained in `analysis-diagnostic-codes.ts` and classified
in `analysis-completeness.ts`:

| Status | Codes | Meaning for review |
| --- | --- | --- |
| `DEGRADED` | `ANALYSIS_LIMIT_EXCEEDED`, `SOURCE_SPAN_UNAVAILABLE`, `DUPLICATE_JSON_KEY`, `UNSUPPORTED_CODE_NODE_VARIANT`, `JAVASCRIPT_PARSE_FAILED`, `JAVASCRIPT_SOURCE_UNAVAILABLE`, `PYTHON_SOURCE_UNAVAILABLE`, `PYTHON_PARSE_FAILED`, `PYTHON_PARSER_UNAVAILABLE`, `EXPRESSION_PARSE_FAILED`, `GRAPH_ANALYSIS_DEGRADED`, `DUPLICATE_FINDING_COLLAPSED`, `UNCLASSIFIED_CONNECTION_TYPE`, `MALFORMED_CONNECTION_INDEX` | A non-required portion may have omitted evidence; do not interpret absence as safe. |
| `INDETERMINATE` | `MALFORMED_NODE_PARAMETERS`, `POLICY_EXECUTION_FAILED`, `REQUIRED_STAGE_FAILURE` | A required input/policy stage may have hidden scored risk; ordinary risk assessment and summaries are withheld. |
| `COMPLETE` | No diagnostics | No known diagnostic was emitted; this still means only “no catalogued evidence found.” |

`REQUIRED_STAGE_FAILURE` means a required analysis stage produced no usable assessment at all. It is
emitted only by native v1 analysis paths, is graded `INDETERMINATE` (the grade is suppressed rather
than reported over unknown coverage), and is a review-gated addition to the otherwise frozen v1
diagnostic union: see `docs/decisions/scanner-v1-projection.md` and the recorded decision in
`docs/audit/2026-09-16-fix/PHASE1-LEDGER.md`.

## False-positive and false-negative expectations

Expected false positives are highest for capability/anatomy prompts (`N8N_CODE_NODE`), namespace
prompts (`UNKNOWN_NODE_PACKAGE`), name-based secret signals, expression-backed Authorization
headers, node-scoped taint, and low-confidence AI gate analysis. Expected false negatives include
runtime-generated URLs/commands/code, unknown secret formats, credentials stored outside the JSON,
unsupported code syntax, unlisted node types/sinks, hidden AI tool paths, and security controls
implemented outside the workflow.

The reviewed calibration corpus is a 30-fixture, six-stratum sample captured from the n8n
templates API on 2026-08-07. It is a regression/calibration corpus, not a prevalence estimate or a
precision/recall claim. The historical false-positive review is recorded in
`docs/scanner-false-positive-review.md`; changes to scored rules require a new differential and
calibration decision. A separate, newer 27-case synthetic calibration corpus with a dev/holdout
split is documented in [calibration.md](calibration.md).

## Primary sources and version caveats

The following primary n8n documentation was retrieved/validated on **2026-08-29**:

- [Security audit](https://docs.n8n.io/hosting/securing/security-audit/)
- [Workflow sharing](https://docs.n8n.io/workflows/sharing/)
- [Execute Command](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.executecommand/)
- [Webhook](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.webhook/)
- [HTTP Request](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.httprequest/)
- [Code node common issues](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.code/common-issues)
- [Community-node risks](https://docs.n8n.io/integrations/community-nodes/risks)
- [Export and import](https://docs.n8n.io/workflows/export-import)
- [Human-in-the-loop for AI tool calls](https://docs.n8n.io/build/integrate-ai/ai-examples/human-in-the-loop-for-tools)
- [n8n 2.0 breaking changes](https://docs.n8n.io/2-0-breaking-changes/)

The docs are current as retrieved but are not a runtime version declaration for an imported
workflow. Exact fixture shape evidence is pinned to n8n source commit
[`1aa604d26548e8d23d5d8dff9f8f3fe762ed24c4`](https://github.com/n8n-io/n8n/tree/1aa604d26548e8d23d5d8dff9f8f3fe762ed24c4),
captured 2026-08-06. The app uses Acorn `8.17.0` and `@lezer/python` `1.1.19`; n8n is not an app
dependency. Re-check node shapes, Code runtime, connection types, community-node behavior, and
approval semantics when n8n or parser versions change. See the maintenance guidance in
[the threat model](threat-model.md).
