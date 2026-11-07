# ADR: Separate workflow semantics from advisory applicability

> Status: accepted
> Date: 2026-09-06
> Owner: Scanner maintainer; provenance and release review remain independent gates

## Context

A workflow can demonstrate a capability such as command execution, database access, or an external
destination without proving that its host runs a vulnerable n8n or package version. The current
scanner is single-workflow and offline; it cannot inspect an instance, credential store, deployment,
or live advisory service. Treating an advisory spreadsheet or prose claim as a rule would turn
missing host evidence into a false vulnerability conclusion.

## Decision

V2 uses two separate, versioned, offline artefact families:

1. A reviewed semantic catalogue resolves node type/version, operation, defaults, authentication,
   credentials, destinations, ports, item/error/retry flow, disabled state, subworkflows, sources,
   sanitizers, sinks, and effects. It describes workflow facts only; it does not assign finding
   severity, scoring effect, or assessment weight.
2. A provenance-reviewed advisory catalogue stores primary-source identifiers, raw publisher ranges,
   normalized strict-SemVer clauses, fixed versions/branches, prerequisites, CVSS source/version,
   dates, URL, review state, withdrawn/rejected status, content digest, verification date, and
   reviewer. Advisory prose never becomes a rule.

Target context (n8n version, package/version, edition, deployment, role, task runner, and relevant
configuration) is explicit input. Missing facts produce `UNKNOWN`; workflow presence alone never
proves host applicability. Resolution is deterministic and local, and approved destinations are
analysed as strings without network access.

## Rejected alternatives

- **Infer a host CVE from a matching workflow node.** Rejected because node capability and host
  applicability are different evidence classes.
- **Use one advisory spreadsheet as both rule and applicability authority.** Rejected because rows
  may be secondary, stale, unresolved, misattributed, or missing machine-readable ranges and
  prerequisites.
- **Resolve package/advisory ranges over the network at scan time.** Rejected because scanner and
  static Worker/CLI guarantees require zero outbound requests and reproducible inputs.
- **Let the semantic catalogue assign security severity.** Rejected because rule catalogue metadata
  owns effect, severity, confidence, and scoring authority.

## Compatibility boundary

Native v1 rules and their workflow-only claims remain unchanged. V2 semantic/advisory identity and
target context are explicit v2 fields; no v1/public entry identity, `EntrySecurity`, or rights
decision is changed by this ADR. Unreviewed, unresolved, or misattributed advisory records remain
quarantined and cannot affect findings or applicability.

## Rollback

If a catalogue digest, provenance review, resolver determinism check, or applicability fixture fails,
reject that catalogue version before scanning and retain the last admitted verified version. If no
verified catalogue is available, emit an explicit catalogue/dependency/unknown outcome rather than
silently using a nearest version or claiming not-applicable. Restore the prior artefact by its signed
release identity.

## Owner, evidence, and release gate

The scanner maintainer owns schema and resolver implementation; catalogue and advisory reviewers own
source and provenance evidence. Phase 4 requires resolver determinism, exact-range and ambiguous-match
fixtures, positive/negative/unknown target fixtures, provenance review, digest parity, and release
approval. The semantic/advisory separation is also covered by the v2 result and documentation gates.

## Linked OpenSpec requirements

- [Semantic catalogue](../../openspec/changes/world-class-scanner-cli/specs/scanner-semantic-catalogue/spec.md)
- [Release resolution](../../openspec/changes/world-class-scanner-cli/release-resolution.md)
- [Scanner result v2](../../openspec/changes/world-class-scanner-cli/specs/scanner-result-v2/spec.md)
- [Release assurance](../../openspec/changes/world-class-scanner-cli/specs/scanner-release-assurance/spec.md)
- [World-class proposal](../../openspec/changes/world-class-scanner-cli/proposal.md)
