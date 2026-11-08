# Architecture

> Release reconciliation — November 8, 2026: this is an architecture reference. Older corpus counts and footprint measurements in dated sections are historical, not current release metrics. The qualified release has 11,464 link-only records; current release and in-progress UI scope are described in [programme status](scanner/programme-status.md).

> Status: current
> Last verified: 2026-09-04
> Owner: Community Hub maintainers
> Source of truth: the code in `contracts/`, `pipeline/`, `app/`, and `packages/`

How the system fits together, and the reasoning behind the boundaries that matter. Where this
document and the code disagree, the code is right and this document is a bug.

---

## The shape of it

Five npm workspaces and one artifact directory. Release manifests are versioned as `manifest-v1`
and are parsed by the shared browser-safe contract before catalogue readers use their paths,
counts, hashes, or byte ranges; pipeline emission and the app adapter share that contract.

```
contracts/  ── the shared Entry shape, quality scoring, search config, limits
     │
     ├──────────────────┐
     ▼                  ▼
pipeline/            app/
  builds data/         reads data/, hosts the browser scanner
     │                  │
     └────► data/ ◄─────┘
            the packaged corpus

packages/scanner-core/  ── the scanner's analysis core (parse → policies → redact)
     │            zero Node built-ins; ships unmodified into all three call sites
     ├──────────────┬───────────────┐
     ▼              ▼               ▼
  app/ (worker)  pipeline/scan/  packages/scanner-cli/
```

`contracts` exists so the builder and the site cannot disagree about what a workflow is. When
the pipeline writes an `Entry` and the site renders one, both are typed by the same
declaration. A field added on one side without the other is a compile error, not a blank
space on a page.

`packages/scanner-core` exists for the same reason one level down: the browser worker, the
pipeline's offline scan stage, and the standalone `n8n-scan` CLI all call the same policies and
the same redaction boundary, so a workflow scanned three different ways cannot produce three
different findings. It is the *only* parser, policy, analyzer, and redaction authority: the
app-local copies of the workflow parser, rule and diagnostic vocabularies, completeness
classification, taint modules, and redaction wrappers were deleted in packet 5.2c, and
`scripts/check-scanner-authority.mjs` fails if any of them is redeclared outside
`packages/scanner-core`. `app/src/scanner/` is now adapter and presentation code that imports the
package through its published subpaths; `scripts/check-scanner-import-boundary.mjs` still refuses
an import of a reintroduced app-local parser layer.

### Module map

| Workspace | Role | Depends on |
| --- | --- | --- |
| `contracts/` | Shared `Entry` shape, quality scoring, search config, artifact limits | — |
| `pipeline/` | Offline corpus builder (acquire → rights → sanitize → scan → dedup → describe → index → package) and the local CLI adapter | `contracts`, `packages/scanner-core` |
| `app/` | Static Next.js site: catalogue pages, search, and the browser scanner (worker-isolated) | `contracts`, `packages/scanner-core` |
| `packages/scanner-core/` | The scanner's deterministic analysis core: parsing, policies, taint/JS/Python analyzers, redaction | — (zero runtime dependency on the other four) |
| `packages/scanner-cli/` | The standalone `n8n-scan` CLI | `contracts`, `packages/scanner-core` |

### The scan pipeline, independent of caller

Every caller — the browser worker, the pipeline's scan stage, and the CLI — drives the same four
layers inside `packages/scanner-core/src/`:

1. **`workflow.ts`** normalizes untrusted JSON into a `NormalizedWorkflow` and enforces
   byte/node/edge/complexity budgets before any policy runs.
2. **`engine/engine.ts`** runs every policy and analyzer from the resolved profile
   (`beta-default` or `beta-hardened`) over the normalized workflow.
3. **`result/canonical-findings.ts`** is the single exit boundary: every finding is structurally
   validated, deduplicated, and redacted here, and only here — no other path may emit a finding.
4. **Presentation** differs by caller: the browser renders findings from the worker response, the
   pipeline writes them into the corpus, and the CLI prints or serializes them — but all three
   read the identical canonical finding shape produced by step 3.

**`data/` is committed** — 517.6 MiB of it (542,722,431 tracked bytes). A fresh clone runs the real site against the real
catalogue with no build, no key and no network, and CI has something to gate.

