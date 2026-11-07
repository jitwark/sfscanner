# ADR: HTTP cache only for the static catalogue

> Status: accepted for v1
> Date: 2026-08-30
> Scope: P6.4 browser catalogue delivery

## Decision

The static-export app relies on browser/CDN HTTP caching. V1 does not add IndexedDB, the Cache
API, or a service worker. Catalogue detail, preview, and chart bodies are not retained in
application memory; only the manifest promise and validated per-shard detail/preview indexes are
reused during a page session.

## Evidence and scope

- `app/next.config.ts` sets `output: 'export'`, so there is no application server or server-side
  cache to coordinate with browser storage.
- `app/src/catalogue/manifest.ts` evicts rejected manifest promises. Detail and preview index
  caches are keyed by schema, release timestamp, artifact hash, and shard, evict rejected promises,
  and now verify fetched index bytes against the manifest hash before retaining them.
- Detail and preview range bodies are validated for response status, expected length, SHA-256, and
  parsed shape on every request. Charts have no application cache. Focused catalogue tests prove
  network, short-body, range-unsupported, malformed, and hash-mismatched responses are fetched or
  rejected again rather than replayed from successful in-memory state.
- This ADR makes no claim about deployed `Cache-Control`, `ETag`, `Last-Modified`, `Vary`, MIME, or
  range headers. Those require an approved reachable preview and remain a separate delivery check.

## Consequences

HTTP cache invalidation follows the path-class policy and release identities. A hard navigation may
reparse an index, but v1 avoids storage migration, quota, corruption recovery, multi-tab coherence,
offline semantics, and stale-release cleanup.

## Revisit trigger

After a reachable preview exists, capture cold/warm/repeat-visit traces on representative devices.
Reopen this decision only if repeat index parsing or offline requirements show a material user
benefit that outweighs storage, invalidation, quota, corruption, privacy, and multi-tab complexity.
Any adoption requires a new ADR, release/schema/hash keys, bounded storage, atomic replacement,
corruption recovery, and tests for upgrade, eviction, offline, and multi-tab behavior.
