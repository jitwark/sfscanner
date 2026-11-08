# Data availability

Status: published link-only V4 dataset, verified November 8, 2026. The current UI overhaul does not change the dataset or grant new redistribution rights.

## Source checkout and release artifacts

The selected public repository contains scanner/site/pipeline source, contracts, examples, tests and release tooling. It deliberately excludes private generated corpus inputs, native evidence and raw workflow bodies. Source-only CI runs source gates and source tests; a source checkout alone is not a complete catalogue build input.

The [v0.2.1 release](https://github.com/jitwark/sfscanner/releases/tag/v0.2.1) separately publishes the qualified dataset ZIP, checksums, licences and release record. Its public-data-model-v4 bundle includes 18 NDJSON relations, SQLite schema v3 and a 12-sheet Excel workbook. All five actual cross-format reopening checks pass. Verify the downloaded files against SHA256SUMS and the manifests inside the bundle.

Both [Pages](https://jitwark.github.io/sfscanner/) and [Firebase](https://n8n-enterprise-1.web.app/sfscanner/) serve the qualified static catalogue baseline. New UI bytes are not qualified merely because the old site is live; see [programme status](scanner/programme-status.md).

## Rights and evidence boundaries

- All 11,464 records are link-only; zero workflow bodies are redistributable. Public metadata records provenance and upstream coordinates without proxying the original workflow JSON.
- The release passed its configured rights, privacy, extraction and governance controls. A public upstream URL or repository licence alone does not grant redistribution rights. See [licensing](LICENSING.md) and [sources](sources.md).
- The configured dataset sweep examined 2,935,097 string leaves with zero email/token/private-IP/internal-host matches; this does not certify arbitrary future content.
- Sixty-seven entries are source-unavailable: the pinned upstream source could not be reacquired. That does not establish deletion, archival, offline operation or safety. Three inputs have no body and fifteen scans explicitly returned NO_RESULT.
- Search/relevance judgments are agent-derived; no independent human relevance sign-off is claimed. Dated search experiments are described in [search quality](SEARCH-QUALITY.md).

The canonical measured census and formal semantic limits are in [programme status](scanner/programme-status.md). Do not copy private data into public source or infer model coverage from a completed scan.