This is a deliberate trade and it was made late. While the corpus was ignored, the deploy
workflow checked out the repository and immediately ran `check:docs`, `check:release`, `test`
and `build` — all of which read `data/` — so there was nothing on the runner to build and CI
could never have passed. The alternative, a release asset fetched by a CI step, keeps clones
fast but breaks the property that matters more here: the commit that deploys is the commit
that contains the data it deployed.

`app/public/data/` stays ignored. It is a copy, written by `scripts/sync-data.mjs`, and
`check:data-sync` proves the two are byte-identical.

### Public tooling boundary

The local CLI is an adapter around the scanner contract and currently reuses the browser-safe
scanner through an explicitly audited temporary pipeline-to-app boundary. As of 2026-08-31, the
CLI runs each scan in a worker thread with timeout, cancellation, and SIGINT isolation, so a
stopped scan cannot overwrite an existing output. The later `n8n-Secureflow` repository is not
created by ordinary builds: its allowlist is audited first, then a separate materializer copies
only approved files into a new destination and verifies the exact file set, hashes, sizes, and
directory tree. Standalone scanner extraction, licence/notice review, and creation of the real
public repository remain release work.

---

## The pipeline

`pipeline/build-corpus.ts` orchestrates stages, each in its own directory, each independently
testable and independently resumable through `stage-ledger.ts`.

### acquire → rights → sanitize → scan → dedup → describe → index → package

**`acquire/`** — clones public repositories and pages the official n8n template API.
Repositories are read from the git object database with `--no-checkout`. That is not an
optimisation: several aggregators name files after the full workflow title, which exceeds the
Windows 260-character path limit, and checking out the tree fails. Reading objects directly
removed the whole failure class — one source went from 0 to 3,571 candidates.

The official acquirer checkpoints to `official-entries.json`, paired with
`official-cursor.json`, and never to `entries.json`. A test asserts that, because
`entries.json` is the file `build-corpus` writes the combined corpus to: a completed run would
otherwise leave the whole combined corpus under the name the acquirer reads back as its own
partial progress, and the next run would append API pages on top of every GitHub entry.

**`rights/`** — decides redistribution **per workflow, not per repository**. A repository
licence covers what its owner authored; a mirror of someone else's workflow carries no licence
whatever its `LICENSE` file claims. `official-mirror.ts` demotes any candidate whose
de-duplication group also contains an official n8n template, and it runs *before* the
election, so the mirror and the official entry meet as equals and the official one wins on
metadata — pointing the page at n8n.io, where the workflow came from.

This is why no entry is downloadable: after the 2026-09-27 F-001 ruling the last 288 rows became
link-only, so all 11,464 publish a link instead of a body. A repository blocklist was
rejected: it would strip the genuinely-original files out of a mostly-mirrored repository and
still miss the next unreviewed mirror.

**`sanitize/`** — redacts every workflow that has a body, including ones that will never be
published. Scanning a raw body and a sanitized one produces different grades: measured over
400 official workflows, 4.8% published a different grade and CRITICAL inflated 3.4×. Sanitizing
only what we publish made official templates look riskier than community ones for no reason
but which branch of the pipeline they took.

**`scan/`** — runs the same deterministic policy engine the browser ships, so a scan you reproduce
locally comes from the same implementation the site runs. A *catalogue* grade is a different claim: each
stored result keeps the scanner identity recorded on that entry, which may be an older engine than the one
currently shipped.

**`dedup/`** — elects one canonical entry per workflow by fingerprint and structural hash, and
records every losing copy as `alsoFoundIn` so attribution survives the collapse. `elect()`
honours a supplied fingerprint rather than recomputing one; two hash paths that can disagree
is a defect in itself, and it once collapsed the entire official template library into a
single entry because every one of them hashed `undefined`.

Identity serialization is explicit: strings use JSON escaping, booleans and null use their JSON
tokens, finite numbers use ECMAScript JSON number formatting with `-0` normalized to `0`, and
object keys use locale-independent code-unit ordering. Undefined, non-finite, symbol-containing,
and non-plain values fail closed instead of becoming ambiguous hashes.

