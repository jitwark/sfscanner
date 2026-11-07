# ADR: Scanner v2 authority and migration boundary

> Status: accepted
> Date: 2026-09-06
> Owner: Scanner maintainer; release authority remains owner-gated

## Context

SecureFlow currently has scanner implementations and adapters in `packages/scanner-core`,
`packages/scanner-cli`, `pipeline/cli`, and `app/src/scanner`. The duplicate browser and pipeline
paths are useful migration evidence, but allowing each path to define parsing, policy execution, or
result semantics makes deterministic parity and fail-safe claims difficult to maintain. The static
Community Hub also cannot grow a server, runtime network dependency, or authoritative model verdict.

The world-class scanner programme defines a source-preserving trust boundary, capability execution,
`scanner-result-v2`, and explicit adapters. Its phases are deliberately ordered: parser trust and
normalization precede result authority; semantics, precision, rule packs, and public migration wait
for the earlier evidence gates.

## Decision

`packages/scanner-core` is the sole authority for v2 parsing, normalization, capability scheduling,
safe facts, findings, diagnostics, redaction, completeness, canonical results, and scoring. It is a
pure deterministic library: no network, filesystem, process, clock, locale-dependent ordering, RNG,
server API, or submitted-code execution.

`packages/scanner-cli` owns the eventual `n8n-scan` executable. `pipeline/cli` and
`app/src/scanner` remain visible compatibility/presentation adapters until the Phase 9 parity gate
proves byte-identical canonical truth. The existing v1 result, CLI defaults, browser behavior, and
`EntrySecurity` remain available through explicit adapters. Community Hub remains a static export;
per-entry/public identity migration is separately owned and cannot be inferred from scanner readiness.

## Rejected alternatives

- **Keep browser, pipeline, and package implementations authoritative independently.** Rejected because
  drift can change findings, completeness, redaction, or identities without a single review point.
- **Move authority to the CLI or browser first.** Rejected because hosts own I/O and presentation,
  while the core must remain usable by Worker, bare Node, pipeline, and calibration callers.
- **Use model output as a finding, severity, grade, or rights decision.** Rejected because it violates
  deterministic, offline, prompt-injection-resistant scanner behavior.
- **Delete the adapters immediately.** Rejected because their v1 output and parity behavior are frozen
  compatibility evidence until the convergence gate passes.

## Compatibility boundary

V2 behavior is opt-in and versioned. Native v1 behavior remains unchanged unless an explicit adapter
projection is selected; any intentional false-clean compatibility break is governed by
[`scanner-v1-projection.md`](scanner-v1-projection.md). V2 does not authorize changes to
`EntrySecurity`, public entry artifacts, rights, publication, deployment, or MCP behavior. Those
changes require the separate orchestrator-owned approval and evidence gates named by the migration
specification.

## Rollback

If a v2 trust, schema, parity, or release gate fails, keep the v1 adapters and goldens authoritative,
disable v2 selection at the host boundary, and retain the failing v2 artifacts as evidence. Rollback
must restore the prior scanner/result identity rather than silently downgrading an emitted v2 result.
No adapter or duplicate implementation is deleted until a later approved change records parity and
the rollback artifact.

## Owner, evidence, and release gate

The scanner maintainer owns implementation and test evidence. Release, legal, rights, disclosure,
deployment, and publication owners retain their approval authority. The Phase 0–3 gate requires
source/normalization tests, v1 goldens, schema and identity vectors, no-network/no-execution checks,
redaction, determinism, and explicit v1 projection differentials. Authority may move only after the
Phase 9 browser/Node/pipeline/CLI golden-parity gate.

## Linked OpenSpec requirements

- [World-class proposal](../../openspec/changes/world-class-scanner-cli/proposal.md)
- [World-class design](../../openspec/changes/world-class-scanner-cli/design.md)
- [Scanner trust boundary](../../openspec/changes/world-class-scanner-cli/specs/scanner-trust-boundary/spec.md)
- [Scanner result v2](../../openspec/changes/world-class-scanner-cli/specs/scanner-result-v2/spec.md)
- [Community Hub migration](../../openspec/changes/world-class-scanner-cli/specs/scanner-community-hub-migration/spec.md)
- [Release assurance](../../openspec/changes/world-class-scanner-cli/specs/scanner-release-assurance/spec.md)
