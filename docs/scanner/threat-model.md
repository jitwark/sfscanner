# Scanner threat model

> Status: current v1 threat model; explicit v2 boundary documented
> Last verified: 2026-10-17
> Owner: Scanner maintainer
> Source of truth: [`packages/scanner-core/src/v2/scan-workflow.ts`](../../packages/scanner-core/src/v2/scan-workflow.ts), [`packages/scanner-core/src/v2/admitted-registry.ts`](../../packages/scanner-core/src/v2/admitted-registry.ts), [`contracts/scanner-limits-v2.ts`](../../contracts/scanner-limits-v2.ts), and the native-v1 sources and incident sources listed below

## Scope and security claim

This is the threat model for the shipped `scanner-beta-1` deterministic scanner. It accepts one
n8n-shaped workflow JSON document, normalizes it, and produces an advisory report in the browser.
It does not execute the workflow, contact an n8n instance, install a node package, resolve a live
credential, or ask a model for a security verdict.

The scanner covers the explicitly catalogued patterns in [the policy inventory](policy-inventory.md).
It is not an n8n security audit, a sandbox, a provenance verifier, a compliance assessment, or a
certificate that a workflow is safe. A clean result means only that the current profile found no
catalogued evidence in the portion it could analyze. It must not be read as universal coverage of
n8n nodes, integrations, code, permissions, or runtime configuration.

The runtime identifiers are:

| Identifier | Current value | Meaning |
| --- | --- | --- |
| Scanner | `scanner-beta-1` | Policy and analyzer implementation version |
| Result schema | `scanner-result-v1` | Serialized result contract |
| Limits | `scanner-limits-v1` | Shared browser/pipeline input limits |
| Profiles | `beta-default`, `beta-hardened` | Default scored checks versus additional advisory analysis |

## Explicit v2 boundary (without rewriting v1 history)

The scope, incident record, assets, trust boundaries, and scoring details below remain the native
v1 threat model unless a section explicitly says v2. Native v1 keeps `scanner-beta-1`,
`scanner-result-v1`, `scanner-limits-v1`, and its existing profile behavior.

The explicit v2 path admits only `secureflow-scanner@2.0.0` with `beta-default@2.0.0` and the
built-in authority assembled by [`admitted-registry.ts`](../../packages/scanner-core/src/v2/admitted-registry.ts).
It preserves the same offline, static, bounded, no-submitted-code-execution boundary while adding
source-preserving admission, closed safe facts, and strong `UNKNOWN`/`DEGRADED`/`INDETERMINATE`
outcomes. `beta-hardened@2.0.0` is defined but not admitted on v2; native v1 hardened analysis is
not removed.

V2 does not infer host vulnerabilities, n8n version, credential-store contents, deployment settings,
or runtime behavior. It does not authorize public identity, rights, deployment, publication, MCP
behavior, Ed25519 signature verification, or key rotation. Those remain separate owner-gated or
deferred procedures. A v2 result with required missing evidence has no assessment rather than a
reassuring grade.

## Why this matters now — the 2026 n8n incident record