**`enrich/`** — generates the prose. The model receives **model-safe workflow JSON and nothing
else**: no upstream marketing copy, no catalogue title, no source link, no rights metadata, no
derived fact packet. Output is structurally validated, readability-gated, and checked against
a blocklist of unverifiable claims (durations, costs, ungrounded resilience assertions) before
it can be packaged. Live calls require an explicit flag and a staging directory. Fallback prose
exists for graceful degradation and **can never be published in a release** — the gate is
fail-closed.

**`index/`** — builds the search tiers, facet bitsets and semantic vectors.
`indexability.ts` holds the two predicates that decide what appears where, and the single sort
that assigns ordinals, chooses tier membership, and indexes the facet bitsets. All three must
come from one ordering or they disagree silently, so the ordering lives beside the predicates.

**`package/`** — writes shards, packs, indexes and the manifest, measuring each artifact's
entry count *from the artifact* rather than copying the corpus total. A count that is asserted
rather than measured hides the shortfall a manifest exists to surface.

### Two predicates that are easy to confuse

| | `isIndexable` | `isSearchable` |
| --- | --- | --- |
| Governs | crawler indexing, hub membership | the search index |
| Requires rights? | no | no |
| Count | 11,245 | 11,245 |

Neither asks about redistribution rights, and until 2026-08-26 `isIndexable` did. That folded
two unrelated questions into one: **may we hand you the file**, and **may we describe the
workflow**. A detail page publishes derived facts — structure, integrations, a security grade,
provenance — and deep-links upstream for the file itself. That is what a directory does, and it
republishes nothing. The project had already accepted the argument for search; leaving it
unaccepted for publication meant an 11,464-entry catalogue offered a crawler 287 pages.

They stay separate predicates because they answer different questions — may a crawler index
this, versus is this worth a result row — and collapsing them would leave the next divergence
nowhere to be expressed. Today they differ only on generated-description provenance:
`indexability.test.ts` pins the cases where they must agree.

### Three numbers about indexing, and what each one governs

These get confused, and this audit misread them twice in opposite directions before measuring.

| Name | Count | What it governs | Where it lives |
| --- | ---: | --- | --- |
| `isIndexable(entry)` | 11,245 | whether a crawler may index the page and whether the entry joins the hub | `contracts/indexability.ts` — computed, never stored |
| `entry.isPrerendered` | 250 | whether Next wrote a real page, and therefore whether a card links with `<Link>` or an anchor | baked into the corpus by the packager |
| `entry.indexable` | 0 | **nothing.** A legacy output hint | dropped by `parseEntryArtifact`; no longer present |

`isIndexable` requires canonical provenance, a non-fallback description, at least three functional
nodes, and at least one integration. It does **not** ask about redistribution rights — that
separation is the subject of `ADR-publication-is-not-redistribution`.

`isPrerendered` is not a quality signal. It is capacity: 250 detail pages are prerendered because
building 11,245 of them is not worth the build time, and the rest render from the client shell.
Getting it wrong is expensive in a non-obvious way — `isClientRoutable` reads it to choose a
`<Link>` over an anchor, and a `<Link>` to a page Next never wrote requests two RSC sidecars that
do not exist, producing a silent 404 per card on every page that lists results.

`entry.indexable` was a stored copy of the first predicate, and its name invited exactly the
misreading above. It carried 1,962 in the previously packaged corpus — a strict subset of the
11,245, for reasons nothing recorded. The current artifact contract does not preserve it, so the
2026-09-04 re-package dropped it and nothing missed it: `indexableSlugs()` reads `isPrerendered`,
and every other consumer calls `isIndexable()` directly. If a stored copy is ever wanted again, it
needs a name that says which question it answers.

**The thin-content exposure is real and untested.** Indexing 11,245 pages over a corpus that is
97.5% link-only is a bet that the structure floor is a sufficient quality gate.
`ADR-publication-is-not-redistribution` makes that argument; no measurement supports it yet. A
post-launch check of actual indexation coverage against the submitted sitemap URLs is the thing
that would settle it, and it has not been run because the site has not been submitted.

Downloads are gated in exactly one place: `app/src/catalogue/download.ts`, which also attaches
the upstream licence notice that MIT and Apache-2.0 require to travel with a redistributed file.

### Two rights counts, and which question each answers

