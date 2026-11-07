# Changelog

All notable changes to n8n SecureFlow — the scanner, the CLI, the catalogue site, and the
pipeline that builds it.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). This project has not
cut a public release yet, so everything below sits under **Unreleased**. The first tagged version
will be `0.2.0`, cut when the release blockers in [`STATUS.md`](STATUS.md) are closed.

Entries are grouped by what a reader would notice, not by which workspace changed. Where a change
closes an audit finding, the finding's ID is cited so the evidence in
[`docs/audit/2026-09-04/`](docs/audit/2026-09-04/) stays reachable.

## [Unreleased]

- **`sfscanner@0.2.0` and the v2 corpus are ready to publish — privacy-sanitized at the publication
  root.** The catalogue now carries admitted v2 native results only: 11,376 results (83 complete,
  11,098 degraded, 195 indeterminate) from 11,394 attempted inputs, 18 explicit `NO_RESULT` engine
  refusals, 3 inputs missing and 67 owner-ruled source-unavailable entries. Email addresses in
  descriptions and author display names are withheld as `[email]`; private, loopback and internal
  endpoints are withheld as `[private endpoint]` while requirement rows keep their kind and count.
  JSON-LD omits a withheld author rather than claiming site authorship. The public dataset ships as
  `public-data-model-v3`, independent of the scanner version, with SQLite, Excel and 16 NDJSON
  relations bound to one release. Evidence: release gates, browser smoke at 320/768/1024/1440 and
  the packed CLI/MCP consumer checks in this release cycle.

- **The published scanner's types no longer depend on a private workspace.** `sfscanner`'s
  `dist/v2/help.d.ts` imported `@hub/contracts`, which the package neither ships nor depends on, so a
  strict `NodeNext` consumer failed with `TS2307`. The 26 limit names are now a closed local union
  and the contract comparison is type-only, so nothing is added to the runtime output. The
  `@hub/scanner-core` v2 SARIF emitter now reaches its sibling modules by relative path instead of
  through its own package subpaths, restoring the standalone boundary the source audit enforces.
  Evidence: [`167`](docs/audits/2026-10-19-production-readiness/167-scanner-contract-acceptance-closure.md),
  independently reviewed in
  [`169`](docs/audits/2026-10-19-production-readiness/169-final-closure-code-review.md).

- **Four gate regressions are closed at their cause, not their symptom.** The v1 and v2 oversized-
  payload rejections come from one helper with unchanged codes, key order and guard order; the SEO
  checker lost a dead predicate and a redundant branch; JSON-LD reuses the existing `capitalize`;
  `docs/CLI.md` re-wraps the SARIF-consumer sentence the doc-claim gate matches literally; and the
  ESLint config parses `.d.mts`/`.d.cts` with the TypeScript parser it already had. The
  end-to-end chart-integrity subject now reads the served `data/details/` shard, so the fixture
  matches the export instead of the pruned `catalogue-N.json` (test-only; no runtime change). No
  ignore, no disabled rule, no dependency added. Evidence:
  [`168`](docs/audits/2026-10-19-production-readiness/168-web-gates-acceptance-closure.md) and the
  one carried LOW in
  [`171`](docs/audits/2026-10-19-production-readiness/171-final-surgical-ts-closure.md).

- **The canvas toolbar and node list show where keyboard focus is.** Three controls — the SVG
  download button, the Popout button and the node-list `<summary>` — carried
  `focus-visible:outline-none` with no replacement ring, so tabbing the canvas reported position to
  nobody (WCAG 2.4.7). Deleting that one utility per control lets the shipped global `:focus-visible`
  rule paint the same 2 px ring the sibling zoom control already had; no new class, no CSS change.
  Static disposition is [`153`](docs/audits/2026-10-19-production-readiness/153-keyboard-focus-review-closure.md);
  the browser RED (pre-fix export) and GREEN are
  [`154`](docs/audits/2026-10-19-production-readiness/154-keyboard-focus-runtime-fix.md).

- **The composite scan action builds a pinned scanner checkout instead of the caller's
  workspace.** `uses: …/.github/actions/scan` now takes a required `scanner-ref` (full 40-hex
  commit; branches, tags, short and uppercase hex fail closed with exit 2 before any checkout),
  checks the scanner out at `.scanner-source` with `persist-credentials: false`, installs and builds
  there only, and excludes that checkout from the default `path: '.'` scan so its own JSON cannot be
  consumed as caller input. The example keeps both references at all zeros, labelled
  `BLOCKED — no published scanner commit`, until one published commit can replace both. Evidence is
  in [`152-action-source-isolation-implementation.md`](docs/audits/2026-10-19-production-readiness/152-action-source-isolation-implementation.md).

- **A graded v2 scan now shows the grade the worker actually returned, and its exports carry that
  same result.** The v2 report mounts the existing decision block for every model, and report
  completeness consults the attached worker status/assessment instead of the compatibility
  projection (which has no producer for `workflow.risk-summary.v1`, so every real envelope looked
  `INDETERMINATE`). Findings status copy uses the same v2 authority. Browser JSON exports the real
  v2 envelope, and SARIF now uses the accepted v2 builder (moved to
  `@hub/scanner-core/report/sarif-v2`, CLI imports migrated with no shim) with the browser's
  `analysisStatus`/`riskGrade` run properties. The non-hydrating lean tier honours the advertised
  Ctrl/⌘ wheel, Popout now carries the explicit 44 px width floor, and the scanner guide no longer
  claims a ten-findings-per-code-source cap no shipped analyzer enforces. Evidence is in
  [`146-browser-grade-root-fix.md`](docs/audits/2026-10-19-production-readiness/146-browser-grade-root-fix.md).

- **Scanner governance docs now match the shipped binary, and two gates prove it.**
  `--fail-on` is documented as `INFO`, directory scans show `--schema v2`, the MCP client config uses
  the installed `<npm-root>/sfscanner/dist/mcp.js` with `npm root -g`, `beta-hardened` is described as
  defined but not admitted or selectable, and the v2 input-path examples no longer carry a private
  checkout path. A new lightweight `check:scanner-doc-claims` gate rejects affirmative
  support/default/profile/private-path claims while accepting documented negatives. `ATTRIBUTIONS.md`
  now credits the 67 retained `murataslan1/n8n-workflow-collection` entries in an excluded-source
  section (11,397 active + 67 = 11,464 canonical), states the 13,221 public acquisition count
  separately, and records the public CC BY-SA 4.0 metadata line as an unresolved public-only defect;
  `check:attribution-basis` verifies the register against `pipeline/sources.json` and
  `data/analytics.json`, the licence authority, and real `git check-ignore` scopes, and
  `check:attributions` runs the generator's own `--check` in `CORE_GATES`, so a per-source count that
  drifts from `data/catalogue-*.json` fails even when the row sums still add up. Evidence is in
  [`149-private-governance-accuracy-implementation.md`](docs/audits/2026-10-19-production-readiness/149-private-governance-accuracy-implementation.md)
  and [`157-attribution-gate-closure.md`](docs/audits/2026-10-19-production-readiness/157-attribution-gate-closure.md).

