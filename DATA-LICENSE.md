# Licensing policy pointer

The authoritative licensing terms for code, scanner tooling, and the aggregated catalogue dataset
are in [`docs/LICENSING.md`](docs/LICENSING.md). This file is a pointer, not a separate licensing
policy. That document also states the licence split (MIT code, personal/non-commercial aggregated
catalogue), how the catalogue rows were acquired, why 67 rows carry a `not-scanned` scanner stamp
whose reason is `source_unavailable` — their body exists, but the upstream source could not be
re-acquired, so no current-contract verdict could be produced — and that the search relevance
judgments are agent-derived rather than human-reviewed. Those 67 are a subset, not the whole
unscanned population: the corpus has 398 unscanned rows, the other 331 having no body at all. No
workflow JSON is distributed with the catalogue.
