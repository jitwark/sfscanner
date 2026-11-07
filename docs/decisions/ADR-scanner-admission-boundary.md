# ADR: Scanner admission boundary for untrusted same-realm values

**Status:** Accepted for WC-0203 recovery
**Date:** 2026-09-07

## Context

WC-0203 requires closed unknown-key, non-enumerable, symbol-key, accessor, and prototype
validation while also bounding hostile work. In the same realm, an arbitrary forwarding `Proxy`
can return an arbitrarily large own-key collection before a validator can apply an own-key cap.
Consequently, a validator cannot safely accept an unknown object and both prove closure and bound
reflection. A worker or structured clone can provide host isolation, but it does not repair the
validator boundary itself and is not required for v1.

## Decision

The scanner-owned parser/admission boundary is the only producer of values accepted by v2
validators. It produces closed, deeply frozen admission snapshots with private, out-of-band
provenance. A validator first checks that private provenance using a non-reflective operation and
rejects any unbranded value before reading ordinary properties, keys, prototypes, array lengths, or
collection contents. This includes proxies, accessors, non-plain objects, cyclic or sparse values,
symbol-bearing values, and values with unknown string keys.

Public or third-party raw JSON enters through a bounded byte/parser boundary. That boundary charges
bytes, depth, nodes, members/elements, and all other applicable limits while it constructs the
snapshot. The private marker is not an own data property, is not enumerable, and is excluded from
canonical bytes, semantic bytes, identity digests, fact IDs, finding IDs, trace IDs, and result
digests. A worker or structured clone remains optional host isolation only.

The contract-level shape is intentionally narrow and synchronous:

```ts
declare const scannerAdmissionBrandV2: unique symbol;
type ScannerAdmissionSnapshotV2<T> = Readonly<T> & {
  readonly [scannerAdmissionBrandV2]: 'private';
};
type AdmissionSnapshotResultV2<T> =
  | { ok: true; snapshot: ScannerAdmissionSnapshotV2<T> }
  | { ok: false; code: 'UNSAFE_INPUT' | 'LIMIT_EXCEEDED' };
type ParserOwnedAdmissionBoundaryV2 = {
  fromBoundedBytes(bytes: Uint8Array, limits: ScannerLimitsV2):
    AdmissionSnapshotResultV2<ReadonlySourceDocumentV2>;
};
```

The implementation may use a private `WeakSet`, a private symbol, or equivalent scanner-owned
storage. Any typed constructors for safe facts and candidates are internal builder APIs; they must
materialize allowlisted fields directly and must not become a raw-object reflection escape hatch.

## Rejected alternative

The rejected design was to keep accepting arbitrary same-realm objects and make validators safe by
enumerating own string and symbol keys, rejecting accessors, checking prototypes, and stopping after
a configured key cap. A forwarding proxy can make `ownKeys` allocate or return 100,000 keys before
that cap is observable. This fails the required bounded-hostile-work property even if all later
checks are correct.

## Consequences

V2 validators no longer accept raw same-realm objects as candidates. Bounded parser ingress owns the
reflection required to construct admitted snapshots, while private provenance lets validators reject
untrusted values before ordinary reads. The boundary remains deterministic, offline, browser-safe,
and compatible with the existing closed errors; worker or structured-clone isolation is optional and
does not replace admission.

## Migration and rollback

This decision changes only the v2 internal admission boundary. The safe-fact registry contents,
identities, registry digests, canonical result bytes, deterministic/offline/browser-safe rules, and
all v1 goldens remain unchanged. Unbranded structured inputs continue to map to the existing closed
`UNSAFE_INPUT` validator result rather than a new public error.

If the snapshot implementation must be rolled back, raw ingress falls back to the bounded
bytes/parser path and direct structured-object ingress remains rejected; raw reflection is not
re-enabled. The v1 parser/scanner and its goldens remain the rollback authority. WC-0204 cannot start
until the replacement boundary and scheduler bridge are accepted.
