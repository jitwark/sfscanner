# ADR: Offline CLI authority, output validity, and exits

> Status: accepted
> Date: 2026-09-06
> Owner: Scanner maintainer; release and publication remain owner-gated

## Context

The standalone package and pipeline CLI currently have different command shapes, formats, defaults,
batching, and exit behavior. A professional scanner must be scriptable and deterministic while
remaining safe around malformed input, indeterminate analysis, interruption, output collisions, and
serializer failures. It must also preserve existing v1 automation until an explicit major migration.

## Decision

`packages/scanner-cli` owns the eventual `n8n-scan` executable. `pipeline/cli` remains a thin,
visible compatibility wrapper until package/pipeline/browser goldens pass. V2 is opt-in with
`--schema v2` and implements the closed commands `scan`, `rules`, `explain`, `profiles`,
`validate-config`, and `version`; deterministic file/directory/stdin selection; JSON, NDJSON, SARIF,
and table output; explicit local config and artefact identities; bounded concurrency; timeout and
SIGINT handling; and same-directory atomic output that preserves a prior file on failure.

The scanner/CLI/config/rule/catalogue paths make no outbound HTTP, DNS, socket, telemetry,
update-check, or remote-import request. Configuration is CLI > explicit config > defaults; environment
variables never alter scan semantics. Pre-scan usage/configuration/admission failures emit no partial
machine document. After admission, every selected input has a sorted result-or-error item, and machine
formats remain valid except where serialization/output itself fails.

V2 process-exit precedence is exhaustive: `130` cancellation/interruption, `4` internal/output,
`2` pre-scan usage/configuration, `1` finding threshold or `--require-complete`, `3` input/
indeterminate/incomplete item, then `0`. Envelope `exitReason` and process exit must agree. Native
v1 standalone and pipeline defaults, aliases, formats, `--fail-on indeterminate`, and legacy
precedence remain frozen through adapters.

## Rejected alternatives

- **Keep pipeline/CLI as a second executable authority.** Rejected because grammar and exit drift
  would be reproduced indefinitely.
- **Use environment variables, home-directory discovery, or remote artefact URLs implicitly.**
  Rejected because invocation identity and offline behavior would not be reproducible.
- **Emit a partial JSON/SARIF document before configuration/admission succeeds.** Rejected because
  consumers could mistake it for a complete batch.
- **Change v1 defaults or precedence in place.** Rejected because existing automation depends on them;
  such a change requires a CLI-major ADR and differential goldens.

## Compatibility boundary

Legacy optional-`scan` standalone invocation remains v1 JSON, one input, and its current exits. The
pipeline wrapper remains v1 table output, required `scan`, concurrency 4, and `--fail-on indeterminate`
behavior. V2 semantics require explicit schema selection and never authorize publication or an
adapter-authority move before the ordered parity gates.

## Rollback

If a v2 CLI, schema, output, exit, interruption, or atomic-file gate fails, remove v2 selection from
the release entry point and retain the native v1 adapter. A failed file write removes only its
temporary sibling and preserves the prior output. A cancelled file run produces no replacement. Keep
the failed matrix and artifact identity as release evidence; never silently reinterpret a v2 item as a
successful v1 result.

## Owner, evidence, and release gate

The scanner maintainer owns grammar and adapters; release owners approve prepared artifacts and any
publication. Phase 8 requires argument/config/input/output/exit/TTY/atomic/network matrices,
schema-validation tests, deterministic concurrency/selection tests, timeout/cancellation/SIGINT
tests, and Node 22 Windows/Linux/macOS execution. Phase 9 requires byte-parity with browser, bare
Node, and pipeline adapters before package authority is declared complete.

## Linked OpenSpec requirements

- [CLI v2 contract](../../openspec/changes/world-class-scanner-cli/cli-v2-contract.md)
- [Scanner CLI v2](../../openspec/changes/world-class-scanner-cli/specs/scanner-cli-v2/spec.md)
- [Diagnostic and exit registry](../../openspec/changes/world-class-scanner-cli/diagnostic-and-exit-registry.md)
- [Scanner result v2](../../openspec/changes/world-class-scanner-cli/specs/scanner-result-v2/spec.md)
- [Release assurance](../../openspec/changes/world-class-scanner-cli/specs/scanner-release-assurance/spec.md)
