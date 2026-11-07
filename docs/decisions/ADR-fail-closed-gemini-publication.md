# ADR: fail-closed Gemini publication

## Decision

Production enrichment runs require `--require-gemini`. Gemini receives only the model-safe workflow JSON projection. If the model times out, returns invalid structure, or violates the description contract after retries, the pipeline records an `enrichment-rejections.json` row and stops packaging. It never substitutes deterministic fallback prose, upstream prose, or a partially enriched entry into a published catalogue.

## Why

Fallback prose made pages look complete while hiding that enrichment had not happened. A failed run is visible and recoverable; a plausible but ungrounded page is not.

## Consequences

The full corpus cannot be promoted until every canonical entry has a valid structured Gemini description. `--only-described` is available for a review preview, but it is not a production release. Checkpoints remain resumable and rejected IDs are retried after prompt or validator changes.
