# SecureFlow v2 Website Release Readiness Report

> Recorded: 2026-09-09
> Branch: `codex/release-v2`
> Implementation owner: Luna
> Independent Gemini review: **PENDING**
> Overall decision: **NOT READY FOR DEPLOYMENT OR PUBLICATION**

This is the Task12 evidence record for the local website build. It records observed local
commands, generated artifacts, and gates that still require an external authority. It does not
promote a release, publish the repository, deploy a website, or claim a full v2 corpus rescan.
The machine-readable matrix is [`release-v2-qa-matrix.json`](release-v2-qa-matrix.json).

> **Dated correction, 2026-10-17.** Three things in this September record no longer describe the
> current checkout; the measurements below stay as dated evidence and are not rewritten.
> (1) The pack row names `@hub/scanner-cli@0.1.0`; the workspace package is now `sfscanner@0.1.0`, and
> `npm pack --dry-run --workspace sfscanner` reports 35 files, 1.5 MB packed / 6.5 MB unpacked,
> shasum `347d658bcb882b0cc6f3fa1a05d363c767f3cee6` (2026-10-17).
> (2) The browser v2 path is now wired in source — `runScanV2` exists at
> `app/src/scanner/run-scan.ts:205` and is used by `app/src/scanner/scanner-client.tsx:9,86` — so any
> statement here that the v2 browser surface is unshipped is superseded. Wiring is not acceptance:
> behaviour, emitted-byte and browser evidence remain open (packets B4a/B4b).
> (3) The `PENDING` comparison counts below are still `PENDING`; nothing has produced a v2 result set
> to compare against, and this correction does not change that.

## Scope and authority

Task11's v2 corpus authority is accepted at `d02476a`; the browser v2 adapter/dual-run is accepted
at `516a2e0`. This run used the committed `data/` directory as local build input. It did **not** run
`npm run corpus`, acquire source data, call a model, or produce a v2 rescan manifest/result-diff
release. Consequently, the current generated corpus identity below is not evidence that all
published entries were rescanned by v2.

The admitted v2 authority identity available to a future authorized rescan is:

| Field | Value |
| --- | --- |
| Scanner/profile | `secureflow-scanner` `2.0.0`; `beta-default` `2.0.0` |
| Engine build digest | `6f2607f641a3d75929cca11c589a44bf640fbf719347bfb374ded2d62fd282d9` |
| Ruleset | `scanner-core-builtins` `2.0.0`; digest `a36d00564bbf8e8c38f05820480782cdc53fdbd3712558850066c4e3f5c3413d`; signature `VERIFIED` |
| Semantics | `scanner-core-builtins` `2.0.0`; digest `fd036def8e7d13b092b6106d90d2dc2c866ac21eb52211a61b583863ccd589ec` |
| Limits digest | `a3baa12d93dab5d07dda3288c0aefa9f7f031b0bc047efd514c9373eb73657d3` |

## Local corpus and generated release identity

The committed input manifest is `data/manifest.json` (`manifest-v1`, generated
`2026-09-04T17:39:08.025Z`). Its byte SHA-256 is
`1096a367dd6a0756bdd3f14efe004c4c1f9a3b22cca806aed07bf41135ea6f01`; its recorded corpus SHA-256
is `8e0a403d456cea6852a30e897cb414f1e50dfb97f277f0886a8121cefdf5c38c`.

| Measure | Observed value |
| --- | ---: |
| Input / published entries | 13,221 / 11,464 |
| Quarantined entries | 1,757 |
| Searchable entries | 11,245 |
| Redistributable / link-only | 288 / 11,176 |
| Official / GitHub sources | 11,069 / 395 |
| Enrichment generated / fallback / upstream | 11,464 / 0 / 0 |
| Scanned / not scanned | 11,464 / 0 |
| Findings | 28,016 occurrences across 8,332 workflows |

The existing data metadata records sanitizer `sanitize-v2-code-stripped`, scanner `c998701`,
Gemini model `gemini-3.7-flash-low`, prompt `describe-6-json-workflow-lexical-check`, description
schema `description-v1`, and compatibility target n8n `2.34.6` (source `npm view n8n version`,
checked `2026-08-16`). These are historical/current committed-data identities, not a v2 rescan
claim.

