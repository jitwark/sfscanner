# Public data release retention and supersession

Status: target policy; staged-release family landed in commit `9fc2789`, but owner approval is
required before automated cleanup, publication, or wiring into deployment/release gates.

## Current implementation boundary

This document describes the retention contract for immutable versioned releases and pointer rollbacks.
Commit `9fc2789` landed the staged-release family (`scripts/stage-release.mjs`,
`scripts/lib/release-{identity,ledger,staging,artifacts,schemas}.mjs`, and
`scripts/rehearse-release-rollback.mjs`), which moves the rollback mechanism beyond fixture-only drills
while keeping key operational limits explicit:

- `scripts/prepare-release-data.mjs` remains an in-repository promotion tool: it accepts an
  operator-supplied staged directory, validates its manifest and filesystem entries, and promotes it
  to the mutable repository `data/` directory. With `--replace`, the prior `data/` directory is
  moved to an opt-in `_backups/` location for recovery. It operates on mutable repository data and
  does not create versioned immutable releases under `releases/<releaseId>/`, a release record, an
  active release pointer, or a trusted release ledger.
- `scripts/stage-release.mjs` is now a real release staging writer. It stages an immutable release
  snapshot under an external release root (`releases/<releaseId>/` containing `site/`, `data/`, and
  `export/`), derives an artifact-grounded release identity, seals an immutable release record, writes
  entries to `trusted-release-ledger.json`, and optionally writes or advances the `active-release.json`
  pointer. It strictly refuses to write inside the repository, enforcing that `data/`,
  `app/public/data/`, and `app/out` remain read-only inputs.
- `scripts/rollback-release.mjs` is no longer fixture-only. It authorizes two release families: the
  pre-existing temporary fixture drill (`fixture.json` marker via `--fixture-root`) and real staged
  release roots (`release-root-marker.json` marker via `--release-root`) written by
  `scripts/stage-release.mjs`. It validates both current and target release bytes against
  `trusted-release-ledger.json`, requires the target release sequence to be earlier than the active
  release, atomically replaces `active-release.json`, and re-verifies the restored release from disk.
- `scripts/rehearse-release-rollback.mjs` proves versioned-pointer rollback against real staged
  releases outside the repository. It stages two dataset generations, activates them in sequence,
  asserts that tampering with the target release is caught and refused with the pointer unmoved, and
  rolls back to the prior release with post-verification.

However, the demonstrated claims are narrower than full production automation, and several explicit
boundaries remain:

- **Local generations, not host behaviour, in rehearsal**: The rehearsal builds two local generations
  whose site, corpus and dataset all differ, stages and rolls them back outside the repository, and
  checks the restored unit (deep link, immutable asset reference, corpus identity, untouched released
  bytes). It never reaches a host: cache/range behaviour, the edge `X-Robots-Tag`, the noindex preview
  and the deployed-tree digest sweep remain unperformed, and the rehearsal prints the exact operator
  steps for them. The demonstrated claim is a local one.
- **Edge header conflict on staged snapshots**: The staged snapshot is not deployable unchanged:
  `firebase.json` sets `X-Robots-Tag: index, follow` for `**`, so a noindex deploy must override edge
  headers. The release record explicitly records both facts (`destination.edgeRobotsHeader` and
  `destination.noindex: true`, verified via `scripts/lib/release-staging.mjs`).
- **Dataset identity is content-addressed; writer bytes are bound one level up**: the dataset's own
  internal `releaseId` used to be `release-<corpus generation date>`, so two byte states from one
  corpus generation shared an id — `outputs/public-dataset.previous` and the 2026-09-04 generation
  recorded in `docs/audit/2026-09-04/TASK-EXPORT-PROGRESS.md` both declared `release-2026-09-04`
  over different SQLite and Excel checksums. It is now `release-<day>-<12 hex>`, sealed through the
  outer release record's own scheme (`sealIdentity`/`releaseIdFrom` in `scripts/lib/release-identity.mjs`)
  over the dataset's declared identity (schema, tool/scanner/policy/search-index/build identities,
  corpus and manifest hashes, counts, rights facets) and one digest per relation whose rows do not
  name the release (`scripts/lib/public-dataset-identity.ts`). Different content or a different
  declared identity therefore cannot produce one id, and a bundle's id can be re-derived from the
  bundle alone, with no corpus, clock or build to consult (`verifyDatasetReleaseId`). What that
  digest deliberately does not cover is serialization: bytes a future writer could change without
  changing rows or declared identity are bound by the release record's `export` section hash and by
  the per-format `sha256` values in the bundle manifest, not by the dataset id.
- **Deliberately outside the release gates**: Neither the staging writer (`scripts/stage-release.mjs`),
  the verifier (`scripts/release-verify.mjs`) nor the rollback rehearsal
  (`scripts/rehearse-release-rollback.mjs`) is wired into `npm run release:gates` (or
  `scripts/run-gates.mjs`). The writer refuses to run without `--mode release` and no gate sequence
  names it; that is the intended boundary, and scheduler integration remains an open owner decision.
- **Descriptor verification**: `npm run verify:release` re-hashes every released byte, re-derives every
  section from the inputs it was staged from, re-derives the whole descriptor from the clean tree,
  tool identities and frozen input inventory, and compares the section contents against the corpus
  manifest and the dataset bundle. A single mutated byte of any bound artifact fails it, and it writes
  nothing.
- **Pointer replacement error handling**: `replacePointer` in `scripts/lib/release-artifacts.mjs`
  still errors with `atomic fixture pointer replacement failed` for staged roots, deliberately, so
  the pre-existing drill's assertion stays untouched.
- **No automated retention/deletion flow**: v1 still has no automated production retention or deletion
  flow. Superseded releases remain preserved on disk for rollback and reproducibility; cleanup
  remains manual, exact-target, reviewable, and subject to owner approval.

The following is the target policy for versioned releases and retention.

## Target policy

- Each release is identified by its immutable `releaseId` and exact artifact hashes.
- A historical release is never overwritten in place. A new release writes to a new
  `releases/<releaseId>/` location under the release root (outside mutable repository source directories).
- Each generated format stages its bytes in an exact sibling staging directory and replaces its
  target only after the staged write succeeds; a failed writer preserves the prior target.
- The current-release pointer is the only mutable part of the catalogue root. Moving it to a newer
  release marks the previous release as superseded; it does not delete the previous artifacts.
- Superseded releases remain available for rollback and reproducibility until an owner-approved
  retention decision permits removal. There is no automatic deletion period in v1.
- Removal, when later approved, must be an explicit dry-run operation that names exact release IDs,
  verifies their hashes, preserves the current pointer, and records a rollback-safe inventory.
- Rollback moves the pointer to a previously verified release without rewriting that release's
  artifacts. A rollback is not a new data transformation.

## Required release metadata

Every release record should preserve its `releaseId`, schema/tool/scanner identities, generation
timestamp, manifest and corpus hashes, relation counts, and format hashes. A release index may add a
`supersededBy` relationship, but it must never infer one from timestamps alone: the pointer history
or an explicit release operation is the authority.

## Owner decisions still required

Before a cleanup job or public release automation is enabled, the owner must approve the retention
period, storage budget, rollback window, and whether old NDJSON/SQLite/Excel artifacts remain public
or move to a private archive. Until then, release writers are append-only by convention and cleanup
is manual, exact-target, and reviewable.
