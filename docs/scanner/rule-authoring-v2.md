# Scanner v2 rule authoring

> Status: admitted-core authoring contract; custom-pack admission and scoring are authorised work that is not yet built
> Last verified: 2026-10-17
> Owner: Scanner maintainer
> Source of truth: [`admitted-registry.ts`](../../packages/scanner-core/src/v2/admitted-registry.ts), [`pack-schema.ts`](../../packages/scanner-core/src/rules-v2/pack-schema.ts), [`interpreter.ts`](../../packages/scanner-core/src/rules-v2/interpreter.ts), [`safe-fact-registry.ts`](../../packages/scanner-core/src/facts/safe-fact-registry.ts), and the [rule-pack contract](../../openspec/changes/world-class-scanner-cli/rule-pack-contract.md)

This page describes the closed rule language and the review path for a future admitted pack. It does
not make a custom pack or a hardened profile available.

## What is admitted now

The only explicit v2 authority is:

| Authority | Value |
| --- | --- |
| Engine | `secureflow-scanner@2.0.0` |
| Profile | `beta-default@2.0.0` |
| Built-in ruleset | `scanner-core-builtins@2.0.0` |
| Safe-fact registry | `scanner-safe-facts-v2@2.0.0` |

`beta-hardened@2.0.0` is defined for later evidence but is rejected by the v2 admission registry.
Its source files and rule catalogue do not make it selectable. Native v1 hardened analysis remains a
separate compatibility path. The v2 CLI's `--rules` and `--catalogue` selections are embedded
`builtin` selections; custom or remote packs do not obtain v2 authority. Ed25519 signatures and a
versioned trust store are authorised work that is not yet built, not a live v2 capability; see [key rotation](key-rotation.md).

## Closed facts and operators

Rules select only exact, registered fact-kind/property pairs. The v2 safe-fact registry currently
contains these kinds:

`workflow.summary.v1`, `workflow.function.v1`, `workflow.risk-summary.v1`, `workflow.fingerprint.v1`,
`integration.v1`, `node.capability.v2`, `node.configuration.v2`, `code.indicator.v2`,
`dataflow.summary.v2`, `destination.v2`, and `ingress.v2`, together with the versioned field-flow and advisory kinds in the current SafeFact registry. Canonical advisory evidence uses `advisory.evaluation.v1`, `advisory.package-coverage.v1`, and `advisory.applicability.v3`; properties remain closed and validated by kind.

The admitted expression vocabulary is exactly:

| Operator | Meaning |
| --- | --- |
| `FACT_EXISTS` | A registered fact kind is present. |
| `PROPERTY_EQ` | A registered property equals a typed scalar. |
| `PROPERTY_IN` | A registered property equals one of typed scalar values. |
| `ALL` | Every child expression is true. |
| `ANY` | At least one child expression is true. |
| `NOT` | Negates one child expression. |

`STRING_MATCHES` is reserved and rejected with `RULE_PACK_INVALID`; no runtime regex engine or
native JavaScript regex fallback is selected. Selectors are not JSON Pointers and do not support
wildcards, recursive descent, coercion, prototype-special segments, remote references, recursion,
or submitted-code execution.

### Unknown is not false

Evaluation is strong Kleene `TRUE | FALSE | UNKNOWN`:

- `ALL` is `FALSE` if any child is false, `TRUE` only when all children are true, otherwise `UNKNOWN`.
- `ANY` is `TRUE` if any child is true, `FALSE` only when all children are false, otherwise `UNKNOWN`.
- `NOT` swaps true and false and preserves unknown.

A missing fact or property, unsupported semantic context, or unavailable evidence therefore remains
`UNKNOWN`; it cannot become a false-clean result. A required/scoring unknown suppresses the
assessment (`assessment: null`) rather than inventing a grade.

## Admission and bounded evaluation

Admission is fail-closed and occurs before a rule can influence a result:

1. Validate the closed pack/rule shapes, schema version, strict SemVer, engine range, fact registry
   digest, exact fields, dense arrays, and typed property values.
2. Reject unknown fields, unknown facts/properties/opcodes, duplicate rule IDs/revisions, empty or
   over-limit groups, remote references, recursion, and incompatible versions.
3. Resolve every rule body against the admitted rule catalogue. A rule id the catalogue does not
   carry is rejected, and a body whose `capabilityId`, `evidenceSchemaId`, or `remediationId`
   disagrees with the admitted rule is rejected rather than admitted with the author's claim: a
   declaration names a rule, it never defines one. At the result boundary the same resolution
   applies to findings — a finding is stamped from the admitted catalogue, and a caller-supplied
   ruleset that restates an admitted rule is refused instead of trusted.
4. Normalize deterministic ordering and deeply freeze the admitted output. Scanner validators consume
   parser-owned, private-brand admission snapshots; an unbranded object with the same visible shape
   is not an admitted candidate.
5. Charge bounded work. The expression tree has at most 1,000 visited expression nodes, each group
   has 1–1,000 children, nesting is at most 32, and the runtime charges every visited expression to
   `maxRuleOperations` (default `1,000,000` in [`scanner-limits-v2.ts`](../../contracts/scanner-limits-v2.ts)).

Rule metadata is scanner-owned. A declaration cannot grant itself scoring effect, severity,
confidence, remediation authority, requiredness, or capability ownership. Candidate evidence must
also pass the closed safe-fact and result validators; raw source, secrets, exception text, arbitrary
objects, and unbounded locations are rejected.

## Authoring procedure

1. Start with a registered safe fact and property. If the evidence is not representable by the
   registry, do not add an ad-hoc field; propose a new versioned registry contract.
2. Express the smallest predicate using the six admitted operators. Treat missing context as
   unknown and document why a true/false conclusion is safe.
3. Add synthetic `POSITIVE`, `NEGATIVE`, `NEAR_MISS`, and `UNSUPPORTED` cases. Keep workflow bytes,
   expected IDs, and any source labels redacted; the [v2 calibration harness](calibration-v2.md)
   is development evidence, not a promotion gate by itself.
4. Run the pack-schema, compiler, interpreter, and tri-state focused tests:

```text
npx vitest run packages/scanner-core/src/rules-v2/pack-schema.test.ts packages/scanner-core/src/rules-v2/compiler.test.ts packages/scanner-core/src/rules-v2/interpreter.test.ts packages/scanner-core/src/rules-v2/tri-state.test.ts
```

Confirm malformed, cyclic, over-depth, over-operation, unknown-fact, unknown-opcode, and
`STRING_MATCHES` inputs fail closed, and that no test executes code or opens a network connection.
5. Obtain the required specification, security/quality, differential, calibration, and compatibility
   reviews. Promotion requires a new profile/ruleset version, canonical bytes and digest, generated
   references, fixtures, goldens, and recorded owner decisions. Local tests prepare that evidence;
   they are not external sign-off.

Until those trust, precision, parity, and release gates are recorded, declarative rule experiments
remain `REPORT_ONLY` and cannot change a v2 assessment; custom packs are not admitted or selectable.
Do not describe them as beta-hardened coverage or as an npm, GitHub, MCP, or public-catalogue feature.

## Non-claims

This guide does not claim custom-pack loading, signature verification, key rotation, regex matching,
beta-hardened v2 admission, host vulnerability/version detection, workflow execution, or any
external security, legal, rights, CI, deployment, publication, or release approval.
