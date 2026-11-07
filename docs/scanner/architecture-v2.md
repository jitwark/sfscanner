# Scanner v2 architecture

> Status: admitted-core architecture; host convergence remains gated
> Last verified: 2026-10-17
> Owner: Scanner maintainer
> Source of truth: [`packages/scanner-core/src/v2/scan-workflow.ts`](../../packages/scanner-core/src/v2/scan-workflow.ts), [`packages/scanner-core/src/v2/admitted-registry.ts`](../../packages/scanner-core/src/v2/admitted-registry.ts), and [`openspec/changes/world-class-scanner-cli/design.md`](../../openspec/changes/world-class-scanner-cli/design.md)

This page describes the explicitly versioned scanner v2 path. It does not replace the historical
[v1 architecture](architecture.md), native `scanner-beta-1` behavior, or any public-entry and rights
decision. The authority boundary is also recorded in the
[scanner v2 authority ADR](../decisions/scanner-v2-authority.md).

## End-to-end boundary map

```text
workflow bytes + profile reference + target claims + optional limits
                              │
                              ▼
                 request/admission validation
                              │
                              ▼
                 bounded UTF-8/JSON source parser
                              │
                              ▼
             source-preserving security normalization
                              │
                              ▼
     built-in semantic resolution + target-context separation
                              │
                              ▼
       admitted capability scheduler and candidate validators
                              │
                              ▼
          safe facts, traces, findings, diagnostics, usage
                              │
                              ▼
       canonical scanner-result-v2 and assessment (or null)
                              │
                 ┌────────────┴────────────┐
                 ▼                         ▼
       structural redaction operation       host presentation adapters
       (unwired — see §7)                    Worker | CLI | pipeline | UI
```

The arrows are authority boundaries, not independent scanners. Core is authoritative for everything
from admission through result truth; hosts provide I/O, deadlines, cancellation, and destinations.

## 1. Core authority and host boundary

[`scanWorkflowV2`](../../packages/scanner-core/src/v2/scan-workflow.ts) accepts bytes, an exact
profile `{id, version}`, optional target data, and optional limits. The admitted registry
([`admitted-registry.ts`](../../packages/scanner-core/src/v2/admitted-registry.ts)) supplies the
engine, profile, ruleset, semantic catalogue, and authority digests. Core does not read a clock or
perform filesystem, process, network, locale-dependent, random, or submitted-code execution work.

A host may read a file or stdin, select inputs, impose a timeout, cancel work, and choose JSON,
NDJSON, SARIF, table, or UI output. Those are host responsibilities and cannot grant a profile,
ruleset, semantic catalogue, finding effect, severity, completeness, or assessment authority. The
v2 CLI's host boundary is implemented in [`cli-runner.ts`](../../packages/scanner-cli/src/v2/cli-runner.ts)
and its batch runner calls the direct `@hub/scanner-core/v2` surface.

The currently admitted v2 combination is:

| Authority | Value |
| --- | --- |
| Engine | `secureflow-scanner@2.0.0` |
| Profile | `beta-default@2.0.0` |
| Rule pack | `scanner-core-builtins@2.0.0`, signature status `VERIFIED` |
| Semantic catalogue | `scanner-core-builtins@2.0.0` |
| Result schema | `scanner-result-v2` |
| Limits schema | `scanner-limits-v2` |

`beta-hardened@2.0.0` is defined in the profile manifest for later evidence, but is not admitted
by the v2 registry. Its source-file presence does not make it selectable. The native v1 hardened
profile is a separate compatibility path.

## 2. Admission and bounded source parsing

The request is a closed data shape. Bytes are copied from a plain `Uint8Array`; the profile must be
the admitted profile; target configuration is checked against the catalogue vocabulary; and limits
are resolved from the versioned defaults. Invalid request shapes fail before a workflow result is
constructed.