- **The scanner now states which limits are enforced, dormant, or unwired, and reports only budgets
  it actually measured.** `ADMITTED_LIMIT_STATES` in `contracts/scanner-limits-v2.ts` classifies all
  26 `ScannerLimitsV2` fields once (19 `WIRED`, 5 `DORMANT`, 2 `UNWIRED`); `MEASURED_LIMIT_IDS`
  names the 13 with a per-scan counter. Result `limits.usage` emits only those 13 rows, so a
  dormant, unwired, or unmeasured budget can no longer appear as an `examined: 0` maximum, and
  `--help` derives each budget's state from the same authority. The limits document and digest
  still cover all 26 fields. The capacity boundary is pinned from the engine's own result: 5,000
  nodes admitted, 5,001 refused `WORKFLOW_TOO_COMPLEX`/`NODE_LIMIT`, and stored-span loss at
  2,083/2,084 is presentation-only (`OPTIONAL_LIMIT_EXCEEDED` with the assessment retained). The
  scanner guide no longer claims the shipped profile parses JavaScript/Python, tracks value flow,
  or runs AI-agent checks, and states there is no 24-node workflow cap. Evidence is in
  [`145-scanner-limits-coverage-implementation.md`](docs/audits/2026-10-19-production-readiness/145-scanner-limits-coverage-implementation.md).

- **The privacy gate and dataset identity now reject ambiguous input instead of guessing.**
  `scripts/check-public-bundle-privacy.mjs` parses an allowlist: `--bundle=<dir>`, unknown arguments,
  and a missing or repeated `--bundle` each exit 1 with a named reason before the bundle or baseline
  is read, so a bad flag cannot capture a baseline from the default tree. Identity verification
  requires a non-empty `releaseId` in the shipped `releases` row and fails with `INVALID_BUNDLE` when
  it disagrees with `public-release.json`; a null `counts` or `facetCounts.rights` is typed the same
  way instead of throwing a `TypeError`. The promotion runbook states that a `CI=true` labelled skip
  for absent bodies is not a verdict. Evidence is in
  [`143-data-post-review-root-fix.md`](docs/audits/2026-10-19-production-readiness/143-data-post-review-root-fix.md).

- **Six web post-review defects are fixed at their shared roots.** The diagram canvas now binds one
  native, non-passive `wheel` listener on its own viewport instead of a React synthetic handler that
  React's passive root listener discarded: `Ctrl`/`⌘`+wheel and any wheel inside the expanded dialog
  zoom the canvas and cancel the browser's scroll/zoom, while a plain wheel over the inline canvas
  still scrolls the page. All six toolbar controls measure at least 44×44 CSS px and wrap inside a
  320 px viewport without clipping or document overflow. The expanded diagram only dismisses on a
  click outside the dialog's own rectangle, so its padding and scrollbar no longer discard zoom, and
  each instance names its title with `useId()`. The release-parity gate now accepts a URL only when
  it is same-origin and either the exact base path or a slash-boundary descendant, so
  `…/repository/` and `…/repo-evil` fail while `…/repo/library/` passes. The download reader rejects
  a redistributable record with no published 64-hex digest before any request instead of serving
  unhashed bytes, and `verifyPackedRecord` fails closed on an absent digest. The shared catalogue
  loader rejects a loaded total that disagrees with the manifest's `totalEntries`, so a declared but
  renamed shard stops the export instead of silently shrinking it. Evidence is in
  [`139-web-post-review-root-fix.md`](docs/audits/2026-10-19-production-readiness/139-web-post-review-root-fix.md).

- **A promoted public bundle now has its own privacy gate, and a legacy bundle says it is legacy.**
  `scripts/check-public-bundle-privacy.mjs --bundle <dir>` reads exactly the requested bundle,
  validates its `public-data-model-v2` manifest (sixteen distinct known relations, each path exactly
  `<relation>.ndjson` inside `ndjson/`, no duplicates, unknowns, traversal or misplaced entries),
  rejects missing shards, malformed rows, blank lines and a missing final newline, and then sweeps
  every string leaf of all sixteen relations. It reports matcher totals plus field paths and
  affected-field counts — never a matched value — and exits 0 only against a valid totals-only
  baseline with nothing above it; with no baseline, or a malformed or incomplete one, it fails
  closed. `--write-baseline` remains an owner-authorized (O-2) operation and was not run, and the
  gate is deliberately absent from `package.json` and `run-gates` until that baseline exists.
  `readBundleMetadata` now throws a typed `DatasetIdentityError`: `LEGACY_V1` tells a v1 bundle
  apart from corrupt v2 metadata with re-export guidance, while `INVALID_BUNDLE` keeps the
  malformed-bundle failure. The nine-step promotion runbook is in
  [`docs/releases/dataset-promotion.md`](docs/releases/dataset-promotion.md); promotion itself
  remains owner-gated (O-1) and has not run. Evidence is in
  [`137-data-privacy-identity-implementation.md`](docs/audits/2026-10-19-production-readiness/137-data-privacy-identity-implementation.md).

- **Exclusion wording now names the registry that exists, and a workbook read-back pins U+FFFD.**
  The data dictionary and release notes no longer claim the pipeline lacks an exclusion registry:
  they state that the upstream acquisition exclusion list is applied before candidates become
  entries, that no public per-entry exclusion or artifact registry is populated or projected, and
  that a nonzero excluded count is a corpus facet. Exclusion and artifact rows remain empty. A new
  Excel export/read-back regression writes U+FFFD alongside U+FFFE/U+FFFF and proves the workbook
  keeps the replacement character while removing the two XML 1.0-invalid code points.

