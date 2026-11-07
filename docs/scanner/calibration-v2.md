# Scanner v2 development calibration
Status: development-only/report-only. Owner: Community Hub maintainers. Last verified: 2026-10-17. Source of truth: WC-0511 development calibration in [`openspec/changes/world-class-scanner-cli/implementation/phase-04-05.md`](../../openspec/changes/world-class-scanner-cli/implementation/phase-04-05.md) and this contract.

This is a **development-only, report-only** calibration harness for scanner-core v2.
It is not an admission gate, a profile selector, a rule registry, a capability
promotion mechanism, a production prevalence estimate, or a security approval.
The harness never executes workflow content and never opens a network connection.
It does not change scanner authorities, profile membership, rule effects, scoring,
thresholds, or analyzer behavior. In particular, hardened capabilities remain
outside the admitted `beta-default@2.0.0` profile unless a separate, versioned
promotion decision is made elsewhere.

The implementation is split into:

- [`v2-case-schema.ts`](../../pipeline/calibration/v2-case-schema.ts), the closed
  bytes-first case contract and fail-closed boundary validator; and
- [`v2-runner.ts`](../../pipeline/calibration/v2-runner.ts), the deterministic
  report builder that invokes [`scanWorkflowV2`](../../packages/scanner-core/src/v2/scan-workflow.ts)
  directly or receives an injected pure scanner function.

## Case contract

Every case records an immutable copy of the UTF-8 workflow bytes and a complete
lineage record: source, commit, path, licence, permission, and SHA-256 digest.
It also records the target context (including its context digest), profile
identity, and the scanner engine/ruleset/semantics authority identities. These
identities are evidence, not overrides: the runner passes the case profile and
target to scanner-core and compares the returned identities with the case.
Review metadata is optional: when present, label source, reviewer, and review date are preserved in case results. This metadata is descriptive evidence only, not a promotion signal.

The top-level and nested records are closed. Unknown keys, duplicate case IDs,
invalid UTF-8, raw unsafe bytes, malformed IDs, missing provenance, duplicate
expected rule labels, malformed target data, and malformed authority digests are
rejected before a report is produced. The provenance digest must equal the
bytes' SHA-256 digest. A changed authority or target digest is a stale-authority
failure; it is never silently accepted or rewritten.

Each case has one authored label:

- `POSITIVE` — one or more named rules are expected to produce an applicable,
  observed finding;
- `NEGATIVE` — the labelled rules are expected not to produce a finding;
- `NEAR_MISS` — a deliberately close control whose labelled rules are not a
  positive claim; and
- `UNSUPPORTED` — the input exercises a boundary where the scanner must abstain
  or remain unknown rather than claim coverage.

Per-rule labels are retained independently of the case label. A missing finding
on a positive case is a false negative; it does not relabel the authored case as
negative. Scanner outcomes retain separate `UNKNOWN`, `ABSTAINED`, `DEGRADED`,
`OMITTED`, and `REJECTED` states. `REJECTED` is an input/configuration failure,
`ABSTAINED` is an indeterminate analysis boundary, `DEGRADED` records a bounded
partial analysis, and `OMITTED` records result items dropped by a limit. An
unknown finding remains `UNKNOWN`; it is not converted into a clean result.

## Report and denominators

`runCalibrationV2` selects exactly one split. Development is the default, and a
holdout case passed to a development run is rejected. Holdout evaluation must
be an explicit separate invocation with `split: 'holdout'`; development and
holdout cases are never mixed in one report.

Cases are sorted by stable ID before scanning. The default clock and memory
sampler are zero-valued deterministic seams; callers that want measurements
inject monotonic `now` and memory samplers. Each case reports latency, memory
change, and scanner serialized-result bytes. The report totals these counters
without using wall-clock time, process memory, randomness, filesystem access,
or network access.

For every rule mentioned by an expected label or observed finding, the report
contains separate positive, negative, near-miss, and unsupported denominators.
It also reports observed-positive, unknown, abstained, degraded, omitted,
rejected, true-positive, false-positive, and false-negative counts, with null precision or
recall when its denominator is zero. `expectedLabel` remains the authored label
in every case result, including false negatives and rejected cases.

These measurements describe behavior on reviewed development fixtures only.
They do not admit a profile, promote a rule, enable a capability, or authorize a
production rollout. Any later promotion requires its own profile version,
manifest and authority digests, parity/golden evidence, independent review, and
an explicit decision outside this report.

Focused verification:

```text
npx vitest run pipeline/calibration/v2-runner.test.ts
```