[`source-parser.ts`](../../packages/scanner-core/src/source/source-parser.ts) is the only v2 raw
workflow ingress. It charges byte, depth, syntax-node, member/element, duplicate-key, and source-span
work while building the parser-owned, deeply frozen source graph. Validators consume parser-owned
admission snapshots rather than arbitrary same-realm objects. The private provenance marker is
out-of-band and does not enter canonical bytes or identities. See the detailed
[normalization contract](normalization-v2.md) and the
[admission-boundary ADR](../decisions/ADR-scanner-admission-boundary.md).

The parser accepts an optional UTF-8 BOM, includes those exact bytes in `rawSha256`, and removes the
BOM before JSON parsing. Invalid UTF-8, invalid JSON, and source budgets are typed failures; no
replacement character or partial semantic digest is used.

## 3. Source-preserving normalization

[`normalize-security-workflow.ts`](../../packages/scanner-core/src/workflow-v2/normalize-security-workflow.ts)
turns the admitted source graph into a frozen security workflow. It retains source member order and
duplicates, semantic fields, node ordinals, edge ordinals, exact labels, endpoint resolution, and
explicit ambiguity records. User-supplied node IDs and names are labels only: source ordinal and
source identity establish subject identity.

A duplicate or malformed value is not silently resolved with a last-member-wins policy when it can
change a security conclusion. Security-consumed duplicates make the affected node ineligible for
scored evaluation; metadata-only duplicates degrade. A malformed parameters value remains bounded
source evidence and does not become an invented empty object. An ambiguous or unresolved edge stays
in the graph without a fabricated endpoint reference. These rules are expanded in
[normalization-v2.md](normalization-v2.md).

## 4. Semantics and target context

The core resolves the admitted built-in semantic catalogue before running capabilities. Semantics
identify node effects, sources, sinks, sanitizers, ports, authentication markers, destinations,
error/retry behavior, disabled behavior, and entry status. They describe workflow capabilities;
they do not assign rule severity, scoring effect, or assessment weight.

Target context is separate input. An installed n8n version, edition, deployment, role, task runner,
community-package versions, and configuration states are not inferred from a workflow node's
`typeVersion`. Missing facts remain `UNKNOWN`, and the target's canonical `contextDigest` is part of
v2 identity. See [semantic-catalogue.md](semantic-catalogue.md) for resolver and applicability
boundaries.

## 5. Capability scheduling and analysis

The scheduler in [`scheduler.ts`](../../packages/scanner-core/src/capabilities/scheduler.ts) takes a
module-owned read-only analyzer context and executes selected capabilities in manifest order. It
snapshots mutable context views, validates each candidate independently, converts failures into
registered diagnostics, and records one execution row per selected capability. Dependencies are
explicit; a failed dependency produces a typed skip rather than stale mutable output.

The admitted `beta-default@2.0.0` manifest currently contains these required capabilities, in order:

1. `source-normalization`
2. `workflow-insights` (depends on source normalization)
3. `structural-policies` (depends on source normalization)
4. `assessment` (depends on workflow insights and structural policies)
5. `presentation-facts` (depends on assessment)

The default adapter in [`beta-default.ts`](../../packages/scanner-core/src/capabilities/beta-default.ts)
bridges the existing deterministic workflow-insights and structural-policy implementations into
those v2 candidate boundaries. Code, graph, taint, and agentic capability definitions remain
visible in the non-admitted hardened manifest; they are not v2 scoring coverage merely because
implementations or rule metadata exist.

A candidate can contain only registered rules and allowlisted safe facts, traces, and references.
Rule effect, severity, confidence, revision, and remediation identity come from the admitted rule
view, never from analyzer output. Raw source text, credentials, exception messages, arbitrary
objects, and host paths cannot become canonical evidence.

## 6. Canonical result and completeness boundary

[`compose-result.ts`](../../packages/scanner-core/src/result-v2/compose-result.ts) is the single
v2 result-construction boundary. It validates and canonicalizes engine/profile/ruleset/semantics,
target, limits, capabilities, diagnostics, safe facts, traces, findings, assessment, and stats
against [`scanner-v2-result.ts`](../../contracts/scanner-v2-result.ts). The result records both
identity and coverage: input digests, authority identities, effective-limit usage, capability
execution rows, findings, diagnostics, and omitted counts.