- **The public data release now verifies every workbook part, refuses worksheet overflow, and counts
  all ten sheets from one source.** The Excel writer strips the XML 1.0-invalid U+FFFE/U+FFFF code
  points (U+FFFD stays), and verification sweeps all 15 `.xml`/`.rels` parts — the real bundle
  reports `XML parts verified 15` — rejecting any reintroduced invalid code point. A worksheet above
  Excel's 1,048,576-row limit now fails naming the sheet, and the guard runs after the three
  truncation-summary rows are appended, so the reported `sheetRowCounts` is the composed workbook.
  Bundle parity compares all ten sheets (eight relation-bearing plus README and Data Dictionary)
  against that same composition instead of a hardcoded seven-sheet map; the other eight relations
  remain NDJSON/SQLite-only, and the workbook is `.xlsx` only. The FTS build indexes the workflow
  joins in one pass, cutting measured join reads on the 120-workflow fixture from 105,840 to 5,880
  while keeping every `(tags, integrations, triggers)` cell and the logical hash byte-identical to a
  baseline captured before the change. Exclusions and artifacts now say exactly what they are:
  schema-reserved, registry-backed relations that stay empty, with a nonzero excluded count labelled
  a corpus facet rather than rows. Evidence, hashes and commands are in
  [`133-data-export-remediation-implementation.md`](docs/audits/2026-10-19-production-readiness/133-data-export-remediation-implementation.md).

- **The catalogue site now fails closed on release identity, declares downloads it cannot serve, and
  refuses to build a page list from missing artefacts.** A release export must be built with
  `NEXT_PUBLIC_SITE_URL` and a base path that agree; without an origin every canonical, OpenGraph,
  Twitter, JSON-LD and sitemap URL is omitted instead of defaulting to a host nobody owns, and
  `check:web-release` fails closed when the origin is missing. External product links render only when
  configured (never a guessed URL, never the label "GitHub (private)"). The expanded diagram is a native
  `<dialog>` with `Escape`, backdrop and Close paths and synchronous focus return, its copy describes
  only gestures that exist, and it measures at least 44 px per control at 320/768/1024/1440 px with no
  horizontal overflow. A chart shard is accepted only from an exact `Content-Range` and exact byte
  length, every failure after the artefact resolves names the release it came from, a host that answers
  `Range` with `200` costs one cancelled body and one bounded fallback (32 MiB, checked after the ranged
  attempt), and the rights gate now rejects a redistributable entry whose `download` lacks a 64-hex
  digest, disagrees with the manifest's offsets or lengths, or points at a pack over that bound. A
  catalogue shard the release manifest declares but the build cannot read stops the page list by name
  instead of silently shrinking it. Evidence, commands and the remaining owner blockers are in
  [`127-web-remediation-completion.md`](docs/audits/2026-10-19-production-readiness/127-web-remediation-completion.md);
  the release-identity journey stays `BLOCKED (B-07)` until the `app/app/public` duplicate is removed by
  its owner, and the public deployment journey stays `BLOCKED (B-01)`.

- **One tool identity now backs every CLI machine surface, and `version` publishes the engine's own
  build digest.** The scan JSON/NDJSON envelopes and the `rules`/`explain`/`profiles` documents share
  one `n8n-scan@0.1.0` tool digest, derived from the admitted engine, profile, ruleset, and semantics
  authorities instead of a frozen envelope literal, so a re-pin moves all surfaces together.
  `version.engine.buildDigest` now reports core's `ENGINE_BUILD_DIGEST_V2`, the same value every scan
  result already carries, instead of the tool hash. Exit codes, analysis statuses, findings, profile,
  ruleset, semantics, and limits identities, and secret redaction are unchanged. Evidence is in
  [`112-canonical-metadata-identity-correction.md`](docs/audits/2026-10-19-production-readiness/112-canonical-metadata-identity-correction.md).

- **Unknown workflow nodes now carry two labelled coverage codes, and common flow-control nodes are
  modelled.** A readable unmodelled node emits `SEMANTIC_CATALOGUE_MISS` and the new
  `GENERIC_NODE_UNMODELED_CAPABILITY`, both at `required:false`, at the same node pointer and in
  registry order, so the workflow is `DEGRADED` with its assessment and security findings retained
  while the unmodelled-capability assumption stays labelled. A genuinely unresolved node keeps only
  the miss at the caller's requiredness: required is `INDETERMINATE` with no assessment, optional is
  `DEGRADED` and does not null it by itself. Catalogue resolution now reads `/operation` first and
  `/action` when no string operation is present (suffix matching unchanged, operation wins a
  conflict, arbitrary actions are not modelled). The catalogue adds seven source-pinned records
  (`set`, `if`, `switch`, `merge`, `splitInBatches`, `scheduleTrigger`, `googleSheets`) with 28 new
  upstream receipt rows, for 32 records across 31 types, and the v1 crosswalk projects the new code
  as `POLICY_EXECUTION_FAILED`/`POLICY`/`DEGRADED`. `beta-default@2.0.0` still scores seven
  policies; the ten `beta-hardened` analyzers stay unadmitted. Evidence is in
  [`100-semantic-fallback-catalogue-remediation.md`](docs/audits/2026-10-19-production-readiness/100-semantic-fallback-catalogue-remediation.md);
  browser and independent runtime acceptance remain pending.

- **The published scan command's `profile` is the canonical admitted id, not the raw CLI spelling.**
  `parseCliArguments`/`parseArgumentsV2` now store `beta-default` in the command for both admitted
  spellings, while the raw `beta-default@2.0.0` specifier stays in `cliOverrides` so the invocation's
  profile source is still `CLI`. The exported `CliProfileV2` narrows to the canonical admitted id and
  the unsafe cast that hid the mismatch is gone, so a strict NodeNext consumer sees the value the
  parser actually returns; `beta-hardened` remains a usage error and no profile was added. Scan
  output, exit codes, and config canonicalization are unchanged. Evidence is in
  [`94-cli-public-profile-type-fix.md`](docs/audits/2026-10-19-production-readiness/94-cli-public-profile-type-fix.md).

- **Output containment is resolved-base containment, and a selected file is identified by its resolved path.**
  An output path's parent must now resolve inside the resolved selection root: an ancestor link that
  resolves outside the root is rejected before any temporary file or rename, and the outside
  destination is neither created nor overwritten, while a symlinked selection root and an in-root
  ancestor link keep working. Absolute directory inputs outside the selection root now read the
  selected resolved file instead of reconstructing a same-label path under the base, so a colliding
  same-label file can no longer be scanned silently; absolute inputs remain admitted and labels remain
  relative. The absolute base itself is labelled without its basename prefix, so `.` and the absolute
  spelling produce the same labels. Evidence is in
  [`80-cli-path-containment-identity-fix.md`](docs/audits/2026-10-19-production-readiness/80-cli-path-containment-identity-fix.md).

