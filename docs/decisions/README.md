# Architecture decision records

These records explain decisions that are expensive to reverse or that protect scanner, privacy,
rights, and release invariants. Historical audit reports remain immutable evidence; when a decision
changes, add or supersede an ADR rather than rewriting history.

## Active scanner programme decisions

| Decision | Scope |
| --- | --- |
| [Scanner v2 authority](scanner-v2-authority.md) | One deterministic core, adapter migration, and authority gates. |
| [Safe v1 projection](scanner-v1-projection.md) | Frozen v1 compatibility, approved false-clean breaks, and loss encoding. |
| [Semantics and advisories](scanner-semantics-and-advisories.md) | Workflow capability facts versus host/version advisory applicability. |
| [Rule-pack trust](scanner-rule-pack-trust.md) | Declarative rule limits, signatures, report-only development, and rollback. |
| [CLI exits](scanner-cli-exits.md) | Offline CLI ownership, machine output validity, interruption, atomic output, and exits. |
| [Scanner admission boundary](ADR-scanner-admission-boundary.md) | Parser-owned private snapshots for bounded same-realm validator admission and rollback. |
| [Economic v2 release](scanner-v2-economic-release.md) | Release slices, profile/context boundaries,
  risk-tiered model routing, and deferred-scope governance. |
| [Generic node semantic fallback](ADR-generic-node-semantic-fallback.md) | Coverage gap in unmodelled nodes, the conservative fallback record, its degraded advisory, and what stays fail-closed. |

The normative source for new scanner behavior is the
[world-class scanner and CLI OpenSpec programme](../../openspec/changes/world-class-scanner-cli/).
Its [proposal](../../openspec/changes/world-class-scanner-cli/proposal.md),
[design](../../openspec/changes/world-class-scanner-cli/design.md),
[implementation phases 0–3](../../openspec/changes/world-class-scanner-cli/implementation/phase-00-03.md),
and capability specifications define the requirements and gates referenced by the ADRs above.

## Existing product decisions

- [Deterministic scanner findings](ADR-deterministic-scanner-findings.md)
- [Dependency advisory remediation](ADR-dependency-advisory-remediation.md)
- [Privacy-preserving observability](ADR-privacy-preserving-observability.md)
- [HTTP cache-only policy](ADR-http-cache-only.md)
- [JSON-only Gemini input](ADR-json-only-gemini-input.md)
- [Fail-closed Gemini publication](ADR-fail-closed-gemini-publication.md)
- [Publication is not redistribution](ADR-publication-is-not-redistribution.md)
- [Deployment environment policy](ADR-deployment-environment-policy.md)
- [Search quality gates](ADR-search-quality-gates.md)
- [Structured description contract](ADR-structured-description-contract.md)