The result status is the maximum effect of capability outcomes and diagnostic effects:

- `COMPLETE` means every selected capability completed, no required work was omitted, all references
  validated, and no non-`NONE` diagnostic was emitted. It means no catalogued evidence was found;
  it is not a safety certificate.
- `DEGRADED` means optional/report-only work or presentation evidence is incomplete while the
  retained result remains safe to interpret.
- `INDETERMINATE` means required/scoring evidence may be missing, ambiguous, malformed, or unsafe
  to project. Assessment is `null`, and adapters must not invent a grade or reassuring summary.

Findings are stable-sorted and their IDs exclude prose. The scoring policy admits only scoring,
applicable, observed findings; report-only, potential, unknown, and not-applicable findings remain
visible but do not alter the assessment. The exact scoring contract is in
[`assessment-contract.md`](../../openspec/changes/world-class-scanner-cli/assessment-contract.md).

## 7. Redaction boundary

V2 canonical evidence is safe-fact based and never serializes raw source values. That boundary holds
structurally, through `SafeFactV2` and `validateScannerResultV2`, not through a redaction pass. **No
shipped path produces a redacted artifact**:
[`redaction-v2/patches.ts`](../../packages/scanner-core/src/redaction-v2/patches.ts) and
[`verify-redaction.ts`](../../packages/scanner-core/src/redaction-v2/verify-redaction.ts) are unwired
— no production caller, not exported from the package, retained test-only. Two of the six documented
patch components (`EXPRESSION_LITERAL`, `CODE_LITERAL`) have no candidate producer, and the
`reparse`/`rescan` verification legs pass when a caller omits them, so these modules must not be
cited as a shipped guarantee. The disposition and its
successor owner are recorded in [`PHASE1-LEDGER.md`](../audit/2026-09-16-fix/PHASE1-LEDGER.md).

A redacted artifact, when the capability is finally wired, must fail closed: any conflict, limit, or
verification failure returns `artifact: null` and no partial artifact, and reparse plus rescan are
mandatory inputs rather than optional ones.

Legacy v1 projection and presentation also use their own redaction and safe-field boundaries. No
adapter may bypass canonical result validation or emit raw source, secret material, arbitrary
exception text, or an unbounded location.

## 8. Presentation adapters and retained v1

The browser UI selects v2 by default: `runScanV2` in
[`run-scan.ts`](../../app/src/scanner/run-scan.ts) posts the `scan-v2` message to
[`scan.worker.ts`](../../app/src/scanner/scan.worker.ts), where the worker calls `scanWorkflowV2`
and validates the returned v2 result before posting it. The worker's separate native `scan` message
still serves the v1 path. The v2 CLI uses the direct package entrypoint; the pipeline wrapper in
[`package-wrapper.ts`](../../pipeline/cli/package-wrapper.ts) dispatches explicit v2 commands to
that runner and keeps the native v1 command path available. Calibration documents identify whether
they invoke v1 or v2.

The v1 adapter remains intentionally visible. [`v1-projector.ts`](../../packages/scanner-core/src/compat/v1-projector.ts)
projects only registered safe facts and templates, keeps frozen v1 ordering, and makes unsafe loss
indeterminate. Native v1 continues to emit `scanner-beta-1`; an explicit projected v2 result reports
the real `2.0.0` engine version in v1's historically named field. The projector never changes
`EntrySecurity`, public catalogue identity, rights, publication, deployment, or MCP behavior.

The v1 architecture page therefore remains accurate for native v1, while this page is the authority
map for explicit v2. Duplicate host implementations are migration evidence until their parity and
rollback gates pass; they are not independent v2 authorities.

## Non-claims

This architecture records local implementation and contract boundaries only. It does not claim
external CI, independent security or compatibility review, rights or legal approval, deployment,
signing, full-corpus v2 rescan, or successful merge. Those are separate
owner-gated obligations in [migration-v1-v2.md](migration-v1-v2.md).
