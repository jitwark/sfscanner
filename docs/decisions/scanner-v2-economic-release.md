# ADR: Economic v2 release slices and authority boundaries

## Status

Accepted for execution on the `codex/scanner-world-class` branch. This ADR changes orchestration and
release disposition, not scanner truth semantics. The original WC ledger remains intact.

## Context

The world-class scanner programme has 83 checkbox records across Phases 0–12. The original execution
protocol treated each small item as an independent fresh implementer, specification review,
quality/security review, remediation loop, gate, commit, and ledger update. WC-0203 demonstrated that
the protocol catches real boundary defects, but it also demonstrated that repeating the full protocol
at checkbox granularity creates excessive context, review, retry, and queue cost.

The current accepted baseline is 16/83 after WC-0204 and the final local Phase 2 checkpoint. The
historical pre-WC-0204 Phase 2 recovery checkpoint and the final post-WC-0204 checkpoint are distinct.
External CI, owner, legal, deployment, signing, publication, TestSprite, human-adjudication, and
originating-repository merge gates remain separate and unperformed unless explicitly recorded.

The scanner must remain a deterministic, offline, bounded, no-false-clean security product. The
repository already defines private parser/admission boundaries, closed registries, strong uncertainty,
native-v1 compatibility, and a scanner-core authority. The economic change must not weaken those
controls or silently delete future rule-pack, trust, UI, rights, or release requirements.

The working execution overlay is:
[`docs/plans/2026-09-07-scanner-v2-economic-release-plan.md`](../plans/2026-09-07-scanner-v2-economic-release-plan.md).
It was adversarially reviewed by independent Luna/task2 and Gemini/default passes; the final bounded
recheck returned PASS.

## Decision

### 1. Release objective

Optimize for a user-visible **Core Candidate v2**, not checkbox completion.

The Core Candidate is a built-in-rule, offline, deterministic scanner with bounded byte/source
handling, lossless security normalization, canonical `scanner-result-v2`, explicit completeness and
`UNKNOWN` semantics, safe v1 projection, SARIF, high-value expression/code and graph/taint/destination
analysis, redaction, calibration evidence, and an offline CLI.

A later **Community Candidate** adds browser Worker/pipeline convergence and the explicit v1 Hub
fallback. The Core Candidate is the primary first release target; the Community Candidate is a later
release gate and a contingency boundary if host convergence is slower than core/CLI work.

### 2. Functional slices

S0 is a prerequisite milestone. S1–S9 are grouping/reporting labels, not replacements for the 83 WC
records. Every mapped WC retains its own path lock, focused proof, independent review, commit, and
ledger evidence.

- **S0:** finish WC-0204 and the final local Phase 2 checkpoint.
- **S1:** canonical result, completeness, scoring/projection, private predecessor-output protocol,
  and built-in ruleset authority.
- **S2:** SARIF 2.1.0 and verified coordinates, followed by the broad Phase 3 checkpoint.
- **S3:** strict SemVer, target context, semantic catalogue, non-advisory Phase 4 subset; advisory
  applicability remains v2 SHOULD/later.
- **S4:** one high-level bytes/profile-reference scanner-core API that privately builds validated
  `AnalyzerContextV2`; profile ID/version and authority digests are resolved internally.
- **S5A:** expression islands, provider grammars, bounded JavaScript/Python, secrets, and structural
  redaction with atomic failure.
- **S5B-1:** bounded graph foundations and destination inventory/compliance, parallel with S5A only in
  disjoint accepted worktrees.
- **S5B-2:** dual taint, source/sink/sanitizer/subworkflow semantics, traces, and agentic approval,
  after S5A and graph foundations.
- **S6:** development calibration and per-rule/family promotion/profile admission decisions.
- **S7:** built-in-only offline CLI; external/unsigned authority options are a versioned usage-error
  path until rule-pack trust exists, while native-v1 CLI defaults/aliases remain frozen.
- **S8:** Worker/pipeline convergence, native-v1 fallback, parity, and WC-0902 UI fallback gates.
- **S9:** post-adapter holdout, fuzz/mutation/performance, docs, reproducibility, SBOM/checksums,
  rollback, and prepared release evidence.

### 3. Authority and host boundary

Scanner-core owns parser, normalization, target/semantic interpretation, profile/rule authority,
capability execution, predecessor-output handoff, completeness, and canonical result construction.
Hosts own file/stdin I/O, Worker transport, cancellation, deadlines, and output destinations.

S4 will expose a direct package subpath such as `@hub/scanner-core/v2`, not a root barrel. Its public
request accepts bytes, an exact profile ID/version reference, explicit target claims, and optional
limits. It rejects host-supplied manifests, registries, factories, scoring metadata, and prebuilt
contexts. Omitted limits use frozen v2 defaults. Absent target facts normalize to UNKNOWN; malformed
or ambiguous claims reject with registered pre-scan errors; valid catalogue misses remain UNKNOWN and
follow required/optional effect. Scanner-core never reads a clock.

The current object-based WC-0204 bridge is a hardened internal compatibility seam only. Existing
low-level exports remain during the native-v1 migration window; v2 hosts must migrate to `./v2`, and
the Phase 9 parity gate must remove or block the bypass before Community Candidate convergence.

S1 must freeze an internal immutable `priorOutputs` view containing validated predecessor candidates
and execution status/counters/diagnostics. Dependent capabilities cannot use mutable closures or
undocumented recomputation.

### 4. Profile and ruleset admission

`beta-default@2.0.0` is the currently admitted v2 baseline. `beta-hardened@2.0.0` remains defined but
is rejected before v2 scanning until calibration and parity evidence pass. High-value S5 capabilities
cannot be advertised as scoring coverage merely because their implementation exists.

