# Enrichment policy

> Status: current
> Last verified: 2026-08-29
> Owner: Enrichment maintainer
> Source of truth: `pipeline/enrich/describe.ts`, `pipeline/enrich/describe-system.txt`, and `contracts/index.ts`

Status: active on `codex/community-hub-fixes` (2026-08-16).

Gemini is an optional prose writer. It is not the source of truth for rights, security grades, node counts, readiness, charts, or search facets. Those values come from deterministic pipeline code.

## Input boundary

The model receives an ordered array of model-safe n8n workflow JSON objects and nothing else. The projection removes website/source metadata, titles and root identifiers, credentials, pinned data, execution identifiers, secrets, and executable code bodies. `pipeline/enrich/describe-spawn.ts` audits the projected packet before writing the temporary file. `scripts/audit-gemini-input.mjs` can audit a captured packet offline.

Upstream descriptions are never passed as context. They are not used as a fallback when the model is called. A workflow without a retained JSON body is not sent to Gemini; in production it remains staged as an unresolved rejection and cannot be packaged or published. Deterministic fallback prose exists only in legacy unit fixtures and migration evidence.

## Output boundary

The model returns one structured object per workflow, in ordinal order. The validator requires a headline, summary, outcome, before/after explanation, labelled hypothetical example, ordered steps, limitations, and audience. It requires at least 300 words when evidence supports it and rejects URLs, secrets, unsupported services, licensing claims, costs, timing claims, security verdicts, and ungrounded reliability claims. A proper service or feed name that happens to contain a licensing token is not treated as a licensing claim, and an ordinary noun such as “box” is not treated as an integration unless the workflow evidence identifies that integration.

The UI renders these fields as escaped React text. Deterministic readiness and security panels remain separate from model prose.

## Recovery rules

Every checkpoint carries a workflow-input hash, sanitizer version, prompt hash/version, schema version, and model; generated catalogue provenance carries the same identity plus its generation timestamp. Legacy fact-packet checkpoints are incompatible and are retained only for rollback evidence. Live calls require `--allow-live-gemini`; description/package generation also requires `--generated-at <ISO-timestamp>` or `SOURCE_DATE_EPOCH`, so no release timestamp comes from the wall clock. Packaging a live run requires `--staging-dir` and `--require-gemini`. The production runner refuses to start without the fail-closed flag. A package gate rejects fallback descriptions, unproven generated descriptions, and every canonical entry that is not `descriptionSource: generated` with valid `descriptionContent`; it never writes deterministic fallback prose. Tests and builds never call Gemini.

Enrichment is batch-resilient: a rejected workflow is removed from the checkpoint, recorded with its reason and ID in the batch ledger, and does not prevent later batches from running. A describe-only run may finish with unresolved IDs for a targeted retry; any packaging run fails closed until every canonical entry has verified Gemini content. Retries are bounded and reuse already verified checkpoint entries, so a resume does not spend tokens on successful workflows.