- **The published CLI is importable, and its admitted flags now do what they say.** The package
  ships an ESM-only root export with `{types, import}` conditions and `main: ./dist/index.js`, whose
  import runs no scan and starts no MCP transport; the four existing subpaths keep their names. A
  clean-room install proves a strict `NodeNext` consumer (`skipLibCheck: false`, `types: []`) resolves
  only the shipped declarations, and the installed `sfscanner-mcp` bin serves
  `initialize`/`tools/list`/`tools/call` through npm's Windows `.cmd` shim (the POSIX `.bin` symlink
  remains unexercised there). `--limits <file>` and `--target <file>` are loaded, bounded, validated
  against the engine's own configuration vocabulary, and applied to the scan, and repeatable
  `--approved-domain <host>` reaches the real `UNAPPROVED_DOMAIN` path. v2 input admission now accepts
  local absolute paths and `.` while labels and SARIF URIs stay relative, a symlinked output ancestor
  that resolves to a directory is allowed while a symlinked output target stays refused, and relative
  and absolute spellings of one file deduplicate by real path. The v1 reader uses the shared
  `maxWorkflowBytes` ceiling before allocation and reports invalid UTF-8 as `INPUT_READ_FAILED`, and v1
  findings now carry source spans so SARIF emits physical locations; every SARIF rule descriptor
  carries a `helpUri` anchor, and a completed DEGRADED/INDETERMINATE item is a successful invocation.
  Evidence is in
  [`74-cli-packaging-contract-cutover.md`](docs/audits/2026-10-19-production-readiness/74-cli-packaging-contract-cutover.md).

- **Webhook authentication is exact-match again, because the pinned runtime is.** The pinned
  `n8n-nodes-base@2.15.1` `dist/nodes/Webhook/utils.js:205-289` compares `authentication` with strict
  equality and has no final `else`, so `BASICAUTH`, `" basicAuth "`, or `oauth2` reaches the handler
  unauthenticated. The scanner previously trimmed and case-folded that value, which suppressed
  `WEBHOOK_EXPOSURE` for those workflows; only the exact `basicAuth`/`headerAuth`/`jwtAuth` strings
  now count as authenticated, and the case/whitespace/unknown variants are reported as MEDIUM. The
  quoted-token expression scan also keeps the raw `\` pair instead of deleting the backslash, so an
  escape such as `\n` can no longer splice a fabricated provider token. The published-schema test now
  resolves `ajv@^6.15.0` from a declared `@hub/pipeline` devDependency (lockfile updated offline), and
  the MCP installed-shim comment states the real proof boundary: Windows name-variant entry handshake
  proved; Windows `.cmd` and POSIX `.bin` still unexercised. Evidence in
  [`54-community-security-correction.md`](docs/audits/2026-10-19-production-readiness/54-community-security-correction.md).

- **v2 fact IDs hash the canonical fact, so webhook authentication findings survive the pipeline.**
  A policy finding whose ingress fact carried a malformed `authentication` spelling (`" basicAuth "`,
  `basicAuth `, `jwtAuth\r\n`) was hashed over the raw property, while the safe-fact validator
  quarantines that property to `authenticationState: UNKNOWN` before it recomputes the ID. The
  mismatch rejected the fact, the required `structural-policies` capability failed, and the whole
  item returned INDETERMINATE with no `WEBHOOK_EXPOSURE` even though the policy had reported it.
  The ID now hashes the properties the validator admits through one shared canonicalisation (an
  identity for every admissible fact), so those spellings report MEDIUM through the real CLI and
  MCP with exit 0 at `--fail-on CRITICAL` while the exact three raw names stay protected. Evidence
  is in
  [`66-webhook-fact-canonicalization-fix.md`](docs/audits/2026-10-19-production-readiness/66-webhook-fact-canonicalization-fix.md).

- **v2 scans can no longer outrun their per-input deadline.** Each v2 scan now runs in a dedicated
  built worker (`dist/scan-worker.js`) resolved through the package's private
  `#sfscanner-worker` import map, so synchronous scan work is preempted and terminated at the
  deadline, on cancellation, and on error instead of blocking the CLI. A missing worker asset or a
  worker failure is a closed per-item failure, never an in-process fallback or a false clean result;
  the read and the scan share one deadline. The built asset is the only worker copy (there is no
  `dist/v2` duplicate), and the packaged tarball and the `sfscanner` bin both start it. A normal
  per-item result now waits for the owned thread to exit, and a termination failure is reported as
  `FAILED` because the exit is unproven; the message/error/exit handlers are armed before the
  post-construction abort check, and the scanner-cli suite builds `dist/` once in project setup
  instead of racing an in-file rebuild. Evidence is in
  [`48-worker-isolation-execution.md`](docs/audits/2026-10-19-production-readiness/48-worker-isolation-execution.md),
  [`55-worker-lifecycle-correction.md`](docs/audits/2026-10-19-production-readiness/55-worker-lifecycle-correction.md),
  and
  [`60-worker-termination-rejection-correction.md`](docs/audits/2026-10-19-production-readiness/60-worker-termination-rejection-correction.md).
- **Scanner core false-negative fixes (audit SEC-01/02/03/04, BUG-01).** Redaction now covers
  token/password/pass/pwd keys, all four paired header-value fields, non-HTTP credential URLs
  including malformed authorities, and Stripe restricted `rk_live_`/`rk_test_` keys while keeping
  near misses and non-secret lookalikes visible. Unknown-package deduplication no longer inherits
  `Object.prototype` names. Expression islands no longer suppress adjacent literal secrets, header
  names are trimmed across the four value shapes, and webhook authentication is limited to the
  pinned `basicAuth`/`headerAuth`/`jwtAuth` enum. A lone RFC 7235 auth-scheme token beside a
  managed `{{ $credentials.… }}` reference now produces the INFO header signal instead of HIGH, and
  a complete provider token inside a quoted expression string is reported as a raw secret. Python
  keeps findings parsed before a later syntax error; JavaScript remains explicitly all-or-nothing;
  the core reduction now emits `REQUIRED_STAGE_FAILURE`/`INDETERMINATE`, and the published CLI
  schema accepts that `INDETERMINATE` shape. Focused RED/GREEN, probes, and timestamps are in
  [`27-core-security-implementation.md`](docs/audits/2026-10-19-production-readiness/27-core-security-implementation.md);
  the correction evidence is in
  [`47-core-policy-schema-execution.md`](docs/audits/2026-10-19-production-readiness/47-core-policy-schema-execution.md).