A Core Candidate profile that includes additional capabilities requires a new profile version, exact
manifest digest, ruleset digest/status, semantic catalogue identity, generated references, fixtures,
goldens, and acceptance evidence. A digest-only same-version authority change is prohibited. A
trusted compiled built-in digest provides identity/integrity; it does not authenticate arbitrary
third-party packs. External scoring packs remain unavailable until the later pack-trust work.

### 5. Uncertainty and redaction

Missing target facts, valid catalogue misses, unsupported evidence, and capability loss remain explicit.
Required/scoring unknown or omission produces `INDETERMINATE` and `assessment: null`; optional or
report-only loss produces `DEGRADED`; rule effect cannot be downgraded dynamically to hide missing
coverage.

Redaction is cross-cutting but initially belongs with S5A. Any conflict, budget exhaustion,
verification failure, or residual-secret failure returns the closed failure shape (`artifact: null`,
empty patches, no partial artifact). Raw source text/snippets, secrets, exception messages, paths,
and arbitrary host content cannot enter canonical scanner truth.

### 6. Model routing and review

- T0/T1 Gemini/default work is limited to non-authoritative sub-packets such as fixtures, frozen
  serializers, generated references, and help text.
- Any public schema/identity, requiredness, scoring, diagnostics, parser/normalization/reflection,
  spans/redaction, code/graph/taint, dependency, authority, rights, compatibility, or release work
  is T2/T3 Luna/task2.
- Every WC acceptance retains fresh specification and quality/security review. A T0/T1 sub-packet
  cannot check a WC item by itself.
- Any Critical/Important finding, no-false-clean gap, unexpected path, scope violation, or harness
  failure blocks and escalates; it cannot become acceptance evidence.
- Until this ADR is incorporated into the implementation handbook, its existing three-failed-cycle
  `BLOCKED` rule remains authoritative. After incorporation, one remediation is normal and a second
  substantive rejection blocks for orchestrator/human design resolution.

### 7. Parallelism and evidence

Parallel writers require isolated worktrees and disjoint path locks from accepted SHAs. Contracts,
exports, manifests, engine/profile authority, generated artifacts, ledgers, docs evidence, lockfiles,
and phase checkpoints remain serialized. S5A and graph/destination S5B-1 may parallelize only after
S3/S4 prerequisites; taint follows both. Phase checkpoints run only from accepted prerequisite commits.

Cost telemetry is ignored local JSONL at `.work/telemetry/v2-execution.jsonl`, validated by a
harness-owned closed schema before append. It stores content-free model/process metadata only. Git
commit IDs are lowercase 40-hex SHA-1; content/authority digests are separately named lowercase
64-hex SHA-256. No prompt, completion, workflow bytes, source, diff, secret, URL, or free-form error
is retained. The first three post-S0 slices calibrate token/wall-time guardrails; the 1–2M figure is
a re-planning tripwire, not a promise or reason to remove security gates.

### 8. Deferred scope

No WC item is silently deleted. The following are release dispositions:

- WC-0405/0406: v2 SHOULD/later and dependency-paired unless an approved non-advisory split exists.
- WC-0509: report-only until calibrated and admitted through profile evidence.
- WC-0601–0604: v3 hardening; retain tri-state semantics and reject external packs in v2.
- WC-0702–0703: v4/enterprise unless external packs move into a later approved release.
- WC-0704: original WC remains blocked by deferred trust dependencies; a built-in-only subset cannot
  check the original checkbox without an explicit split.
- WC-0902: v2 SHOULD; retain v1 Hub fallback until responsive/accessibility/Worker evidence.
- WC-0904: later deletion after parity.
- WC-1001/1002: post-adapter evidence after convergence.
- WC-1103/1104: dependency-paired generated-reference/freshness work.
- WC-1201/1202: later Hub UI work.
- WC-1203/1204/1206: owner/legal/CI/deployment/publication/merge gated; prepare, do not publish.

## Alternatives considered

### Keep one full committee lifecycle per WC

Rejected. It catches defects, but repeats the same context and review cost for tightly coupled changes
and makes the number of checkboxes determine engineering cost.

### Remove independent review and rely on tests

Rejected. WC-0203 and WC-0204 both found real defects that initial focused tests did not cover.

### Delete Phase 6/7 and all future trust machinery

Rejected. External packs and their trust boundary are deferred, not safe to accept without the
contract. Removing the requirement would make future extensibility unsafe.

### Let each host build its own context

Rejected. It creates separate CLI, Worker, and pipeline semantic authorities and makes parity harder.

## Consequences

Positive:

- fewer repeated full-program context packets;
- expensive Luna review remains concentrated at security and authority boundaries;
- Gemini can accelerate genuinely mechanical work without granting it authority decisions;
- CLI/core can become a coherent technical candidate before Worker/UI convergence;
- future WCs remain traceable and auditable;
- profile-ID and private context construction reduce host attack surface and duplicate code.

Costs and risks:

- each grouped slice still requires careful WC-level tracking;
- S4 is a new contract/API boundary and must be designed before implementation;
- deferred advisory/pack/UI/public features reduce the initial release surface;
- telemetry itself needs a privacy-safe validator;
- local evidence remains insufficient for external release gates;
- maintaining v1 fallback temporarily preserves duplicate code.

## Rollback and review

This ADR can be superseded by a new ADR. The original WC plan remains recoverable from git history and
`.superpowers/sdd/plan-backup-pre-economic-v2/`. No public identity, publication, deployment, signing,
or external trust decision is authorized by this ADR alone.
