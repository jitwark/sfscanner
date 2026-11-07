# Data lifecycle

> Status: current
> Last verified: 2026-08-29
> Owner: Pipeline maintainer
> Source of truth: `pipeline/build-corpus.ts`, `pipeline/package/`, and `scripts/validate-corpus-integrity.mjs`

1. Acquisition retains source workflow bodies locally and records rights and provenance.
2. Sanitization removes credentials, secrets, pinned data, workflow metadata, executable code bodies, and execution residue. The model-safe projection applies a stricter boundary for external prose generation.
3. Deterministic derivation computes structure, charts, readiness, scanner findings, facets, and search fields.
4. Gemini enrichment writes only staged checkpoints and structured prose. Each record carries a full enrichment identity.
5. Packaging writes catalogue shards, charts, packs, search index, semantic index, facets, release metadata, and a manifest to a fresh staging directory. `--generated-at`/`SOURCE_DATE_EPOCH` supplies the shared release clock; artifact paths use locale-independent ordering. Extra manifest-owned files fail validation.
6. `scripts/check-data-sync.mjs` must prove that `data/` and `app/public/data/` match byte-for-byte before a browser build.
7. Promotion is an operator decision after privacy, content, corpus, search, documentation, and UI gates pass. The previous catalogue and scoped backup remain recoverable.

`data/` and `app/public/data/` are generated artifacts. Do not hand-edit them or treat a copied directory as proof of synchronization.
