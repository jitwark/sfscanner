# ADR: Rule-pack authority and trust boundary

> Status: accepted
> Date: 2026-09-06
> Owner: Scanner maintainer; supply-chain and release approval remain owner-gated

## Context

Declarative rules can make structural coverage easier to review, but an interpreter that accepts
arbitrary code, unrestricted regex, remote references, or unsigned scoring metadata would expand the
scanner's attack surface and weaken its authority model. Taint and agentic analysis also need more
precision and calibration evidence before they can be migrated or promoted.

## Decision

Native TypeScript policies and analyzers remain authoritative through the trust, semantic, precision,
and compatibility gates. A later declarative runtime may admit only the closed v2 rule-pack contract:
typed bounded opcodes over registered safe facts, exact fact/property selectors, strong Kleene
`TRUE`/`FALSE`/`UNKNOWN`, deterministic instruction budgets, no submitted-code execution, and no
remote imports/references, recursion, wildcards, coercion, or unsupported regex semantics.

Scoring requires canonical pack bytes, SHA-256 identity, and a valid Ed25519 signature from an
`ACTIVE` key in the explicit versioned trust store. Revoked, invalid, malformed, unknown-key, or
signature-downgrade states reject admission. The explicit local
`--allow-unsigned-development-rules` escape hatch admits only an otherwise-valid unsigned pack and
forces every rule to `REPORT_ONLY`; it can never influence assessment or turn an invalid signature
into a valid one. Pack metadata cannot grant scoring authority, alter severity/confidence, or mark a
required capability complete.

## Amendment 2026-09-25: v2 admits no external pack

The `Decision` above describes the trust model the scanner is converging on, not a capability v2
ships. WC-0702 (Ed25519 trust-store admission), WC-0703 (unsigned development authority), and WC-0704
(SBOM/reproducibility) are authorised work that is not yet built, so the v2 release boundary is
still the *absence* of external packs rather than permissive admission:

- `--rules` and `--catalogue` accept only `builtin`; any other value is a usage error (`RULE_PACK_INVALID` / `SEMANTIC_CATALOGUE_INVALID`) and exit 2.
- A versioned config that names a pack or catalogue path is `INVALID_CONFIG`/exit 2, so a config file cannot bypass the grammar.
- `--allow-unsigned-development-rules` is refused, and the config boolean `allowUnsignedDevelopmentRules` selects no authority; both can only record a request, never admit a pack.
- The built-in `scanner-core-builtins@2.0.0` ruleset is a compiled, digested artifact accepted from the shipped scanner build, not a pack the trust store admitted. Its `signatureStatus` of `VERIFIED` is that built-in-authority interpretation and is not an Ed25519 verification result.

The proof is `packages/scanner-cli/src/v2/external-pack-boundary.test.ts` (a caller presenting a pack
path exits 2 with no machine envelope and zero scans). The contract statements live in
`tasks.md` Phase 7, `rule-pack-contract.md`, `specs/scanner-rule-packs/spec.md`, and
`cli-v2-contract.md`. The user-visible consequence is that an operator cannot select, sign, rotate, or
downgrade a rule pack in v2; the security consequence is that no untrusted pack reaches scoring, at
the cost of the extensibility the not-yet-built trust store would have provided.

## Rejected alternatives

- **Evaluate `eval`, `Function`, dynamic imports, or submitted code from a pack.** Rejected because
  the scanner must remain offline, static, and non-executing.
- **Permit unsigned packs to score in production.** Rejected because content identity and authority
  would not be independently verifiable.
- **Let pack metadata override scanner-owned effect, severity, or completeness.** Rejected because
  untrusted data cannot grant its own authority.
- **Migrate taint or agentic capabilities before calibration and differential evidence.** Rejected by
  the precision and release ordering gates.

## Compatibility boundary

Existing native rules, v1 outputs, and profile defaults remain unchanged. New declarative packs are
report-only until the required trust and release gates pass; taint/agentic native analyzers remain
native until their own evidence supports migration. No pack feature authorizes publication, npm,
GitHub Action, public catalogue, or deployment changes.

## Rollback

On pack validation, signature, trust-store, differential, or runtime-budget failure, reject the pack
before any workflow is scanned and fall back to the previous admitted signed pack or native rules.
Trust-store changes are versioned and reversible; rollback selects a known release identity and does
not depend on a scan-time wall clock. Unsigned development mode can be disabled without changing
native rule behavior.

## Owner, evidence, and release gate

The scanner maintainer owns the interpreter contract; security and release owners review trust-store
and supply-chain evidence. Phase 6 requires malicious-pack, unknown-opcode/fact, UNKNOWN-semantics,
budget-exhaustion, no-eval/import/network, and browser/Node parity tests. Phase 7 additionally
requires signature/rotation/tamper/downgrade vectors, clean install, SBOM, checksums, provenance,
reproducibility, and rollback evidence **once the trust contract is implemented**. Those items are
gated behind WC-0702–WC-0704, which are authorised but not yet built; the v2 evidence that stands
today is the external-pack disablement proven by
`packages/scanner-cli/src/v2/external-pack-boundary.test.ts`.

## Linked OpenSpec requirements

- [Rule-pack contract](../../openspec/changes/world-class-scanner-cli/rule-pack-contract.md)
- [Scanner rule packs](../../openspec/changes/world-class-scanner-cli/specs/scanner-rule-packs/spec.md)
- [Scanner result v2](../../openspec/changes/world-class-scanner-cli/specs/scanner-result-v2/spec.md)
- [Release assurance](../../openspec/changes/world-class-scanner-cli/specs/scanner-release-assurance/spec.md)
- [World-class proposal](../../openspec/changes/world-class-scanner-cli/proposal.md)
