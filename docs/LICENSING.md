# Licensing

This is the authoritative licensing policy for the Community Hub.

- **Application and scanner tooling:** MIT. See [`../LICENSE`](../LICENSE).
- **Aggregated workflow catalogue dataset (`data/`), including derived metadata and generated descriptions:** Personal / Non-Commercial.
- **Individual workflow bodies:** none are distributed. See "What the catalogue does and does not distribute" below.
- **Third-party dependencies:** retain their own licence terms. See [`../THIRD_PARTY_NOTICES.md`](../THIRD_PARTY_NOTICES.md).

> **Licence authority:** the binding terms are MIT for application/scanner code and Personal /
> Non-Commercial for the aggregated catalogue dataset. That is the existing grant, not a relicense.
> The public tree's `docs/REPOSITORY-MODEL.md` still carries a stale CC BY-SA 4.0 header for derived
> catalogue metadata; the public documentation extraction corrects it as a documentation fix, so it
> is an unresolved public-only extraction defect. No CC BY-SA authority is asserted here, and no
> upstream licence is inferred from either statement.

## What the catalogue does and does not distribute

Since **2026-09-27** every one of the 11,464 published entries is **link-only**. The release ships derived
facts — description, structure, security findings, readiness, the workflow graph — plus the recorded
upstream coordinates of each workflow. It ships **no workflow JSON at all**: the release carries no download
packs, and no entry carries a download pointer.

Before that date 288 entries were marked redistributable and their sanitized bodies were served from those
packs. The owner ruling of 2026-09-27 (audit F-001, RULING-2 = C) moved all 288 to link-only because none
of them carried recorded per-item licence evidence (a licence instrument from the same commit as the
workflow, with a recorded digest). A repository-level licence was not treated as evidence that the
repository's authors held the rights to every workflow it mirrored.

Keeping the recorded upstream licence per row is deliberate. `rights.licence` and `rights.licenceUrl` on
those rows still name what the upstream repository declared (201 Apache-2.0, 87 MIT, across five
repositories); they are a record of what was observed upstream, **not** a licence under which this
project distributes anything. 75 other link-only rows have carried a licence field the same way.

## How the entries were acquired

Entries are acquired by automated pipeline runs: public GitHub repositories are cloned through the git
object database (`--no-checkout`), and the official n8n template API is paged. Each entry records the
coordinates its facts came from, and those coordinates are what a reader can check:

- `source.kind` — `github` or `n8n_official`;
- `source.repo`, `source.owner`, `source.path` — the repository and the file the workflow was read from;
- `source.commit` and `source.committedAt` — the exact revision, so the file can be re-read at that
  revision rather than at today's default branch;
- `source.permalink` — the published, stable upstream URL (a commit-pinned `blob/` URL for GitHub rows);
- `source.fetchedAt` — when the pipeline read it;
- `source.templateId` and `source.author` for official-library rows.

The publish/audit split in [`sources.md`](sources.md) applies: the permalink is shown on the entry page,
while the commit and the file path are retained as audit evidence and are not rendered. The upstream
declared licence for each configured source is listed in [`../ATTRIBUTIONS.md`](../ATTRIBUTIONS.md).

## The `not-scanned/source_unavailable` stamp

Of the 288 rows that were redistributable, **67 (23%)** carry
`security.scannerVersion: "not-scanned"` with `security.stampReason: "source_unavailable"`. Their
recorded upstream coordinates are all in `murataslan1/n8n-workflow-collection`, and that repository no
longer resolves: the pipeline's 2026-09-27 re-fetch attempt returned 404 for it, so those workflow files
cannot be re-read at the recorded commit.

Those rows therefore ship the verdict recorded before that attempt, unaltered, with the reason stated in
the artifact rather than left ambiguous. They are counted separately in `data/analytics.json`
(`scanCoverage.sourceUnavailable`) and are **not** counted as entries with no body: a body did exist and
was analysed.

The remaining 221 rows of that 288-row set were re-fetched from their recorded commits and re-scanned in
the 2026-09-25 rescan. That scan is no longer a scan of shipped bytes: the 2026-09-27 link-only flip
removed all 288 bodies, which is why those 221 rows are exactly the entries carrying a retained
`security.analysisStatus: COMPLETE` while their readiness is `unscanned`. A retained verdict on a row
whose body no longer ships is history, not a current result, and no export may present it as a
current-engine grade — the public schema work (packets C2a and D1a) exists to make that distinction
explicit rather than implied.

## Search and relevance scoring: agent-derived, not human-reviewed

Ranking is measured against a versioned relevance fixture whose judgments are **agent-derived** —
multi-agent adversarial review with arbitration — and independent human sign-off is outstanding. See
[`SEARCH-QUALITY.md`](SEARCH-QUALITY.md) for what that measurement does and does not claim. No licence,
rights status, security verdict, or published count is derived from model output.
