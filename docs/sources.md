# Sources and workflow rights

> Status: current
> Last verified: 2026-08-30
> Owner: n8n-Secureflow Community Maintainers
> Source of truth: `pipeline/sources.json`, `pipeline/rights/`, and the release manifest

n8n-secureflow builds its catalogue from the active records in `pipeline/sources.json` and from official n8n template metadata. The source registry records the repository or API source, branch, inclusion rules, known licence result, review date, and reason for inclusion.

## Official metadata policy

The Community Hub treats the 11,069 official n8n templates in the current packaged corpus as
metadata-only directory records. It publishes locally derived structural attributes, deterministic
policy results, and original descriptions generated from sanitized workflow topology; it does not
publish the official workflow JSON. Official entries remain link-only and point readers to their
canonical n8n page. This is an operational publishing policy, not a conclusion about the legal
status of any upstream work.

## Provenance

Every catalogue entry **records** its upstream permalink and, for GitHub sources, the commit and path used during acquisition. The pipeline rejects a workflow when it cannot establish this provenance. Deduplication keeps one canonical entry while retaining duplicate source references for auditability.

Recorded is not the same as published. The upstream permalink **is** shown on the detail page. The acquisition commit and source path are **audit-only**: the detail fact contract marks both `not_public`, and they are deliberately not rendered. Treat them as evidence retained for rights and takedown review, not as public metadata.

## How the rows were acquired

Acquisition is automated and re-runnable: repositories are cloned through the git object database
(`--no-checkout`) and the official n8n template API is paged. For each entry the pipeline records
`source.kind`, `source.repo`, `source.owner`, `source.path`, `source.commit`, `source.committedAt`,
`source.permalink`, `source.fetchedAt` and, for official rows, `source.templateId` and `source.author`.
The commit is recorded so a file can be re-read at the exact revision the facts came from instead of at
today's default branch, and the permalink is a commit-pinned upstream URL. `docs/LICENSING.md` describes
the acquisition method in full and the licence split it is published under.

## Rows that could not be re-read

A row whose upstream repository no longer resolves cannot be re-scanned, and saying nothing about that
would leave a stale verdict indistinguishable from a current one. Those rows carry an explicit marker
instead: `security.scannerVersion` is `not-scanned` and `security.stampReason` is `source_unavailable`.
As of 2026-09-27 that is 67 rows, all from one repository whose files returned 404; the remaining 221
rows of the former redistributable set were re-fetched and re-scanned. `data/analytics.json` counts them
separately (`scanCoverage.sourceUnavailable`) rather than as rows with no body, because a body did exist.

The relevance judgments behind the search benchmark are **agent-derived** and not human-reviewed; see
[`SEARCH-QUALITY.md`](SEARCH-QUALITY.md) for what that does and does not claim.

## Rights policy

Every one of the 11,464 published entries is link-only. The release serves derived facts — description,
security analysis, graph, readiness, structure — and a link to the recorded upstream permalink; it
serves no workflow JSON at all, and it carries no download packs.

A row could be redistributable only with a recorded per-item licence instrument from the same commit.
On 2026-09-27 no row carried one, so the F-001 ruling moved the last 288 redistributable rows to
link-only — the same publishing state the other 11,176 rows already had — and the packs that held their
bodies were emptied in the same change.

An entry is link-only when no per-item licence evidence is recorded, when its source licence is outside
the pipeline's SPDX policy, when it is an official n8n template, or when it matches an official template
mirrored by another repository. Link-only entries remain searchable because their displayed description,
security analysis, graph, and readiness facts are independently derived rather than copied.

Official n8n templates are acquired for local deterministic analysis only and always link back to their canonical n8n page. They are not relicensed by n8n-secureflow or by a third-party mirror.

## Propose a source

Open a pull request that adds a reviewed record to `pipeline/sources.json`. Include the repository URL, branch, file inclusion/exclusion patterns, current licence evidence, a concise provenance note, and review date. Do not add private sources, content without stable upstream URLs, or sources that require credentials.

The generated [`ATTRIBUTIONS.md`](../ATTRIBUTIONS.md) lists every configured source and its current canonical-entry count.