- **`sfscanner@0.1.0` published on npm.** The standalone scanner CLI and MCP server are published
  on the public npm registry under `sfscanner`, providing deterministic offline workflow analysis via
  `npx sfscanner scan <file>` and MCP server integration via `sfscanner-mcp`.
- **MCP server boundary hardening.** Invalid `n8n_scan` arguments now answer JSON-RPC `-32602`
  instead of crashing the server or reaching the CLI: `format`/`failOn` are type- and enum-checked,
  `inputs` requires at least one path, and client values can no longer inject CLI options — inputs
  are file paths after `--`, and `include`/`exclude` entries beginning with `-` are refused — so an
  injected `--output` cannot overwrite a file. Console output of every
  method is redirected to stderr, and the 1 MiB stdio frame cap now counts JSON content for both LF
  and CRLF clients. Focused MCP tests: 33 pass; evidence in
  [`26-mcp-critical-fixes.md`](docs/audits/2026-10-19-production-readiness/26-mcp-critical-fixes.md).
- **The `sfscanner-mcp` bin starts the server when installed.** The entry check now compares the
  module's real path instead of a `mcp.js` filename suffix, so npm's POSIX `node_modules/.bin`
  symlink serves `initialize`/`tools/list`/`tools/call` instead of exiting 0 with no response.
  Importing the module stays side-effect-free, and the advertised schema now states the
  dash/dash-glob policy. Focused MCP suite: 37 pass, 1 skipped (Windows symlink privilege);
  packed verifier named-entry probe passes, POSIX `.bin` execution remains unexercised on the
  Windows gate. Evidence in
  [`42-mcp-entry-execution.md`](docs/audits/2026-10-19-production-readiness/42-mcp-entry-execution.md).
- **The web scanner now shows a real in-flight state.** Submitting a workflow renders a status with an
  elapsed timer and a working cancel, replacing a disabled button that gave no sign of progress or of how
  long the wait might be. The cancel path aborts the worker rather than leaving it to finish.
- **A node type absent from the semantics catalogue no longer fails the scan.** The engine resolves an
  unmodelled node conservatively and grades the workflow instead of withholding the assessment because one
  node was unknown. The judgement and its limits are in
  [`ADR-generic-node-semantic-fallback`](docs/decisions/ADR-generic-node-semantic-fallback.md); the
  published catalogue is deliberately still v1, so its stored verdicts predate this change.
- **A complete emitted-worker safety audit.** The gate resolves and hashes every chunk reachable
  from the scanner worker, including its payload closure, and tests forbidden calls inside template
  substitutions. It recognizes only the reviewed Webpack process-browser wrapper emitted for
  `@lezer/lr`'s optional parser-tracing check; other process-global access remains a violation.
- **The ink-teal and amber design language**, applied across the site from one file, with light as
  the default. New tokens for the shared band treatment, the categorical node families, and — the
  ones that matter — `accent-text` and `accent-border`, because amber is 1.51:1 on white and fills
  shapes rather than carrying words.
- **`npm run check:accent-usage`** — a gate on the *role* a colour token is used in, not its value.
  `check:contrast` proves the palette is sound; this proves it is used soundly, which is the half
  that broke when 103 components' `text-accent` turned unreadable overnight.
- **A GitHub Action** (`action.yml`) that scans a repository's workflow JSON and emits SARIF for
  code scanning, plus an example workflow showing the `upload-sarif` wiring.
- **SARIF in the standalone CLI.** It emitted JSON only, so the SARIF the README promises now comes
  from one shared builder in scanner-core rather than from two that could disagree.
- **`app/e2e/detail-subjects.ts`** — chooses end-to-end subjects from the corpus by page type
  instead of by hardcoded id, so a corpus change no longer breaks twenty specs that were testing
  something else.

- **`npm run export:public-dataset`** — the whole catalogue as SQLite (207 MB, with an FTS5 index),
  Excel (26 MB, ten sheets) and 16 NDJSON streams. 11,464 workflows, 28,016 findings, 130,972
  requirements, 2,105 external domains, 319 community node packages. Deterministic: two runs are
  byte-identical. The exporter existed and was tested; nothing had ever invoked it.
- **`npm run typecheck:scripts`** — `scripts/` holds 18 TypeScript files including the corpus
  re-packager and was covered by no typecheck at all, because the gate walks the five npm
  workspaces and `scripts/` is not one.
- **A rewritten README** that opens with why the project exists — 57 OWASP-tracked advisories,
  CVE-2026-33663, 321 instances exposed by leaked tokens, each linked — then three quickstarts, the
  full seventeen-rule table with CWEs, the measured catalogue, and the dataset.

- **Open-source hygiene for the public repository.** Issue templates for a bug, a feature request,
  and — the one that matters for a scanner — a **false-positive report**, with a dropdown of all
  seventeen real rule IDs and explicit instructions never to paste a real workflow. A pull-request
  template. `CODEOWNERS` and `GOVERNANCE.md` with the placeholders filled by what is true: one
  maintainer, and an independent rights/legal reviewer role left explicitly **unstaffed** rather
  than assigned to the same person.
- **`SECURITY.md` states a response expectation one person can actually meet** — seven-day
  best-effort acknowledgement, no fixed SLA — and says plainly that there is no independent
  security reviewer. GitHub Private Vulnerability Reporting is the preferred channel.
- **`THIRD_PARTY_NOTICES.md` is verified rather than assumed.** It was a scaffold nobody had
  checked against the real dependency tree. Now a dated table of the **36 installed production
  dependencies**: 23 MIT, 5 Apache-2.0, 3 ISC, 1 BSD-3-Clause, 1 CC-BY-4.0, 1 0BSD, and 2 carrying
  `Apache-2.0 AND LGPL-3.0-or-later` — `sharp`'s bundled `libvips` binary, the standard prebuilt
  distribution pattern for an LGPL native library, which does not reach this project's own MIT
  code. **No GPL, AGPL, or SSPL dependency exists.**
