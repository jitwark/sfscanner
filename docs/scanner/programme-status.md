# Scanner implementation and verification status

## Current measurement — November 7, 2026

The real frozen scan and retained-record replay completed in 1,378.05 seconds and
431.98 seconds respectively. Their formal coverage objects are byte-identical and conserve
the 11,464-row inventory; SHA-256:
`3dc4ddb8201abf3fcb2286b6bd69a53519039763602057c2afb4a12c18ef07b1`.

**The original programme's 95% reviewed-instance and 90% fully-modelled-workflow targets
were MISSED.** They are measured failures, not pending measurements or achieved targets.

| Formal coverage measure | Actual result | Target |
| --- | --- | --- |
| Reviewed executable instances | 112 / 144,043 (0.0777545594%) | >=95% — MISSED |
| Fully modelled workflows | 0 / 9,669 (0%) | >=90% — MISSED |

The reviewed executable scope is only exact `n8n-nodes-base.gmail` version `2.2.0`
(normalized node version 2.2), message resource, and nine literal operations:
`addLabels`, `delete`, `get`, `getAll`, `markAsRead`, `markAsUnread`,
`removeLabels`, `reply` and `send`. An absent resource uses the pinned message
default; unknown/dynamic selectors, other versions/resources and `sendAndWait` do not count.
There are 112 reviewed nodes across 67 workflows; none has every executable node reviewed.

The formal cohort contains 9,669 workflows with executable official-package nodes.
Its 1,795 exclusions are 1,671 community-package workflows, 54 invalid node identities,
67 source-unavailable and 3 missing inputs. There are zero unknown measurements,
malformed inputs or rejected inputs. The 52,222 reviewed inert nodes in the cohort
are counted separately from executable instances. `COMPLETE / FULL_COHORT` describes
measurement completion with explicit exclusions; it does not establish safety or complete
semantic understanding. The misses remain full-programme failures and first-release limitations.

The replayed candidate data contains 11,379 current results: 1,065 COMPLETE,
10,119 DEGRADED and 195 INDETERMINATE; 15 NO_RESULT, 3 UNSCANNED and
67 SOURCE_UNAVAILABLE rows complete the census. No historical verdict is carried into this
candidate. These result states measure execution/freshness, not reviewed semantic coverage.

Legacy type/version catalogue matching is separate: 1,107 observed types across
236,378 instances; 29 types catalogue-matched, 10 partly matched and 1,068 unmatched.
There are 187,474 matching instances. These counts describe resolver record matches,
including nodes outside the formal executable cohort; they do not demonstrate reviewed
resource/operation scopes or detection accuracy. The earlier 26 / 9 / 1,072 counts and
76.90%/79.31% descriptions below retain their dated meanings.

## Dataset and delivery qualification

The initial V4 export completed in 97.47 seconds; the canonical-metadata repair
was regenerated in 99.45 seconds. The repaired candidate is
`release-2026-11-07-9edb75aa0898`, format `public-data-model-v4`: 18 logical relations,
18 NDJSON relation files, SQLite and a 12-sheet Excel workbook.

**The repaired dataset passes all five actual reopening checks.** The original Excel
metadata ordering failure and subsequent test timeout remain preserved as failed
receipts. Canonical metadata serialization fixed the format mismatch; reusing the same
test's parsed workbook rows reduced repeated ZIP inflation without changing assertions
or its 60-second budget. The full five-case run completed in 94.41 seconds.

The actual NDJSON privacy sweep examined 2,935,097 string leaves with zero email/token/
private-IP/internal-host matches. Its captured zero-match baseline comparison passes.
This qualifies the dataset formats and configured privacy checks. A fresh Node 22
retained-record replay after the Excel repair completed in 402.40 seconds, preserving
all measurements, exclusions, inventory and runtime bindings; only the expected
producer-source hash changed. Subsequent source-binding replays preserve the same
measurements. The release-bound formal-coverage SHA-256 is
`5f11d613316bac019dc5275e7cd23431704823ebcdbab518ee5977b5d749e5a1`, with producer
`958e5efb5fc8b11bad741035be294eeb662db913bd7871d6b0dfc0a0a49e5ae5`.

Candidate identities from the actual export:

| Artifact | Bytes | SHA-256 |
| --- | ---: | --- |
| `public-release.json` | 1,598 | `0e103f9444d5b0ae0ad6dd9e9dceb4b8b8310fc1145582add28b77ab93c205f6` |
| `release.sqlite` | 236,318,720 | `5d8920cbb64f758753740efb9ccfb5a754e5489596bead6ece701f545fbce1a3` |
| `release.xlsx` | 39,089,573 | `0b0d6f46d2de10a1fe64ac159c7d7fab406ec16e116270f34c7830a3125af717` |
| `ndjson/public-release.json` | 3,058 | `b159c952786785e524f7ca0a2bec8e761fe6415fce692af7c8e736d28f3ebeee` |

Source manifest SHA-256:
`40177ed565aa1babb1004e5124c8a9b455f215ff8777bfb5f80b029401a74479`.
Corpus SHA-256:
`025e8707c8a9c93d99e6f191e9e23ec73403b7af0e2f419695857e32cd9ab634`.
Only the workbook and root manifest bytes changed during the export repair. The NDJSON
files, SQLite archive and sealed logical dataset identity match the preserved initial export.