`rights` is published twice, over two different populations. Neither number is wrong; reading
one as the other is, and an earlier pass of the audit did it before measuring both.

| Field | Population | Value today | Read by |
| --- | --- | ---: | --- |
| `stats.json.linkOnlyCount`, `analytics.json.rights.linkOnly` | the whole corpus | 11,464 | the `/sources/` rights panels (`app/app/sources/page.tsx`), the doc gate, the public dataset export |
| `stats.json.facetCounts.rights.link_only`, `facets.json`'s `counts.rights` | `rankedSearchableEntries` only | 11,245 | the homepage hub counts (`app/app/page.tsx`) and the library facet rail |

The second is a **search facet**: it is measured over what search can return, so a canonical
corpus entry below the `isSearchable` floor — fewer than three functional nodes, or no
recognised node type — counts in the first and not in the second. That is 219 entries today.
`facets.ts` shares one ordinal space across all seven facet groups, so widening `rights` alone
would need a second bitset space, and narrowing `linkOnlyCount` to the search set would
undercount the catalogue. `pipeline/package/rights-count-population.test.ts` pins both scopes on
a two-entry fixture, so a silent widening or narrowing of either fails.

Both figures are the current `data/stats.json`'s measured values, not constants a future corpus
keeps: the difference is exactly the entries the `isSearchable` floor excludes, and it moves with
the corpus.

---

## The site

`app/` is a Next.js App Router project exported to static files.

**Detail pages exist for every one of the 11,464 published workflows**, at `/w/<slug>/`, and two
generators write them.

Next's static export emits **six files per page** — `index.html` plus five RSC sidecars —
totalling 330–500 KB. Putting the long tail through it would have cost 4.3 GB against a **1 GB
GitHub Pages ceiling** that the committed corpus already spends 517.6 MiB of (542,722,431 tracked
bytes). Measured, not
estimated by a page-weight measurement script retained in git history (see `docs/audit/HISTORY.md`).

So the top 250 by quality go through Next with a deterministic static SVG preview, accessible node
list, and an explicit action for the pan-and-zoom canvas; `scripts/generate-lean-pages.tsx` writes
the other 12,971 by running *the same React components* (`app/src/ui/detail/detail-lean.tsx`)
through `renderToStaticMarkup` — one file, no hydration payload, ~26 KB. Both detail-page tiers
carry the static preview. The client-only `/w/view/?id=` destination starts without preview or
chart data; the interactive canvas, full findings and readiness checklist are one click away.

Three things hold the arrangement together, and each exists because of a defect that reached a
built page while every gate was green:

- **`check:parity`** applies eight rules — one title, one `h1`, one canonical, robots, meta
  description, stylesheet, one `main`, parseable JSON-LD — to all 13,221 pages, and fails if it
  ever sees only one tier. What can drift is not what the components *say* (they are shared) but
  the document assembled around them.
- **`document-shell.ts` reads the chrome out of the built export** rather than restating it. The
  stylesheet name and the `next/font` class on `<html>` are content-hashed; hard-coding either
  renders 12,971 pages unstyled, or in the system font, the first time a hash changes.
- **`withBasePath`** prefixes internal hrefs in the generator. Pages serves the site from a
  repository subpath and `next/link` applies that only inside the Next build, so anything
  rendered statically points one level above where the site lives — invisibly, until it is
  public.

`isPrerendered` no longer decides where a link goes; every entry has a slug page, so
`detailHref` returns one unconditionally.

**Preview and chart artifacts** are byte-addressed JSONL siblings with per-line SHA-256 hashes in
the committed build inputs. Preview records are validated server-side before detail HTML is
generated; their client reader remains bounded and integrity-checking for deployments that retain
the artifact family. The build removes the duplicate preview copy from `app/out/` after the detail
pages have embedded it. The interactive chart remains in the shipped export and is fetched with
HTTP `Range` only after the explicit action; a `200` means the host ignored the header, so the body
is cancelled rather than downloading a whole shard to draw one diagram. The e2e static server
implements `206`, so the bounded chart path and explicit activation path are exercised.