For directory digests below, `aggregateSha256` is SHA-256 over files in sorted POSIX relative-path
order, updating `relativePath UTF-8`, NUL, file bytes, NUL for each file. This makes the directory
measurement reproducible without claiming that it is an existing release-manifest field.

| Generated path | Files | Bytes | SHA-256 |
| --- | ---: | ---: | --- |
| `data/` (committed input) | 46 | 486,351,230 | `dcd10a2180228b045214360d10a375271e96f3eb7f167dae30ff02c6e38ec232` |
| `data/manifest.json` | 1 | 684,928 | `1096a367dd6a0756bdd3f14efe004c4c1f9a3b22cca806aed07bf41135ea6f01` |
| `app/public/data/` (build staging, ignored) | 46 | 486,351,230 | `dcd10a2180228b045214360d10a375271e96f3eb7f167dae30ff02c6e38ec232` |
| `app/out/` (static export, ignored) | 15,196 | 874,879,936 | `6b0869062ca76285a5d5da799f220b1d9020e452d53ad953e29306593b5abb04` |
| `app/out/data/manifest.json` | 1 | 680,103 | `fb951ac406617d868d8fe6866cf4cf605285299d920ac1d4aa70acbd700db92d` |
| `app/out/sitemap.xml` | 1 | 612 | `bf481d901bc713b587187d0e12c6b8ea7cad10c889215668d2354bcf2b90a4ed` |
| `app/out/sitemap-pages.xml` | 1 | 5,196 | `960f6b356d9304f2c3f2b89ec8f450b790f3d982c3288e70b6eff9c3088ff935` |
| `app/out/sitemap-workflows-1.xml` | 1 | 698,911 | `8e3b0fe5064b1f9439327886d56d1149adaeb9717579e7b0e67a770d55ea7e7d` |
| `app/out/sitemap-workflows-2.xml` | 1 | 692,143 | `9a6b8f19fb1d5d55d1f660b06e716c9b025f3b3d907cb14faa800ef6cd9e4cbe` |
| `app/out/sitemap-workflows-3.xml` | 1 | 171,400 | `f0f176583ca49a4edb8079ecfb7a0b541c31f1a546e5a2f55a072559464e6a9b3`

The build reported 250 Next static pages, 11,214 lean detail pages, 15,196 exported files,
874,879,936 raw bytes, 525,303,487 HTML bytes, 11,291 sitemap URLs (11,816 HTML pages checked),
240 generated OG images, and three favicon assets. It reported zero SEO violations and 611 duplicate
hash groups, all safe.

## Required command evidence

Every command below was run locally in this worktree. Successful commands exited 0. Both generated-asset
aliases resolve to the same `scripts/check-generated-assets.mjs` checker and passed against the local static
export. The build also invokes the checker directly.

| Command | Exit | Exact observed result |
| --- | ---: | --- |
| `npm test --workspace @hub/scanner-cli` | 0 | 22 test files and 156 tests passed. |
| `npm run typecheck` | 0 | Contracts, app, pipeline, scanner-core, scanner-cli, and scripts typechecks passed; route types generated successfully. |
| `npm run check:docs` | 0 | 17 authoritative files checked; total=11,464, searchable=11,245, redistributable=288, linkOnly=11,176, official=11,069. |
| `npm run check:cli-docs` | 0 | CLI documentation parity passed: 4 commands, 13 options, 6 exit codes. |
| `npm run check:scanner-parity` | 0 | 6 valid and 4 rejected profile checks passed; malformed and oversized candidates were rejected as `INVALID_JSON` and `WORKFLOW_TOO_LARGE`. |
| `npm run check:scanner-goldens` | 0 | `ok:true`; 3 valid fixtures, 9 golden checks, 4 rejected checks, `errors:[]`; canonical SHA-256 observations are recorded in the matrix. |
| `npm run check:corpus-privacy` | 0 | 11,464 entries; 7 email addresses across 5 entries (baseline 7); bearer/API key, private IP, and internal hostname counts all 0; gate passed. |
| `npm run check:rights-invariant` | 0 | 11,464 entries: 11,176 link-only and 288 redistributable; zero workflow bodies shipped for non-redistributable entries. |
| `npm run check:scanner-import-boundary` | 0 | 81 production files passed. |
| `npm run check:browser-safe` | 0 | Browser-safe source audit passed (source-only; emitted artifacts require `--emitted`). |
| `npm run check:file-size:all` | 0 | 709 source files checked; new-file limit 200; legacy baselines enforced; tests/fixtures exempt. |
| `npm run build` | 0 | Local static build passed, including corpus integrity, page parity, budgets, SEO, and direct generated-asset integrity. See artifact table above. |
| `npm run check:parity` | 0 | 250 Next and 11,214 lean detail pages; 8 rules each. |
| `npm run check:generated-assets` | 0 | `app/out`: 15,196 files; 0 unsafe duplicate groups; 240 generated OG assets; 3 favicon assets. |
| `npm pack --dry-run --workspace @hub/scanner-cli` | 0 | `@hub/scanner-cli@0.1.0`; 2 files; package 2.9 kB; unpacked 6.1 kB; shasum `20ce3290ca2ad948f6645fea532e2183c9dec255`; dry-run only; the package was later released as `sfscanner`. |
| `npx vitest run pipeline/scan/v2-* app/src/scanner/scanner-v2-adapter.test.ts app/src/scanner/scanner-v2-presentation.test.ts app/src/scanner/scanner-dual-run.test.ts` | 0 | 7 test files and 24 tests passed. |

