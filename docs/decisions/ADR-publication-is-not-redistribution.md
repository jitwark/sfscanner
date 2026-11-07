# ADR: Publication is not redistribution

> Status: accepted
> Date: 2026-08-26
> Owner: Community Hub maintainers
> Supersedes: the rights test inside `isIndexable`

## Context

`contracts/indexability.ts` gated `isIndexable` on
`rights.status === 'redistributable'`. That single condition governed crawler indexing,
pre-rendering, hub membership and the sitemap.

The 2026-08-25 audit demoted a source that could not license what it had collected, taking
redistributable entries from 2,041 to 288. The coupling then made its own cost plain: a
13,221-entry catalogue offered a crawler **287 pages**, and 12,933 fully analysed workflows were
invisible to search engines.

The coupling predates that demotion. What the demotion changed was how expensive it was.

## Decision

**`isIndexable` no longer asks about redistribution rights.** What remains is a quality floor:
a canonical entry, a publishable description, at least three functional nodes, at least one
integration. 287 → 12,923 entries.

Redistribution stays gated, in exactly one place: `app/src/catalogue/download.ts`.

## Why these are different questions

A detail page publishes facts this project derived — node structure, integrations, a trigger
type, a complexity band, a deterministic security grade, a generated description written from
model-safe JSON, a chart computed locally — together with attribution and a deep link to the
source. It does not reproduce the workflow JSON. For a link-only entry the file stays upstream
and the page sends the reader there.

That is what a directory does. Cataloguing a work, describing it, and linking to it is not
republishing it, and the project had already accepted this reasoning once: `isSearchable` was
split from `isIndexable` on exactly these grounds, because gating *finding* a workflow on
permission to *host* it hid 11,180 entries. The same argument applies to a page.

Two boundaries were checked before deciding, and both hold:

- **We never republish official n8n workflow JSON.** Unchanged. 11,081 official templates are
  link-only and remain so; their pages carry derived facts and a link to n8n.io.
- **Attribution.** Every page names the upstream author, repository and licence, and links to
  the permalink. Publication makes attribution more visible, not less.

## Consequences

- Indexable entries 287 → 12,923; sitemap URLs 296 → 12,969.
- Hub membership is gated on the same predicate, so tag and integration hubs grew. The legacy
  tag-pagination stubs went from ~52 pages to 982 before their depth was reduced to 5.
- Every workflow needed a page. Next could not write 12,923 of them inside the GitHub Pages
  ceiling, which is why a second generator exists — see `docs/ARCHITECTURE.md`.
- The SEO-3 gate in `pipeline/enrich-corpus.ts` divided by *redistributable canonicals* and
  became unfailable at 4,487%. Its denominator is now canonical entries.

## What would reverse this

A takedown, a licence, or a source's terms that forbid describing or linking a work — as
distinct from copying it. `docs/takedown.md` is the channel; a removal takes the entry out of
the corpus entirely rather than only out of the index.

If a specific source's terms are found to prohibit indexing derived facts, that source becomes a
per-source exclusion in `pipeline/sources.json`, the way `redistribute: false` already works —
not a return to a corpus-wide rights gate on publication.
