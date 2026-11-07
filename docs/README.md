# Documentation index

> Status: current
> Last verified: 2026-10-27 (maintenance status and routing pointers; generated inventory awaits controller finalization)
> Owner: Community Hub maintainers
> Source of truth: `data/manifest.json` and gate exit codes

This index separates current guidance from historical evidence. Counts, hashes and release
readiness come from the manifest and the gates; prose does not silently replace them, and
`npm run check:docs` fails if it tries.

## Start here

- [October 17 completion plan](superpowers/plans/2026-10-17-project-completion.md) and [implementation-agent handoff](superpowers/specs/2026-10-17-project-completion-HANDOFF.md) — independently reviewed planning for the October audits; no implementation was performed in that planning session. Execution started 2026-10-17: per-packet reports, reviews and receipts live in [`audit/2026-10-17-remediation/`](audit/2026-10-17-remediation/), and the live state stays in [Release status](../STATUS.md).

- [README](../README.md) — what the project is, how to run it, and the measured catalogue.
- [Current maintenance handoff](audit/2026-10-27-project-direction/HANDOFF.md), [operator how-to](audit/2026-10-27-project-direction/MAINTENANCE-HOWTO.md), and [project workstate](audit/2026-10-27-project-direction/WORKSTATE.json) — guarded command implementation, evidence boundary, and next review/run action.
- [Release status](../STATUS.md) — current state, gate evidence, known gaps. **The single
  live status document.**
- [Architecture](ARCHITECTURE.md) — how the pipeline, site, search and scanner fit together.
- [Security](SECURITY.md) — threat model, the CSP, and accepted risks.

## Product and data contracts

- [Content contract](CONTENT-CONTRACT.md) — what a description may and may not say
- [Enrichment policy](ENRICHMENT-POLICY.md) — the model input boundary and recovery rules
- [Data lifecycle](DATA-LIFECYCLE.md) — staging, synchronisation, promotion, rollback
- [Sources and rights](sources.md) — where workflows come from and what we may republish
- [Privacy](privacy.md) — the local-processing policy
- [Takedown procedure](takedown.md) — removal requests
- [Workflow page information architecture](UI-WORKFLOW-PAGE.md)

## Search

- [Search quality](SEARCH-QUALITY.md) — configuration and the metrics policy
- [Semantic search architecture](search/semantic-search.md)
- [Performance budgets](perf/budgets.json) — current provisional machine-readable ratchets

## Decisions, audits, and operations

- [Architecture decision records](decisions/)
- [Whole-project audit, 2026-09-04](audit/2026-09-04/) — eleven reports covering repository
  hygiene, the scanner and CLI, the website, the corpus and exports, documentation, the public
  repository, gate execution, community research, and the design migration. Start at
  [`99-FINAL-REPORT.md`](audit/2026-09-04/99-FINAL-REPORT.md).
- [Production readiness programme](plans/2026-09-04-production-readiness-programme.md) — the
  executable plan, with its [adversarial review](plans/2026-09-04-adversarial-review.md) and
  [implementation log](plans/IMPLEMENTATION-LOG.md).
- [Earlier audit packets](audit/HISTORY.md) — nine superseded packets, removed from the working
  tree on 2026-09-04 and recoverable from git history.
- [Community needs and comparable products](research/2026-08-26-community-needs-and-comparables.md)
- [Scanner false-positive review](scanner-false-positive-review.md)
- [Enrichment recovery runbook](recovery/2026-08-16-enrichment-recovery-runbook.md)
- [Documentation maintenance](DOCUMENTATION-MAINTENANCE.md) — how to keep this set accurate

## History

- [Archive](archive/) — superseded plans, phase records and status snapshots, kept as
  evidence rather than deleted. Every file names what replaced it.
- [Build history](archive/BUILD-HISTORY.md) — the measured build record, including the
  thirty-two defects found and fixed during integration.
- [Session handoffs](plans/2026-09-04-production-readiness-programme.md) — narrative of how the work proceeded.

Nothing in the archive is maintained. Treat its measurements as historical: they describe the
corpus and gates of their own era, and the gate refuses to let them claim otherwise.