- **`SOURCE.md` in the public repository**, recording the upstream commit each extraction came from
  and which commands cannot pass there and why.
- **`npm run check:rights-invariant`** — proves against the packaged artifacts, not the contracts,
  that no workflow body ships with an entry that may not be redistributed. 11,176 link-only, 288
  redistributable, zero violations.
- **`npm run check:corpus-privacy`** — counts personal and credential-shaped text in everything the
  site publishes, and never prints a value. Baseline: 7 email addresses (every one a generated
  illustrative example), 0 tokens, 0 private IPs, 0 internal hostnames.

- **CWE mappings on every scanner rule**, plus OWASP Agentic categories on the two agentic rules,
  surfaced in SARIF as `external/cwe/cwe-###` tags — the form GitHub code scanning actually
  recognises, not a bare `CWE-78` string. `UNAPPROVED_DOMAIN` deliberately carries no CWE and says
  why: it fires on any URL outside an allowlist, including one the author hardcoded, so CWE-918
  (SSRF) would be a claim the rule cannot support. The exception is a named constant with a test,
  never a silent skip. (Findings B-02, H-04.)
- **`npm run check:regex-safety`** — a ReDoS gate over every regex in the scanner surface: nested
  quantifiers and overlapping alternation under a quantifier. 73 regex sources across 101 files
  were audited three ways (structural detector, line-by-line review, and an adversarial benchmark
  at the full 1,536,000-byte workflow budget). **Zero were vulnerable**, which is the honest
  result; the gate exists so the next one cannot land quietly. (Finding B-09.)
- **`npm run check:contrast`** — computes WCAG contrast for every palette token against every
  surface it can land on, and encodes the standing rule that the structural colour never carries
  copy. In `CORE_GATES` and the source sequence.

- **`scripts/repackage-from-data.ts`** — re-packages the committed corpus from `data/` itself
  through the real packager, for when the acquisition work directory is gone and raw workflow JSON
  is retained for only the redistributable entries. Writes to a staging directory; promotion is a
  separate, deliberate step that keeps a rollback copy.
- **`scripts/build-quarantine-report.mjs`** — a diagnostic that explains *why* an entry's graph
  cannot render. Not the artifact producer; running it is how the id-collision defect above was
  found.
- **`npm run gates:source`** — a gate sequence for the standalone scanner repository, which ships
  source without the packaged corpus. Fifteen corpus-independent gates, derived from
  `CORE_GATES` by exclusion so a newly added gate is included by default and fails loudly rather
  than being silently skipped. (Finding F-03.)
- **`npm run test:source`** — the corpus-independent test projects: `scanner-core`, `scanner-cli`
  and `contracts`. 309 tests.
- **A Vitest project for `packages/scanner-cli`.** Its only test file existed, was committed, and
  passed when run directly — but no project collected it, so `npm test` never ran the tests
  guarding the artifact intended for npm.
- **`scripts/vitest-project-coverage.test.mjs`** — asserts every workspace containing tests has a
  Vitest project, so that gap cannot reopen.
- **`scripts/lib/doc-referenced-paths.mjs`** — a documentation gate that a document may not name a
  source path that does not exist. Added because the repository-root `CLAUDE.md` described a
  Supabase/Drizzle server application for weeks, naming six source files that were never present,
  while every existing documentation gate stayed green.
- **`docs/DESIGN.md`** — the design-token architecture, both mode palettes, the severity and risk
  ramps, and the measured contrast defect C-01.
- **`docs/scanner/`** — a complete scanner documentation suite: README, architecture, limitations,
  and a policy inventory expanded from 24 to 328 lines with minimal triggering examples per rule.
- **Operational scanner documentation for v2 rule authoring, security/disclosure, release, deferred
  key rotation, and deprecation.** The pages record the admitted built-in authority, closed
  `FACT_EXISTS`/`PROPERTY_EQ`/`PROPERTY_IN`/`ALL`/`ANY`/`NOT` language, strong `UNKNOWN` semantics,
  offline reporting boundary, v1-authoritative rollback, and owner-gated external release steps.
  They explicitly do not claim custom-pack/signature authority, beta-hardened v2 admission,
  publication, deployment, or external sign-off.
- **`docs/decisions/ADR-deterministic-scanner-findings.md`** — records the invariant that a
  finding, a severity, a grade, and a rights decision are produced only by deterministic code, and
  never by model output.
- **`docs/audit/HISTORY.md`** — a recovery index for every removed audit packet, with the commit
  and the `git show` command to retrieve each one.

### Changed

- **The scan deadline moved from 5 s to 30 s across the engine, the CLI runner and the web worker.** 5 s
  was the binding ceiling on a real scan rather than a safety margin: a 4,900-node chain needed 7.13 s and
  was reported as `SCAN_TIMEOUT` while using 22.2% of its compute budget. The new value is uniform across
  all three hosts so the same workflow cannot pass in one and fail in another.
- **Reverted the September 23 scanner-sidecar exclusion from `check:data-sync` during recovery.**
  Commit `a35aa87` reverses `60a3d0f`; the gate again reports the three unowned scanner sidecars.
  Phase 6.1 remains open until ownership and scanner freshness are resolved under the active plan.
- **Homepage search stays lazy until a visitor focuses or types in the search box (FE-10).**
  Checkpoint review found that the footer's Library link could prefetch the route when scrolled into
  view, which could load search code before intent. Footer links now disable automatic prefetch, and
  the expanded fresh-export Chromium test passes 1/1 (9.8 seconds test time; 12.0 seconds total):
  it observes no search client/data requests during 3.5 seconds of initial idle and another 3.5
  seconds after scrolling the footer Library link into view, checks 320/768/1024/1440 widths, then
  verifies focus warm-up, pending feedback while the index response is held, and results after
  release with one primary index request. FE-01 runtime measurement and the rest of Phase 4.3
  acceptance remain open.
- **A session handoff master prompt** now records the current readiness checkpoint, evidence,
  blockers, user decisions, repository invariants, and next plan tasks for a fresh Codex session.
- **FE-02's missing font preload optimization is confirmed in the fresh export.** There are no font
  preload links despite 15 self-hosted WOFF2 assets (including three `.p.woff2`) and CSS `@font-face`;
  Next's default preload is enabled, but the app/pages entries in `next-font-manifest` are empty.
  The root cause is unproven; the Windows-specific explanation remains an inference. The remedy must
  use a supported Next fix rather than flipping unsupported configuration. The no-font comment in
  `app/app/layout.tsx` was corrected to identify that statement as historical; runtime behavior is
  unchanged.