The verified candidate is promoted into `data/` and `outputs/public-dataset/`. Every
promoted file matches its staged size/hash, and the prior local trees are preserved externally.
The [v0.2.1 release](https://github.com/jitwark/sfscanner/releases/tag/v0.2.1) provides
the qualified dataset ZIP, CLI archive, checksums, notices, SBOM and release record.
The anonymous npm download of `sfscanner@0.2.1` matches the qualified archive:
`0aff150fbbe9422d1106d66b7c245ba27be8f8cbaf7e162212dd3963bfc5afd7`.
Its retained package verification passes all 23 controls.

The website is live on [GitHub Pages](https://jitwark.github.io/sfscanner/) and
[Firebase](https://n8n-enterprise-1.web.app/sfscanner/). The accepted production build
passes 86 browser cases; each live host passes eight additional scanner browser cases.
The release source and subsequent delivery-only repair each pass all six hosted CI jobs.
Full anonymous readback on each host verifies all 15,198 application files /
866,485,610 bytes. Each host also passes six live catalogue search, hydration and link checks.

Website labels describe available evidence: model-only graded limitations may render
`Standard scan`; mixed or unknown limitations remain `Partial analysis`, and null
assessments never invent a grade. Completion does not establish safety or full semantic
coverage. Model expansion remains a v0.3.0 plan; no new models are included here.
The measured scanner snapshot and exact retained-record replays remain preserved.

## Dated history — October 27–29, 2026

The following checkpoint text is retained as historical evidence, not current status.
Private audit/plan receipts are named for local traceability without public links to excluded
files; the original dated receipt files remain unchanged.

**Latest Candidate8 status-only verification — October29:** report (private receipt: `REPORT.md`), source findings (private receipt: `SOURCE-REVIEW.md`), candidate/requirements (private receipt: `CANDIDATE-REQUIREMENTS.md`), and public delivery (private receipt: `DELIVERY-REVIEW.md`). Candidate8is locally staged; CLI readiness is integrated. Original product/quality acceptance and public delivery remain open. Earlier review banners below are historical. No new plan or prompt.

**Current October29 review:** report (private receipt: `REPORT.md`), plan (private receipt: `2026-10-29-product-integration-and-delivery.md`), prompt (private receipt: `IMPLEMENTATION-START-PROMPT.md`). Candidate6 completed9maintenance steps and staged locally; fresh live audit is clean. Exact staged-output reopen proof is open because the fixed fixture differs. Unintegrated readiness/privacy modules have reproduced defects. Original B1–B5,48criteria and quality admission remain. Public surfaces have not been updated to this local work. Below is dated October27 evidence, not current-action priority.

2026-10-27. This is the current scanner entrypoint; repository status (historical STATUS.md reference) and plan of record (historical PLAN.md reference) govern execution. The canonical master (private receipt: `MASTER-REPORT.md`) retains the dated audit history.

- Prior exact-budget and SemVer boundary fixes are retained. The new source receipt now hashes required production/configuration files, fails on missing/unreadable/symlinked paths including intermediate junctions, and validates previous-run identifiers before setup/acquisition. See repair evidence (private receipt: `RECEIPT-REPAIR.md`) and independent review (private receipt: `RECEIPT-FINAL-REVIEW.md`).
- Filter now declares the single Main output supported by the pinned upstream V1/V2 implementations. Catalogue/CLI digest pins agree. All149receipt-listed file hashes verified; package-local static source closures improved. These remain limited models, not complete field/operation semantics. See semantic repair (private receipt: `SEMANTIC-REPAIR.md`) and fresh review (private receipt: `SEMANTIC-FINAL-REVIEW.md`).
- Stored corpus evidence is pre-batch:181782/236378resolver-matched instances(76.90%), with136COMPLETE/11048DEGRADED/195INDETERMINATEamong11379storedCURRENTrows. The187474/236378(79.31%)number is a resolver projection over old inputs. It is not a new rescan or semantic-accuracy result. StoredCURRENTmust be re-adjudicated against the newly changed source/semantics identity.
- The original95%reviewed executable-instance and90%fully-modelled-workflow targets in the declared built-in supported cohort, authentic quality, resource, browser/CLI parity and release requirements remain open. No whole-scanner percentage or final ETA is established by this review.
- The real scanner-rescan is terminal: inventory, full regeneration, candidate-only data promotion and public export passed; release gates passed full source size (941 files) and specs (20 packages), then failed at four missing metadata fields in the frozen candidate STATUS.md. The live source metadata is repaired. No build, packed CLI, data commit, stage or final verification ran. This is a local preparation failure; the failed run and outputs are preserved. Fresh isolated candidate: 11,379 CURRENT / 15 NO_RESULT / 3 UNSCANNED / 67 SOURCE_UNAVAILABLE; among CURRENT, 1,225 COMPLETE / 9,959 DEGRADED / 195 INDETERMINATE. Its report measures 187,474 MODELLED / 236,378 observed instances (79.3111%). This is catalogue matching on that candidate, not detection accuracy, original supported-cohort acceptance or active-source data replacement. See the new plan (private receipt: `2026-10-27-final-maintenance-qualification.md`) and start prompt (private receipt: `IMPLEMENTATION-START-PROMPT.md`).
- Owner-authorized legacy sitemap retirement is recorded in B07-RETIREMENT.json (private receipt: `B07-RETIREMENT.json`). This resolves the local owner decision; it does not prove a deployment or external withdrawal.

The narrower product direction is offline pre-import and CI review, followed by explicit target-version compatibility. COMPLETE describes the admitted analysis scope; it does not certify a safe or executable workflow. See ecosystem research (private receipt: `ECOSYSTEM-RESEARCH.md`) for evidence and demand limitations.
