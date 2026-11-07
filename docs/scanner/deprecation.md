# Scanner versioning and deprecation

> Status: documented compatibility policy; no public deprecation promise
> Last verified: 2026-10-17
> Owner: Scanner maintainer; release and compatibility owners for promotions
> Source of truth: [`semver.ts`](../../packages/scanner-core/src/semantics/semver.ts), [`v1-projector.ts`](../../packages/scanner-core/src/compat/v1-projector.ts), [`v1-registry.ts`](../../packages/scanner-core/src/compat/v1-registry.ts), the [v1/v2 migration boundary](migration-v1-v2.md), and the [release-resolution contract](../../openspec/changes/world-class-scanner-cli/release-resolution.md)

This policy keeps scanner identities, rules, diagnostics, and adapters truthful while capabilities are
added or retired. It is a repository policy for a prepared/private product, not a completed public
support or notice commitment.

## Version vocabulary

Engine, profile, ruleset, semantic catalogue, advisory, schema, and package versions use strict
SemVer 2.0.0: `MAJOR.MINOR.PATCH`, with optional hyphen prerelease and plus build identifiers. A
leading `v`, leading zero in a numeric identifier, missing component, whitespace, wildcard, caret,
tilde, or hyphen range is invalid. Build metadata does not affect precedence. A version change that
alters authority, scoring, diagnostics, evidence, or projection must be recorded as a new versioned
identity; a digest-only same-version authority change is not allowed.

`scanner-beta-1` is an opaque, grandfathered **identity**, not a SemVer value. It remains valid only
for native v1 compatibility validation. Do not rename it, reinterpret it as `1.0.0`, or use it for
explicit v2 output.

## Current support boundary

| Surface | Identity and support rule |
| --- | --- |
| Native v1 | `scanner-beta-1`, `scanner-result-v1`, `scanner-limits-v1`; existing defaults, adapters, and goldens remain the compatibility surface. |
| Explicit v2 | `secureflow-scanner@2.0.0`, `scanner-result-v2`, `scanner-limits-v2`; only `beta-default@2.0.0` is admitted. This is an admitted core path, shipped in the published CLI. |
| V2 hardened/custom packs | `beta-hardened@2.0.0` is defined but not admitted; external/custom declarative packs and signature scoring are not live in v2. |

The public entry identity remains owner-gated. V2 readiness does not migrate `EntrySecurity`,
rights, catalogue artifacts, deployment, or MCP behavior.

## Rule and diagnostic identity invariants

- A released rule ID and revision are immutable once released in a schema/ruleset version. Never
  reuse an old rule ID, even in a later version, for a different threat, evidence meaning, sink, or
  remediation; create a new ID and record the relationship. Retired IDs remain retired.
- A released diagnostic code is never reused, even in a later schema version, for a different
  condition or effect. V1's diagnostic union and ordering remain frozen; a v2-only condition uses
  the registered crosswalk or the existing location-free indeterminate sentinel rather than
  inventing an incompatible v1 code.
- Removing a rule, diagnostic, safe fact, or projection field requires a versioned contract and
  migration note. Preserve the old documentation and evidence; append a correction rather than
  rewriting the historical release record.
- A rule's effect, severity, confidence, remediation, requiredness, and capability ownership come
  from scanner authority, not from an input declaration. A metadata-only edit cannot silently turn
  report-only evidence into scoring evidence.

## Deprecation procedure

1. **Propose and inventory.** Name the owner, reason, affected IDs/profiles/adapters, observed use,
   replacement, risk, and rollback target. Confirm the replacement does not reuse the retired ID.
2. **Publish a versioned notice.** Mark the existing rule/capability `REPORT_ONLY` in a new minor
   ruleset/profile version before removal in a later major. State that report-only findings do not
   affect assessment, and include a migration example using synthetic data.
3. **Collect evidence.** Update generated references, focused fixtures, calibration/differential
   goldens, v1 projection crosswalks, and release notes. Run the relevant contract and parity checks;
   local output is evidence, not independent approval.
4. **Review the notice.** Obtain scanner, compatibility, security, and release-owner decisions. If
   an external reviewer or legal/rights gate is required but unavailable, keep the item pending and
   do not remove it.
5. **Remove only in a major.** In the next approved major version, remove the deprecated authority
   and its selection path. Keep the prior version and v1 adapter available for rollback until the
   owner records the cutover.
6. **Correct failed migration safely.** Disable the new selection and restore the prior v1 authority
   or prior versioned ruleset. Keep failed artifacts and diagnostics; never suppress them to produce a
   clean grade.

The minimum-notice rule—at least one minor release documenting `REPORT_ONLY` before removal in a
major—is a policy written here, not a completed public promise or SLA. An owner must approve any
public notice, timeline, or supported-version statement.

## V1 projection and indeterminate outcomes

Native v1 continues to emit `scanner-beta-1`; a v2-to-v1 projection emits the real engine version
`2.0.0` in v1's historically named `scannerVersion` field. It must not relabel v2 as `scanner-beta-1`,
even if an older consumer rejects the truthful value.

When required v2 evidence cannot be safely represented in v1—such as security-consumed duplicate
keys, required limits, required graph/code loss, malformed connection indexes, or unknown required
authority—the projection uses the registered v1 diagnostic crosswalk or sentinel and sets
`INDETERMINATE`. It omits the v1 assessment and reassuring summaries. An indeterminate projection is
never downgraded to an ordinary grade or false-clean result. Optional/report-only loss may remain
`DEGRADED` only when it cannot affect a v1 conclusion.

## Non-claims

This policy does not claim a public release, supported-version SLA, completed deprecation notice,
external review, beta-hardened v2 admission, custom-pack/signature authority, migration completion,
publication, deployment, or owner/legal/rights approval.