- **Scanner-core graph dominator views preserve the public `ReadonlySet<number>` contract.** The
  bitset-backed view supports read iteration and modern read-only set operations; focused tests and
  scanner-core typecheck pass.
- **Lean workflow pages share one content-hashed behavior asset** instead of repeating the same
  interaction script in every page. The fresh export keeps the early theme bootstrap inline and
  passes the HTML budget with roughly 40 MB of headroom.
- **Severity and chart colors use role-specific tokens** checked against both themes' actual
  surfaces. The updated contrast gate covers 114 pairs; keyboard and deployed-browser checks remain
  part of the open Phase 4 verification.
- **Library query state now follows the React hydration contract.** The static default tree is used
  for server rendering and hydration, then URL state is read through a subscribed external store.
  History writes and back/forward navigation update the same snapshot; saved-filter validation
  blocks stale deep-link results while it checks the current release.
- **`CLAUDE.md` now describes the product that exists.** It previously documented a server, an
  ORM, hosted Postgres, and row-level security, none of which were ever built. Every command and
  path in it is now verified against `package.json` and the filesystem.
- **`docs/ARCHITECTURE.md`** rewritten: it described three workspaces and pre-dated the
  `scanner-core` extraction.
- **`STATUS.md`** rewritten against 2026-09-04 evidence, with five disproved claims corrected and
  seven release blockers added.
- **`README.md`'s deploy section is accurate again.** DOC-GATE-2 reported
  `.github/workflows/deploy.yml` as missing and the README was edited to say deployment was manual.
  Both the report and the edit were wrong: the workflow exists at the **repository root**, exactly
  where the README said, and the gate was resolving documentation paths only against
  `community-hub/`. The gate now also resolves against the git repository root, and the README once
  again describes the GitHub Pages workflow and the `release:gates` run that precedes it.
- **Two scanner gates now actually run.** `check:scanner-docs` and `check:scanner-core:bare-node`
  both passed but appeared in no sequence, so nothing would have caught them going red. Both are
  now in `CORE_GATES`. (Finding G-07.)

### Fixed

- **Two documents no longer claim that a stored catalogue grade and a local reproduction come from one
  implementation.** `README.md` and `docs/ARCHITECTURE.md` both carried that sentence while the analytics
  page already said the opposite. The engine *code* is genuinely shared — that part was always true — but a
  stored result keeps the scanner identity recorded on its entry, which may be an older engine than the one
  currently shipped, so a stored verdict is only as new as the identity it names.
- **A workflow whose finding-bearing node was named like an error is gradable again.** A node label such as
  `Error: boom` was passed through the engine's own failure-shape detection, which turned a *label* into
  what looked like an engine failure and left the workflow `INDETERMINATE`. Labels are now sanitised by
  class — credential-shaped spans redacted to a fixed point, failure-shaped text escaped — and findings are
  located by `ordinal` and `identityDigest` rather than by label text, so a consumer never has to match on a
  name that sanitisation may have changed.
- **`check:scanner-source-claims` failed on a documentation sentence.** The scanner limitations page
  described a redacted label as a "visible placeholder", and the gate rejects the bare token `PLACEHOLDER`
  in every authoritative document — the wording was the defect, not the gate. It now reads "visible
  replacement marker" and the gate passes.
- **The 1,791 bodyless entries no longer present their historical values as current ones.** Every
  one of them carries a `readiness.analysis: "unscanned"` report, and the detail page said so once,
  in a banner above value groups that still read as live: `Compatibility notes` showed an n8n target
  version, `External hosts contacted` showed the hosts, and the replaceable-value, write-action and
  AI-model cards showed theirs. Each affected group now carries its own provenance line
  (`app/src/ui/detail/readiness/readiness-section.tsx`), rendered only when the report says
  `unscanned`, so a scanned entry's markup is byte-identical to what it was. The labels are plain
  paragraphs, not live regions: three new `role="alert"` regions around one report would announce on
  arrival and again on every re-render, so the section keeps the only real alert.
  The static lean pages are unchanged because they never rendered these lists — `DetailLean` emits
  only the "Before you run" notice (`scripts/generate-lean-pages.tsx:101`).
  In the public dataset, `requirements.status` is now `unknown` for those rows' domains,
  replaceable values and community nodes (21,207 rows) instead of `required`
  (`pipeline/export/public-projection.ts`), and the generated release notes explain the value. The
  export's per-row `readinessStatus` also stops reporting `known` for an unscanned report. `unscanned`
  is not a member of the public model's `readinessStatus`/`status` vocabularies and adding one would
  be a schema change, so the labels use the `unknown` member both enums already have.

- **The release manifest now owns the three scanner sidecars that `check:data-sync` was failing on.**
  `advisories-v2.json`, `advisory-quarantine-v1.json` and `calibration-v2-manifest.json` shipped from
  `data/scanner/` into `app/public/data/` with no `manifest.artifacts` record, so the gate reported
  them as extras — and the alternative, exempting `scanner/` inside the gate (`60a3d0f`), was reverted
  by the owner (`a35aa87`) on the grounds that real ownership, not a blind spot, is the requirement.
  The declaration now lives in the manifest generator itself (`pipeline/package/scanner-sidecars.ts`,
  applied by `buildManifest`), so every writer of the manifest owns them — the full corpus build and
  the `repackage-from-data`, `demote-source-rights` and `repair-connection-counts` repair paths —
  each with a byte size and sha256 measured from disk, sorted in the same canonical path order as
  every other artifact, and with no invented `entryCount` for records the packager does not own.
  Nothing was moved or deleted and the gate was not weakened; `npm run check:data-sync` prints
  `Data sync passed: 49 files match byte-for-byte.`, with `check:corpus` (11,464 entries, 11,464
  manifest ID mappings), `check:corpus-privacy` and the advisory checker still passing. The advisory
  checker is also reachable from npm now (`check:scanner-advisories`); it had no script entry at all.
- **The CLI semantic-digest parity regression no longer breaks workspace typechecking.** The test
  uses the public `@hub/scanner-core/v2` export and remains under `packages/scanner-cli/src/v2`, so
  both the CLI typecheck and the root Vitest project collect it.
