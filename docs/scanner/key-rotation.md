# Scanner rule-pack key rotation

> Status: authorised work that is not yet built; no Ed25519 verification or live rotation
> Last verified: 2026-10-17
> Owner: Security and release owners, when trust work is authorized
> Source of truth: [`pack-identity.ts`](../../packages/scanner-core/src/rules-v2/pack-identity.ts), the [rule-pack trust ADR](../decisions/scanner-rule-pack-trust.md), the [rule-pack contract](../../openspec/changes/world-class-scanner-cli/rule-pack-contract.md), and the [trust deferral record](../plans/IMPLEMENTATION-LOG.md)

This page records the procedure for the Ed25519 trust store, which is authorised but not yet built. It
describes authorised work, not a live capability. It is deliberately separate from the shipped release's
tested state.

## Current v2 state

| Capability | Current truth |
| --- | --- |
| Canonical pack identity | Implemented for the built-in contract: canonical pack bytes set `signatures: []` and receive a lowercase SHA-256 digest. |
| Ed25519 verification | Not yet built; no verifier, trust store, or active/revoked key check is live in v2. |
| Key generation/rotation/revocation | Authorised but not yet built; no wall-clock validity or rotation command exists. |
| Rule authority | The admitted v2 path is built-in `scanner-core-builtins@2.0.0` with `beta-default@2.0.0`. Native TypeScript policies remain the scoring authority. |
| Declarative custom packs | Not admitted for v2 scoring. Development/evaluation rules are `REPORT_ONLY` and cannot change assessment. |

Do not call the built-in digest a customer-pack signature, claim that a signature was verified, or
claim that a key has rotated. The Phase 7 signature/rotation/tamper/downgrade gate remains pending;
its open status is recorded in [`tasks.md`](../../openspec/changes/world-class-scanner-cli/tasks.md).

## Trust-store procedure (authorised, not yet built)

An owner-approved implementation must use a reviewed Ed25519 library and a versioned trust-store
schema. It must not add handwritten cryptography, substitute an unreviewed dependency, or infer
validity from the wall clock.

1. **Create a new trust-store version.** Record its explicit ID/version and canonical digest. Each
   key has a unique `keyId`, algorithm `Ed25519`, public key, and status `ACTIVE` or `REVOKED`.
2. **Register the key.** Encode the public key as unpadded base64url of exactly 32 bytes. Derive
   `keyId` as lowercase hex of the first 16 bytes of the public-key SHA-256. Sort keys canonically;
   the trust-store digest covers the complete ordered key set.
3. **Canonicalize the pack.** Remove signatures and serialize the exact v2 pack body with
   `signatures: []`. Compute the pack SHA-256 over those canonical bytes. The signature covers those
   bytes, not a display rendering or a mutable file path.
4. **Verify before admission.** Accept scoring only when at least one signature is a valid Ed25519
   signature from a key that is `ACTIVE` in the selected trust-store version. Reject malformed,
   invalid, revoked-only, unknown-key, duplicate-key, incompatible, or signature-downgrade states
   before scanning. Pack metadata cannot grant its own severity, effect, requiredness, or
   completeness authority.
5. **Rotate additively.** Publish a new trust-store version that adds the replacement key as
   `ACTIVE`, produce a new versioned pack/release record, and run old/new verification vectors before
   selecting it. Keep the prior trusted version as the rollback target until the owner records the
   cutover.
6. **Revoke or remove deliberately.** A later version may mark a key `REVOKED` or remove it only
   with a recorded incident/reason, replacement coverage, rollback fixture, and owner decision.
   Never mutate a released trust store in place.
7. **Exercise failure vectors.** Before admission or publication, test tampered canonical bytes,
   invalid signatures, unknown and revoked keys, malformed encodings, duplicate keys, downgrade
   attempts, unsigned development mode, deterministic ordering, and browser/Node parity. Require
   clean-install, SBOM, checksum, provenance, reproducibility, and rollback evidence in the same
   release record.

An explicit future unsigned-development escape hatch, if separately admitted, may accept only an
otherwise-valid zero-signature pack and must force every rule to `REPORT_ONLY`; it cannot turn an
invalid signature into a valid one or influence assessment.

## Readiness separation

The procedure above does not make v2 custom packs selectable, does not promote `beta-hardened`, and
does not authorize GitHub/MCP publication or deployment. Until the trust, precision, parity,
security, and release gates are recorded, current v2 readiness is evaluated only for the admitted
built-in authority and its explicit `UNKNOWN`/indeterminate behavior.

## Non-claims

This page does not claim live Ed25519 signing or verification, an active trust store, key rotation or
revocation, unsigned-pack admission, beta-hardened v2 coverage, external security review, SBOM,
provenance, reproducibility, publication, deployment, or release approval.