**The canvas** (`app/src/ui/chart/`) separates viewport maths (`canvas-transform.ts`) from
rendering. Node interactivity is unconditional and independent of zoom: it was gated on
`scale >= 1` against a fit-everything default, so 94.56% of the corpus opened with every node
`pointer-events: none`, `aria-hidden`, and untabbable. A transparent hit rectangle restores
the 24px WCAG 2.5.8 target in *screen* space when zoomed out.

**Counts shown to a reader come from `analytics.json`.** Not from an index file, not derived
locally. Deriving "how many workflows" per-file put 2,000 in the header while the analytics
page said 12,923, and it happened twice from opposite directions. `searchable-count.ts` is now
the single derivation and every caller goes through it.

---

## Search

A single index over the full catalogue with text indexed is 11.65 MB gzip — not a download to
request before anyone has typed. The measured alternatives forced the design:

| Option | gzip |
| --- | ---: |
| All entries, `content` indexed | 11.65 MB |
| All entries, no `content` | 3.95 MB |
| Two tiers, `content` for the top 2,000 | 5.10 MB |

Even dropping text entirely exceeds the budget, so tiering is not a nicety:

- **Tier 0** — top 2,000 by quality, `content` indexed, 1.64 MB gzip. The critical path.
- **Extended** — the remaining 9,245 without `content`, 3.44 MB gzip, fetched after the
  primary index can answer. Until it lands, its entries are *counted but not returned*:
  claiming a result you cannot display is worse than waiting.
- **Semantic vectors** cover tier 0 and load after the first query. Across all 11,245 they
  measure 10.44 MB gzip, which is not a deferred download either.

> Reconciled 2026-09-29 to the current 11,245 searchable corpus: Tier 0 is 2,000
> documents with `content` indexed (the critical path) and Extended is the remaining
> 9,245 without `content`, fetched post-warmup. The 11.65 MB / 3.95 MB / 5.10 MB rows
> and the 12,923 total above are design-time benchmark measurements against the
> 2026-09-04 corpus snapshot and are preserved as the measured context the tier split
> was chosen from; per-tier gzip figures are not re-measured per release because the
> budget gate asserts them independently.

**BM25 is normalised per tier before merging.** The score is corpus-relative, so a
2,000-document tier rates the same match higher than a 9,245-document one; merging raw scores
would rank results by which file an entry happens to live in.

A **string dictionary for the display store was measured and rejected**: it takes stored
fields from 1.27 MB to 0.62 MB raw but only 0.23 MB to 0.19 MB gzip. Gzip already finds those
repeats.

---

## The browser scanner

`app/src/scanner/scan.worker.ts` runs the four-layer pipeline described above inside a Web
Worker, so a pasted or uploaded workflow is parsed and scanned off the main thread and never
crosses a network boundary. `app/src/scanner/` holds the worker plumbing, the v1 presentation
adapter, and the report rendering; the parser, policies, analyzers, and the
canonicalisation/redaction boundary itself live in `packages/scanner-core` and are shared with the
pipeline and the CLI (see the module map above). The app-local parser tree that used to sit beside
it is gone: no route, worker, or catalogue path imported it, and the release goldens prove the
package parser produces the same browser result the deleted parser did.

Policies are hand-written TypeScript implementing a common `ScanPolicy` interface. The engine
funnels every finding through a single canonicalisation and redaction boundary, so malformed
policy output is dropped and counted rather than thrown, and no output path can bypass
redaction. The scan reports its own completeness — a check that failed or was truncated is
never presented as a clean result.

The worker boundary is a privacy boundary as much as a performance one; see
[`SECURITY.md`](SECURITY.md).

---

## Conventions that are enforced, not merely encouraged

- **200-line file cap**, ratcheted. A grandfathered file may shrink and never grow, and once
  it drops below the cap it leaves the allowlist. This has repeatedly forced extractions that
  were overdue rather than permitted a file to sprawl.
- **Documentation figures are checked against the data.** `check-doc-consistency.mjs` binds a
  number in prose to the claim it makes and verifies it against `analytics.json` and
  `stats.json`. Documents in `docs/archive/` must declare what superseded them.
- **Artifacts are never hand-edited.** Every file in `data/` is produced by a pipeline stage
  and stamped in the manifest; `check:data-sync` proves `data/` and `app/public/data/` are
  byte-identical.
- **Generated artifacts do not share a commit with the source change that produced them.**