- **Three bugs in the dataset exporter**, each invisible at the one-to-two-row scale its fixtures
  used and each fatal at 11,464 workflows: finding ids collided because they hashed only
  `(workflowId, policyId)` when one policy fires many times per workflow; SQLite's own read-back
  check ordered six relations by hashed id while the projection ordered them by label, so two
  correct sequences compared as a mismatch; and Excel's column-width calculation spread 130,972 rows
  into `Math.max(...)`, overflowing the call stack.
- **SARIF CWE tags reached the browser report but not the CLI** — a finding kept its CWE where a
  person reads it and lost it where a machine does. `sarifTagsFor` now lives in scanner-core and
  both emitters call it.

- **Nine palette contrast defects, in a product where colour carries severity.** The design audit
  found two by hand; the new gate found seven more, because a hand measurement only checks the
  surfaces someone thought to check. The worst: dark-mode `sev-critical` measured **2.77:1 against
  `raised`** — the most severe step in the ramp was the least visible one, on the surface every
  card uses. Also `sev-low` at 2.98:1 in light mode, light `ink-faint` at 4.33:1 (under the 4.5
  floor for text), and `hairline-strong` at 1.67–2.00:1 in both modes, which made the boundary
  between a card and the page very nearly invisible. All nine now clear their floors on every
  surface, with the text hierarchy preserved.

- **Release blocker REL-01 is cleared.** The catalogue published 1,757 entries whose workflow graph
  cannot be drawn: two or more functional nodes and no connections at all, the signature of a
  nodes-only export. `data/` was packaged before the packager learned to withhold them, so
  `check:catalogue-claim-freshness` had never passed. The corpus was re-packaged through the real
  packager, which partitions, writes `data/quarantine-report.json` with a reason per entry, and
  regenerates every projection consistently. The catalogue now serves **11,464** of 13,221 acquired
  workflows, and every public figure in the documentation was updated to say so.
- **A gate defect was withholding 18 workflows that render perfectly.** `classifyChart` resolved an
  edge endpoint to a node *id* and then required `from !== to` to prove the edge joined two distinct
  nodes. Sanitization collapses every node id in some charts to one token — `''`, `'REDACTED'` and
  `'[CENSORED]'` all occur — so every edge in a fully connected 41-node graph looked like a
  self-loop. Node identity now comes from position, which cannot collide. Fixed in both
  implementations of the predicate, because a disagreement between the gate and the packager
  produces a gate that can never be satisfied.
- **`data/quarantine-report.json` now says why.** It recorded only the code `GRAPH_INCOMPLETE`; it
  now carries that code plus a sentence naming the observable fact, e.g. *"the packaged workflow
  declares 174 functional nodes and no connections at all"*.
- **The file-size ratchet is green again.** Four pipeline files had drifted past their baselines,
  and `check:file-size:all` is the first gate in `CORE_GATES` — so it short-circuited every gate
  run, including CI, before anything else could execute. Split into four cohesive modules rather
  than raising the baselines. (Findings A-13, G-01, F-02.)

### Removed

- **186 stale documentation files** (267 → 81, 5.8 MB → 1.1 MB): nine superseded audit packets and
  the agent scratch tree under `docs/superpowers/`. All recoverable via `docs/audit/HISTORY.md`.

### Known open

- **The CLI has no root import, and adding one is a build change rather than a manifest edit.** With an
  `exports` map present it is authoritative, so the package's declared `main` is unreachable and a bare
  `import 'sfscanner'` raises `ERR_PACKAGE_PATH_NOT_EXPORTED`; the supported API is the `./v2/*` subpaths and
  the supported interface is the `bin`. `build.mjs`'s `readSubpathPlan` rejects a `"."` key **by design** —
  its docstring records that it exists to stop the manifest advertising files the build never emits — and
  every advertised subpath must name a bundled `dist/<name>.js` and a declaration `dist/<name>.d.ts` from
  `./src/<name>.ts`. A root entry therefore requires the build to emit `dist/main.d.ts` and to accept
  `./src/main.ts`: an owner decision, not a one-line fix.
- **`check:search-quality` is red, and correctly so.** Withholding the unrenderable entries minted a
  new release identity and removed 3 of the 32 human-judged workflow ids, affecting 5 of 26 relevance
  cases. The fixture still pins the old release. Fixing this means re-judging with two reviewers —
  the holdout split is `untouched-evaluate-once`, so it is a protocol decision, not maintenance.
  Re-stamping the identity would make the gate pass and the evidence false. Tracked in `STATUS.md`
  as SEARCH-QUALITY.

### Housekeeping

- **Packet scratch is untracked and ignored, for good.** 27 files of scanner-packet scratch had been
  committed from `.d1-scratch/`, and a sibling `.d6-scratch/` was amended out of the release commit in the
  same pass. Both are covered by `.*-scratch/` in `.gitignore` and removed from the index — a rule alone
  could not have fixed this, because ignore rules never apply to paths already tracked.
- **51 git worktrees removed, and nothing was lost.** Measuring with `--untracked-files=all` found
  real abandoned source changes in almost all of them, including eight under the Codex worktree
  directory that had never been measured or archived — one holding 1,016 uncommitted changes. Every
  dirty tree was turned into a commit first (42 of them) and every detached HEAD tagged (32
  `rescue/*` tags), then all 51 were verified clean and removed. Recovery is
  `git checkout rescue/<name>`, which is better than the tarballs it replaces: diffable, and it
  cannot rot.
- **The project's footprint on the projects drive went from ~48 GB to ~10.8 GB**, with every byte
  identified before deletion: five superseded pipeline re-derivation runs, three build-output trees,
  and a promoted staging copy already living in `data/`. Other projects on the same drive were
  measured and left alone.
- **The acquisition state that produced the corpus is not lost, as the audit and the plan both
  claimed.** It was found intact inside a three-week-old backup — a 262 MB `entries.json`, the
  description checkpoint, the stage ledger and the upstream clones — while emptying that very
  directory. It is deliberately kept; the five superseded runs beside it are not. This makes the
  open question about the 1,757 quarantined workflows answerable rather than permanently closed.

- **Scanner source is under version control.** `packages/scanner-core` (91 files),
  `packages/scanner-cli` (12) and `pipeline/cli` (27) were untracked. The product's most valuable
  code existed only on one disk. (Blocker VCS-01, closed by commit `0bb8438`.)
- Local backup tarballs (212 MB) and a stray screenshot are now ignored rather than staged.
