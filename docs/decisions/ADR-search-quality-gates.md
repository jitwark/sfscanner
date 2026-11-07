# ADR: search quality gates

Status: accepted, 2026-08-16; protocol extended 2026-08-30.

The pipeline and browser worker share one MiniSearch configuration. Structured content is indexed
through a sanitized text projection. Release reports use current-corpus relevance metrics and
document zero-result relaxation; the historical stale fixture is not a release gate.

## P4.6 governance contract

The checked-in `relevance-set-v2` fixture records a versioned benchmark protocol:

- `development` is the tuning split and `holdout` is the untouched evaluation split;
- the holdout policy is `untouched-evaluate-once`;
- each case is identified by the deterministic `query+filters+sort-v1` key;
- SHA-256 fingerprints of the development and holdout query sets bind the protocol to the fixture.

The evaluator recomputes both fingerprints and rejects any query key reused across the two splits.
Its report carries the same proof, so the quality gate can reject a report produced from a stale or
mis-partitioned fixture. This is a mechanical non-contamination proof; it cannot audit an external
human tuning process.

An optional candidate/baseline comparison is available when `SEARCH_QUALITY_BASELINE_REPORT` points
to a JSON report produced by the same evaluator. The reports must match on release, corpus, fixture,
and protocol identity. The comparison rejects newly failed development exact/facet cases and
requires explicit owner-approved finite thresholds:

```powershell
$env:SEARCH_QUALITY_BASELINE_REPORT = 'outputs/search-baseline.json'
$env:SEARCH_QUALITY_MIN_HOLDOUT_NDCG_DELTA = '0.01'
$env:SEARCH_QUALITY_MIN_HOLDOUT_RECALL_DELTA = '0.01'
node scripts/check-search-quality.mjs
```

At least one holdout metric must improve by its configured positive delta. No candidate report,
ranking configuration identity, statistical significance claim, or adoption decision is fabricated
by this gate. Without a baseline report and approved deltas, evaluation remains current-release
observational evidence and does not claim that a ranking change is better.