> **n8n has the most security advisories of any agentic project tracked by OWASP — 57 disclosed
> advisories, significantly more than other coding agents and AI tools.**
> — [Help Net Security, 2026-06-11](https://www.helpnetsecurity.com/2026/06/11/owasp-prompt-injection-ai-security-failures/)

This scanner exists because that sentence is true today, not as a hypothetical. The incidents
below are documented, dated, and public — this section maps each to the rule family that
addresses it, and is explicit about the ones no static, single-workflow scanner can address at
all.

| Incident | Detail | Rule family that addresses it |
| --- | --- | --- |
| **`CVE-2026-33663`** — credential theft via name-based resolution plus a permission-checker bypass in n8n **Community Edition**. Fixed in 1.123.27 / 2.13.3 / 2.14.1. Enterprise had independent gates; self-hosted instances were the exposed population. ([GitHub Advisory](https://github.com/advisories/GHSA-m63j-689w-3j35)) | This is an n8n-platform bug, not a workflow-shape problem — no rule in this scanner detects it directly. It is why [`RAW_SECRET_INDICATOR`](policy-inventory.md) and [`RAW_AUTH_HEADER`](policy-inventory.md) matter: workflows that route around managed credentials (because credential resolution itself was untrustworthy) are exactly the pattern those rules catch. |
| **Six CVEs disclosed in one day** — RCE, command injection, arbitrary file access, and XSS, all breaking isolation between workflows, configuration, and the host. ([Upwind](https://www.upwind.io/feed/six-n8n-cves-one-day-workflow-security)) | `N8N_EXECUTE_COMMAND`, `TAINTED_COMMAND` (command injection); `JAVASCRIPT_DYNAMIC_EXECUTION`, `PYTHON_DYNAMIC_EXECUTION`, `TAINTED_CODE_INPUT` (RCE via code nodes); `TAINTED_FILE_PATH` (arbitrary file access). This scanner cannot detect n8n platform-level isolation bugs themselves — it detects the *workflow-authored* version of the same risk classes. |
| **321 live n8n instances exposed via leaked GitHub tokens** — GitGuardian found instances accepting leaked tokens, exposing workflows, data, and downstream credentials. No CVE assigned. ([The Hacker News, 2026-08](https://thehackernews.com/2026/08/leaked-n8n-api-tokens-exposed-live.html)) | Outside scope: this is an instance-exposure and secret-hygiene problem at the deployment level, not a property of a single workflow JSON document. `RAW_SECRET_INDICATOR` catches secrets pasted *into* a workflow; it says nothing about tokens leaked through other channels. |
| **Critical RCE plus stored-credential exposure** — an attacker with sufficient API privileges can reference existing credentials in a new workflow and make the instance use them on the attacker's behalf. ([The Hacker News, 2026-03](https://thehackernews.com/2026/03/critical-n8n-flaws-allow-remote-code.html); [Cybersecurity Dive](https://www.cybersecuritydive.com/news/critical-vulnerability-n8n-automation-platform/809360/)) | This is exactly the **instance-wide credential over-scoping** gap documented in [limitations.md](limitations.md#instance-wide-credential-over-scoping): a single-workflow scanner cannot see which credentials an instance lets a given workflow reach. `RAW_AUTH_HEADER`/`RAW_SECRET_INDICATOR` catch credentials pasted in JSON, not credential-store authorization scope. |
| **Community nodes are unvetted** — a malicious or compromised community node can run with full instance access; over-scoped shared credentials and exposed self-hosted execution APIs are among the most common 2026 assessment findings. ([AppSecure](https://www.appsecure.security/blog/n8n-security-risks-and-mitigations)) | `UNKNOWN_NODE_PACKAGE` flags the namespace as a review prompt (see the [limitations.md](limitations.md#community-node-reputation-and-known-malicious-lists) caveat — it is not a reputation check). |
| **AI agents are now n8n's dominant use case, and OWASP's Agentic Top 10 centers prompt injection and excessive agency.** ([OWASP Top 10 for Agentic Applications](https://www.practical-devsecops.com/owasp-top-10-agentic-applications/)) | `TAINTED_AI_PROMPT` (prompt injection) and `AI_AGENT_UNGATED_TOOL` (excessive agency) are purpose-built for this. See [policy-inventory.md](policy-inventory.md) for both rules' proposed OWASP Agentic mappings. |

The self-hosted population is the exposed population in more than one of these incidents, and
self-hosted n8n users get no vendor support for triage — the community carries it. That is this
scanner's audience.

## Assets and consequences

The scanner protects reviewer attention and reduces exposure during static review. The underlying
workflow may still carry or control the following assets:

| Asset | Why it matters | What this scanner can and cannot say |
| --- | --- | --- |
| Credentials and secret material | API keys, bearer/basic tokens, passwords, cookies, OAuth material, and credential references can authorize external systems. | Detects a finite set of raw/provider-shaped or secret-named values and raw Authorization headers; it does not inspect the n8n credential store or prove a value is live. |
| Personal and confidential data | Webhook bodies, form fields, messages, pinned data, files, and execution inputs can contain personal, customer, or business data. | Models selected ingress paths and some data flow; it does not classify all PII, infer sensitivity, or inspect runtime payloads. |
| Systems and host environment | Shell, file, network, and custom-node capabilities may reach the n8n host, worker, container, or internal services. | Flags Execute Command and selected code/taint paths; it cannot see host permissions, container boundaries, SSRF controls, or instance settings. |
| External systems and data stores | HTTP APIs, databases, SaaS accounts, queues, and storage can be read, changed, or deleted. | Flags selected outbound destinations, SQL/path/header sinks, and community packages; it does not evaluate every node operation or the remote service's security. |
| Funds and high-impact business actions | A workflow or AI tool can create purchases, refunds, records, or other irreversible business effects. | Treats these as residual impact unless their structure matches a catalogued tool, webhook, code, or taint rule; it does not classify financial authority. |
| Messages and communications | Email, chat, SMS, and notifications can disclose information or impersonate an operator. | Detects some raw auth, ingress, and AI-tool conditions; it does not verify recipients, message content, sender policy, or delivery controls. |
| Files and binary data | File nodes and binary payloads may contain sensitive data or permit overwrite/deletion. | Covers selected file path flows and static node types; it does not inspect binary contents or all file-capable/community nodes. |
| Automation control | Triggers, branches, sub-workflows, credentials, and AI tools determine what runs and when. | Parses the submitted graph and selected attachment types; it does not prove activation state, permissions, sub-workflow contents, or the complete execution plan. |

## Trust boundaries

| Boundary | Untrusted input or capability | Static control and residual risk |
| --- | --- | --- |
| Imported JSON → normalized workflow | The user-controlled file/paste may be malformed, oversized, duplicated, adversarial, or from an unknown author. | JSON is parsed without execution; byte, node, edge, depth, leaf, and worker budgets bound work. Duplicate keys, malformed parameters, and graph defects become diagnostics. |
| Expressions → runtime data | n8n expressions can read current items or named-node outputs and interpolate values into node parameters. | Hardened mode parses bounded `{{ ... }}` segments and tracks selected references; unresolved or dynamic references are weaker/low-confidence findings. Expression evaluation itself never occurs. |
| Code/Function nodes → runtime | JavaScript or Python source can implement behavior not visible in declarative parameters. | Hardened mode parses selected source fields with Acorn or Lezer; it never executes source. Unsupported language/version, missing source, parse failure, and caps are reported as degraded. |
| Credentials → node execution | A node may use a managed n8n credential, while a workflow may also contain pasted material or references. | Raw JSON is inspected and result strings are redacted. The scanner cannot resolve, test, rotate, or authorize a credential and cannot determine what the n8n instance exposes to an editor. |
| Webhook/form/message trigger → workflow | A caller or inbound message can inject body, query, header, or content data and start execution. | Exact catalogued trigger types seed taint; `WEBHOOK_EXPOSURE` checks only the Webhook parameter's authentication marker. Gateway, signature, rate-limit, replay, and business validation remain outside scope. |
| Workflow → external service | HTTP/database/file/message nodes can cross into systems outside the workflow. | URLs and selected sink fields are inspected without a network request. Approved-domain matching is exact-host and opt-in; it does not establish trust in a domain or its response. |
| Community/custom package → n8n runtime | Installed extensions may execute with package/runtime access and process workflow data. | Non-official namespace is reported once per package prefix. A namespace is not package provenance, review, version, or malware analysis. |
| AI model/context → tool/action | Model output and untrusted prompt data may influence a tool with external side effects. | Hardened mode recognizes reviewed `ai_tool`/context edges and selected human gates. It does not run a model, inspect hidden tool calls, or prove that a human will understand an approval. |
| Browser page → scanner worker | The browser host controls the page, worker, extensions, memory, cache, and normal asset network. | The worker contains no scanner network primitive and keeps input in memory for the scan. Static page assets and the host/browser remain outside this guarantee. |

The n8n documentation describes Workflow sharing as allowing editors to use all credentials used
in a shared workflow, including credentials not explicitly shared with them. The scanner therefore
treats sharing and credential access as a deployment trust boundary, not as something inferable from
the submitted JSON. See [Workflow sharing](https://docs.n8n.io/workflows/sharing/).

## Attacker and mistake cases

The profiles are designed for these review questions, not for an assumed maliciousness verdict:

| Case | Expected signal | Important limitation |
| --- | --- | --- |
| A contributor embeds a provider-shaped token or raw Authorization value. | `RAW_SECRET_INDICATOR` or `RAW_AUTH_HEADER`, with higher severity for literal evidence. | Unknown token formats and secrets split across expressions may be missed; redaction does not make the source safe. |
| A workflow can run a shell command, or custom code invokes process/file/network APIs. | Default: `N8N_EXECUTE_COMMAND`; hardened: JavaScript/Python dynamic-execution rules. | A literal command is still a capability; code analysis covers only listed APIs and bounded syntax. |
| A webhook lacks an explicit authentication marker. | `WEBHOOK_EXPOSURE`. | The rule does not test a gateway, signature, IP allowlist, replay protection, or authorization logic later in the graph. |
| An outbound URL is outside an operator-supplied allowlist. | `UNAPPROVED_DOMAIN`; tainted URL flow can add `TAINTED_REQUEST_URL`. | No allowlist disables the rule. A familiar or approved host can still be compromised or receive too much data. |
| An imported workflow contains a community/custom node. | `UNKNOWN_NODE_PACKAGE`. | It is a review prompt, not a finding that the package is malicious. Official-looking type text can be fabricated in JSON. |
| External input reaches a selected command, SQL, URL, file path, header, code field, or AI prompt. | Hardened report-only `TAINTED_*` finding with a bounded trace where possible. | Taint is node-scoped, not field-scoped; unknown nodes/edges and unlisted sinks reduce recall. |
| An AI agent receives tainted data and has a reviewed tool edge without a dominating human gate. | `AI_AGENT_UNGATED_TOOL`, report-only and low confidence. | A catalogued gate is structural evidence, not proof of meaningful human review; unrecognized tool edges are not guessed. |
| A submitter uses duplicate JSON keys, unknown connection types, malformed parameters, huge input, or many findings to confuse review or exhaust resources. | Parse/graph/limit diagnostics; bounded work and no execution. | Duplicate node names/IDs are retained as ambiguous input for conservative evidence handling, but are not currently surfaced as their own result diagnostic. A result can be degraded or indeterminate; the correct response is review or reject, not “clean.” |
| An author uses a safe-looking expression, encoding, comment, dead identifier, or alternate syntax to evade review. | Some bounded aliases and static concatenations are resolved; comments/strings are not treated as calls. | Obfuscation, dynamic property names, unsupported syntax, and runtime-generated code can evade the catalog. |

Common non-adversarial mistakes include pasting a token into a parameter, assuming an expression
reference is a managed credential, publishing an unauthenticated webhook, installing an unreviewed
community package, using an AI tool without approval, or treating a LOW grade as a safety certificate.

## Explicitly unsupported cases

The scanner does not claim to cover:

- the complete n8n node catalogue, every node operation, every community package, or private/custom
  node behavior;
- the live n8n version, Cloud/self-hosted/queue/task-runner mode, instance settings, disabled-node
  list, environment variables, network policy, filesystem policy, credentials, user roles, or sharing;
- workflow execution, activation, retries, sub-workflow contents loaded from a database/file/URL,
  remote code, remote service behavior, TLS, DNS, SSRF enforcement, rate limiting, or authorization;
- secrets encoded in unknown formats, split/derived at runtime, stored only in credentials, or
  exposed by a node the catalogue does not inspect;
- all JavaScript/Python syntax, dynamic imports, runtime-generated code, reflection, native modules,
  shell quoting, SQL semantics, path canonicalization, binary contents, or model behavior;
- a human gate that is outside the reviewed catalog, a gate on only one branch, or a model/tool call
  hidden inside a node; and
- a universal claim that a domain, package namespace, credential reference, AI model, or workflow
  author is trustworthy.

## Completeness, effects, and scoring

`beta-default` runs the seven legacy policies. Normalization retains bounded node source spans for
finding locations, but no JavaScript, Python, taint, or other code-source analyzer runs in that
profile. `beta-hardened` defines those advisory analyzers and the ten `REPORT_ONLY` policy mappings,
but the profile is not admitted or selectable, so the analyzers do not run in the shipped path and
report-only findings are not displayed. If the profile is admitted later, its findings remain
report-only and would not change the risk score or grade. The complete mapping is in [policy-inventory.md](policy-inventory.md).

Only findings catalogued as `LEGACY_SCORE` enter the risk assessment. The first finding for a policy
uses its severity weight (`CRITICAL` 55, `HIGH` 35, `MEDIUM` 18, `LOW` 6, `INFO` 1); additional
findings of that same policy add one quarter of that weight, capped at twice the first. Complexity
adds 0/10/20 for LOW/MEDIUM/HIGH workflow shape, and the total is capped at 100. Grades are LOW
below 25, MEDIUM at 25–54, HIGH at 55–79, and CRITICAL at 80 or above. This is triage, not impact
quantification.

The engine canonicalizes and redacts findings before returning them. Duplicate findings may collapse
into `DUPLICATE_FINDING_COLLAPSED`; ambiguous node IDs avoid unsafe merging. An indeterminate result
does not carry a risk assessment, human summary, or finding summary, so a failed required stage
cannot present an ordinary reassuring grade.

## Diagnostics and completeness

`COMPLETE` means there are no analysis diagnostics. `DEGRADED` means a non-required part may have
missed evidence. `INDETERMINATE` means a required input or policy stage may have hidden scored risk.
The classification is explicit in `analysis-completeness.ts`; new diagnostic codes must be classified
there rather than defaulting silently. Both v1 engines pass their diagnostics through
`asRequiredStageFailure`, so the seven required-stage codes below are emitted as the single
`REQUIRED_STAGE_FAILURE` code and grade `INDETERMINATE`; the remaining rows are the bounded
omissions that keep their own code.

| Code | Category | Trigger/source | Status effect |
| --- | --- | --- | --- |
| `ANALYSIS_LIMIT_EXCEEDED` | LIMIT | Source/AST/CST/expression/taint/finding/scan cap | `DEGRADED`; some evidence may be omitted |
| `SOURCE_SPAN_UNAVAILABLE` | SOURCE | Hardened source location cannot be attached | `DEGRADED`; finding remains but lacks a span |
| `DUPLICATE_JSON_KEY` | SOURCE | Duplicate key reported by JSON source parser | `DEGRADED`; parsed value may not represent author intent |
| `MALFORMED_NODE_PARAMETERS` | SOURCE | Node has a non-object `parameters` value and is normalized to `{}` | `INDETERMINATE`; scored rules may have missed evidence |
| `UNSUPPORTED_CODE_NODE_VARIANT` | SOURCE | Unrecognized Code language/version or legacy variant | Emitted as `REQUIRED_STAGE_FAILURE` (`INDETERMINATE`); selected source was not analyzed and no grade is reported |
| `JAVASCRIPT_PARSE_FAILED` | PARSER | Acorn cannot parse selected JavaScript | Emitted as `REQUIRED_STAGE_FAILURE` (`INDETERMINATE`); code findings may be missed and no grade is reported |
| `JAVASCRIPT_SOURCE_UNAVAILABLE` | SOURCE | Selected JavaScript field is absent/non-string | Emitted as `REQUIRED_STAGE_FAILURE` (`INDETERMINATE`) |
| `PYTHON_SOURCE_UNAVAILABLE` | SOURCE | Selected Python field is absent/non-string | Emitted as `REQUIRED_STAGE_FAILURE` (`INDETERMINATE`) |
| `PYTHON_PARSE_FAILED` | PARSER | Lezer parse has errors or parser throws | Emitted as `REQUIRED_STAGE_FAILURE` (`INDETERMINATE`) |
| `PYTHON_PARSER_UNAVAILABLE` | PARSER | Reserved vocabulary for a missing parser implementation; no current emitter found in the current app source | Emitted as `REQUIRED_STAGE_FAILURE` (`INDETERMINATE`) if emitted |
| `EXPRESSION_PARSE_FAILED` | PARSER | Bounded taint expression segment is not parseable | Emitted as `REQUIRED_STAGE_FAILURE` (`INDETERMINATE`); that reference may be missed and no grade is reported |
| `POLICY_EXECUTION_FAILED` | POLICY | Policy throws or a finding fails canonical validation | `INDETERMINATE` |
| `GRAPH_ANALYSIS_DEGRADED` | GRAPH | Unknown/ambiguous/malformed graph connection | `DEGRADED`; path/gate/taint reasoning may be incomplete |
| `DUPLICATE_FINDING_COLLAPSED` | POLICY | Deterministically identical findings are merged | `DEGRADED`; repeated evidence is intentionally compressed |
| `UNCLASSIFIED_CONNECTION_TYPE` | GRAPH | Connection is neither reviewed `main`, `ai_tool`, nor reviewed context type | `DEGRADED`; it is excluded from taint/capability/context reasoning |
| `MALFORMED_CONNECTION_INDEX` | GRAPH | A connection target `index` is not a finite non-negative integer (fractional, negative, non-finite, or a non-number such as a numeric string); the edge is dropped rather than defaulted | `DEGRADED`; the edge is excluded from graph/taint reasoning instead of being silently coerced to `0` |
| `REQUIRED_STAGE_FAILURE` | POLICY | The shared code the v1 engines emit in place of a required stage's own diagnostic (unreadable or unparseable source, code-node variant, or expression) | `INDETERMINATE`; `riskAssessment`, `summary`, and `humanSummary` are omitted |

The hardened taint engine propagates only over `main`, has a bounded fixed point, records at most 50
taint findings per scan, and reports bounded traces up to depth 64. JavaScript and Python each cap
source bytes at 100,000, AST/CST work at 10,000 nodes, and findings at ten per source. Hardened
analyzer findings are capped at 100 per scan. These are omission signals, not clean outcomes.

## Privacy, redaction, and no-network assumptions

- The scanner worker has no `fetch`, XHR, WebSocket, beacon, or remote import path. It parses and
  analyzes the submitted string locally. The page may still fetch ordinary static site assets, and
  the browser/extension/host can observe its own memory or network; “nothing leaves” is limited to
  scanner workflow content and this app's scanner request path.
- Findings avoid echoing raw source and expression values. Structural evidence uses policy IDs,
  booleans, bounded indicators, parameter paths, node IDs/names, taint labels, and numeric spans.
- Canonical findings and the full presentation result pass redaction. Sensitive key names, provider
  token shapes, credential-bearing URL components/query parameters, and contextual email/phone
  patterns in pinned/sticky-note data are redacted. Redaction is pattern-based and does not discover
  every secret or every personal datum; the input itself remains sensitive in the browser while open.
- No analyzer executes JavaScript, Python, expressions, shell commands, SQL, or workflow nodes. A
  static finding is evidence of a shape, not proof that the branch executes or that an exploit works.

## Sources, versions, and unknowns

Retrieval date for the following official n8n sources: **2026-08-29** (not re-retrieved in the
2026-10-17 repository pass, so each row stays a dated retrieval claim). The documentation site is
current as retrieved but does not provide one runtime version for a submitted workflow. Claims below
are limited to the documented behavior and are not generalized to every n8n release.

| Source | Claim used |
| --- | --- |
| [n8n Security audit](https://docs.n8n.io/hosting/securing/security-audit/) | n8n's server-side audit covers credentials, database expressions, filesystem nodes, official risky/community/custom nodes, webhooks, security settings, and outdated instances; this scanner is narrower and local. |
| [Execute Command](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.executecommand/) | Execute Command runs shell commands on the n8n host/worker environment, is unavailable on Cloud, and is disabled by default from n8n 2.0 according to the current docs. |
| [Webhook](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.webhook/) | Webhook starts a workflow from received data and documents Basic, Header, JWT, and None authentication modes. |
| [HTTP Request](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.httprequest/) | HTTP Request targets an entered endpoint and recommends predefined credential types when available. |
| [Code node common issues](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.code/common-issues) | JavaScript module loading is deployment-dependent; n8n Cloud does not support importing modules, and Code nodes do not access the internal credential manager. |
| [Community-node risks](https://docs.n8n.io/integrations/community-nodes/risks) | npm community nodes are unverified code with machine and workflow-data access; verified community nodes and disabling options are separate n8n controls. |
| [Workflow sharing](https://docs.n8n.io/workflows/sharing/) | Shared-workflow editors can use the workflow's credentials and can view/run/export/update within documented permissions. |
| [Export and import](https://docs.n8n.io/workflows/export-import) | n8n workflows are JSON and can be imported through documented file, CLI-package, or API paths; the scanner treats submitted JSON as untrusted input and makes no generic URL-import claim. |
| [Human-in-the-loop for AI tool calls](https://docs.n8n.io/build/integrate-ai/ai-examples/human-in-the-loop-for-tools) | n8n documents approval/denial before selected AI tools execute, including higher-risk actions such as messages, record changes, and purchases. |
| [n8n 2.0 breaking changes](https://docs.n8n.io/2-0-breaking-changes/) | Code runtime, environment access, task runners, Python, Execute Command, and filesystem defaults are version-sensitive. |

Exact-shape evidence for the current fixtures is pinned to official n8n source commit
[`1aa604d26548e8d23d5d8dff9f8f3fe762ed24c4`](https://github.com/n8n-io/n8n/tree/1aa604d26548e8d23d5d8dff9f8f3fe762ed24c4),
captured 2026-08-06, as recorded in
`app/src/scanner/__fixtures__/n8n-exports/manifest.ts` and the reviewed gate catalog. It is not a
claim that all n8n versions share those exact node shapes. The app pins Acorn `8.17.0` and
`@lezer/python` `1.1.19`; n8n is not an app dependency, so no n8n runtime version is detectable from
the scanner input alone.

## Maintenance and version guidance

1. Treat `scannerVersion`, `policyProfile`, result schema, and limits schema as a compatibility tuple.
   A policy ID/effect/severity/confidence/remediation change requires the inventory, fixtures, and
   release notes to move together. A scoring change also requires the scoring ADR and old-versus-new
   differential described by the Phase 2 plan — no scoring ADR is recorded in `docs/decisions/` yet —
   so never silently promote report-only evidence into the score.
2. When n8n changes Code-node runtime, node type/version fields, connection types, Webhook auth,
   Execute Command, filesystem, community-node, credentials, or AI approval behavior, re-read the
   relevant official docs and the exact n8n source at a recorded commit. Update selection, taxonomy,
   source/taint/sink/gate catalogs, focused tests, and this inventory in one review.
3. Keep unknown node types, connection types, gates, and dynamic references on the conservative
   reporting/degraded side. Adding a suppression or widening a sanitizer requires evidence that the
   submitted workflow cannot turn that claim off by changing its own JSON.
4. Re-check the no-network worker bundle and redaction boundary whenever parser or dependency
   versions change. A parser upgrade is not proof of broader n8n compatibility.
5. Re-date this document and record the new docs/source versions, retrieval date, and unresolved
   unknowns. Never convert an unverified n8n behavior into a universal security claim.
