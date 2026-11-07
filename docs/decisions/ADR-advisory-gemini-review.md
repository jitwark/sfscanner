# ADR: secondary Antigravity advisory review lane (superseded)

## Status

Superseded on 2026-09-07. Retained as historical evidence; it is not active programme policy.

## Context

The scanner programme requires fresh `gpt-5.6-luna` xhigh implementation plus independent
authoritative specification and quality/security reviews. A second review signal can improve
test-vector and packet-audit coverage, but must not blur the authority boundary or give a tool
write access to the shared worktree.

## Historical decision (retired)

The former proposal was to add a parallel, non-authoritative advisory lane using only OMP or `agy` with the exact
provider-qualified model `google-antigravity/gemini-3.8-flash-high`, selecting high effort/high tier
when locally supported. The lane may review frozen diffs, named contracts, implementer reports, and
relevant tests only. It cannot authorize findings, security verdicts, licences, commits, gates,
exports, lockfiles, ledgers, or publication.

Invocation is bounded, structured, and isolated: OMP uses `--no-tools --no-session --no-extensions`
with an explicit isolated cwd and finite timeout; if either control cannot be exposed, the run is
unavailable. `agy` uses print/plan/sandbox mode without write-capable workspace access. Never use
yolo, auto-approve, dangerous permission skips, or default write-capable tools. Reports record exact
tool/provider/model/version, effort/tier, base/head, and input/output hashes. Unavailable, timeout,
malformed, leakage, or model-mismatch results are
`ADVISORY_UNAVAILABLE` and never block or authorize acceptance.

## Superseding decision

The Codex session will not dispatch Antigravity/OMP reviewers. Continuation is being handed to an
OMP session with direct access to its own Antigravity subagent. That external handoff is not a new
Codex acceptance authority: any result must remain prepared external context until the programme's
authoritative Luna reviews and local gates are rerun. See
`docs/plans/2026-09-07-omp-handoff.md` for the exact stop state.

## Historical consequences

Advisory work can overlap the two authoritative reviews only after the candidate diff is frozen.
Fixes, gates, commits, ledgers, shared exports/lockfiles, and phase checkpoints remain serialized.
The orchestrator independently verifies advisory findings and tracks overlap, false positives,
leakage, timeout, latency, and cost/usage during phased adoption.