Both generated-asset aliases passed with the same checker result:
`npm run audit:generated-assets` scanned `app/out` (15,196 files), found 0 unsafe duplicate groups,
240 generated OG assets, and 3 favicon assets.

## Rescan, diff, and rollback evidence

The following counts are deliberately **PENDING**, not zero. No v2 rescan manifest or
`v2-release-report.json` was produced, so there is no honest old/new comparison yet:

| Required comparison | Count | Reason |
| --- | ---: | --- |
| Added workflows | PENDING | Full acquisition/rescan was not run. |
| Removed workflows | PENDING | Full acquisition/rescan was not run. |
| Finding changes | PENDING | No v2 result set exists to compare. |
| Grade changes | PENDING | No v2 result set exists to compare. |
| Analysis-status changes | PENDING | No v2 result set exists to compare. |
| Authority changes | PENDING | No versioned v2 manifest exists. |
| Rights changes | PENDING | No rights-reviewed v2 rescan/package exists. |

Rollback promotion is also **PENDING**: the build produced an ignored disposable static export, but no
versioned v2 release directory was promoted and no old/new manifest-and-shard restoration rehearsal
was run. The committed `data/` input was not overwritten.

## Pending gates and explicit non-claims

| Gate | Status | Reason / next evidence required |
| --- | --- | --- |
| Full authorized corpus acquisition and v2 rescan (`npm run corpus`) | **PENDING** | Would acquire source data and require rights/provenance authority; explicitly out of scope for this offline run. |
| Gemini specification/quality review of this Task12 evidence | **PENDING** | Required independent review has not been observed in this worktree. |
| Real-browser scanner/catalogue/detail/search QA and emitted Worker no-network evidence | **PENDING** | Vitest dual-run tests are not real-browser or deployed-origin evidence. |
| Node 22 clean-install CLI execution on Ubuntu, Windows, and macOS | **PENDING** | Cross-platform CI is external and was not run locally. |
| Official GitHub SARIF schema/ingestion check | **PENDING** | No GitHub ingestion was performed. |
| TestSprite coverage | **PENDING** | TestSprite was not run. |
| No-index deployment and serving-origin QA | **PENDING** | No deployment, hosting upload, headers, cache, or remote route check was performed. |
| Legal/rights approval and production release decision | **PENDING** | Local invariant proves artifact behavior, not jurisdictional or independent approval. |
| Repository publication | **PENDING** | No visibility change was performed; the npm package was released separately as `sfscanner`. |
| Versioned rollback rehearsal | **PENDING** | No v2 candidate was promoted, so there is no release pointer to restore. |

Accordingly, this report makes no claim of cross-platform CI, official GitHub SARIF ingestion,
TestSprite, deployment, publication, legal approval, or full acquisition/rescan. The local build is
usable as engineering evidence only; it is not a production release approval.
