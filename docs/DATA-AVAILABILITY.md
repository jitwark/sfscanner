# Data availability

Status: engineering pre-release. The current checkout contains generated catalogue artifacts for local
engineering and review, but they are not approved for public redistribution.

The selected public-repository extraction is intentionally source-only until the owner confirms the
release rights and the independent legal review is complete. It includes the scanner, static site,
pipeline, CLI, contracts, examples, tests that do not require the private generated corpus, and release
tooling. It does not include the current `data/`, `app/public/data/`, or acquired workflow fixture corpora.

An approved release must add a versioned, provenance-complete data bundle produced by the corpus
pipeline and pass the release gates, including rights, privacy, hash, graph-coherence, extraction, and
legal checks. Do not infer permission from a public upstream URL or repository licence. Until that
release record exists, the code-only public tree is not a deployable catalogue snapshot and local
generated data must not be copied into a public repository.

## What the catalogue artifact contains today (2026-09-27)

- **11,464 published entries, every one of them `link_only`.** No workflow JSON is distributed by this
  release: it carries no download packs and no entry carries a download pointer. Each entry publishes
  derived facts and its recorded upstream coordinates. See the
  [authoritative licensing policy](LICENSING.md) for the licence split (MIT code, personal/non-commercial
  aggregated catalogue) and how the entries were acquired.
- **67 entries carry a recorded `not-scanned/source_unavailable` stamp**, because the repository that
  hosted them no longer resolves and their files could not be re-read for a fresh scan. The other 221 of
  the former 288 were re-fetched and re-scanned.
- **Search/relevance signaling is agent-derived and not human-reviewed.** The relevance fixture's
  judgments come from multi-agent adversarial review with arbitration; independent human sign-off is
  outstanding. See [`SEARCH-QUALITY.md`](SEARCH-QUALITY.md).

See also [`docs/sources.md`](sources.md) and the internal release plan for the pending decisions.
