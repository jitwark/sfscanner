# n8n SecureFlow 🛡️

> Release status — November 8, 2026: `sfscanner@0.2.1` is published on npm and GitHub. The production website is live on GitHub Pages and Firebase. The qualified build passes 86 production browser checks and 14 live browser cases on each host (8 scanner + 6 catalogue). The original formal-coverage targets remain missed; see [scanner status](docs/scanner/programme-status.md).

**A deterministic security scanner for n8n workflows — and a catalogue of 11,464 public workflows
that tells you where each one came from, what it touches, and how much of it the scanner could
actually read.**

Runs from your terminal, from an AI agent over MCP, and in the browser. The workflow you scan never
leaves your machine.

**Live website:** [GitHub Pages](https://jitwark.github.io/sfscanner/) · [Firebase](https://n8n-enterprise-1.web.app/sfscanner/). Downloads, checksums and the release record are available in [v0.2.1](https://github.com/jitwark/sfscanner/releases/tag/v0.2.1).

**Development state — November 8, 2026:** the owner authorized a final scanner/workflow/library/analytics UI overhaul before a long implementation pause. Both deployed sites remain the qualified baseline until the new UI passes fresh delivery checks. The [current programme status](docs/scanner/programme-status.md) separates verified delivery from remaining coverage gaps; the [v0.3 roadmap](docs/scanner/v0.3-roadmap.md) is planning only and has no implementation ETA.

> Status: v0.2.1 released — V4 dataset, link-only (no workflow bodies redistributed)
> Last verified: 2026-11-08 (production build, package, hosted CI and live browser checks)
> Owner: single maintainer, [@jitwark](https://github.com/jitwark) (see `GOVERNANCE.md`)
> Source of truth: the qualified dataset manifest and formal-coverage identity in [release-record.json](https://github.com/jitwark/sfscanner/releases/download/v0.2.1/release-record.json), explained in `docs/scanner/programme-status.md`.
> The release dataset ZIP contains the verified NDJSON, SQLite and Excel exports; private workflow bodies are not distributed.

---

## ✨ What you get

- 🔍 **Deterministic static review.** Seven admitted rules with severities, confidence and CWE tags,
  emitted as JSON, NDJSON, SARIF 2.1.0 or a table.
- 📚 **A catalogue with receipts.** Every one of the 11,464 entries links to where it came from, what
  it needs to run, and whether a current scan actually read it.
- 🧾 **Numbers with denominators.** "Read" means an admitted current result over real body bytes —
  never a leftover stamp, and never a claim that every result reached a verdict. No body, source unavailable and indeterminate are named states, not hidden.
- 🔒 **Link-only by construction.** Workflow bodies are never republished. The site serves metadata
  and a reference; the catalogue does not become a copy of someone else's code.

---

## ⚡ Quickstart

Install the published, verified package with `npm install -g sfscanner@0.2.1`, then use
the commands below. Its anonymous registry download matches the qualified release archive.

```bash
# one workflow, readable output
sfscanner --schema v2 scan workflow.json --format table

# SARIF for GitHub code scanning
sfscanner --schema v2 scan ./workflows --format sarif > results.sarif

# inspect the rules
sfscanner --schema v2 rules --format table

# CI: scan a directory of workflows into SARIF
sfscanner --schema v2 scan .n8n --format sarif > results.sarif
```

Node 22. The package is ESM-only. The MCP server is one tool, `n8n_scan`, over stdio — see
[`packages/scanner-cli/README.md`](packages/scanner-cli/README.md) for the config snippet.

The browser scanner uses the shared engine in a worker on your machine; the site is a static
export with no server API and no network scanner. The production build passes 86 browser cases;
each live host also passes eight scanner and six catalogue cases, including the first real scan offline.

---

## 🧠 What it checks — and what it does not

Seven rules ship in the admitted `beta-default` profile: command execution, code nodes, raw auth
headers, embedded secret indicators, unapproved domains, unknown node packages and webhook exposure.
Each one is deterministic: the same input produces the same output, with no model in the loop.

What it does **not** do:

- It is not a safety guarantee. A finding tells you what to read before importing a workflow; a
  clean result does not mean a workflow is safe.
- `beta-hardened` is defined but **not admitted** — it appears in `profiles` as not selectable
  instead of quietly running.
- Node types the catalogue does not model are reported as unknown. Model coverage is a catalogue
  fact, not a security accuracy score.
- No auto-fix, no execution, no upload.

---

## 📊 The catalogue, measured

The November 7 scan and retained-record replay produced the following candidate measurements.
They describe the verified candidate now in `data/`, not the older hosted site.
The replay conserved the population and reproduced the formal coverage object exactly.

| Measured | Value |
| --- | --- |
| Catalogued workflows | 11,464 |
| Inputs attempted (bound readable) | 11,394 |
| — produced an authentic native result | 11,379 |
| — complete | 1,065 |
| — degraded (skips or omissions recorded) | 10,119 |
| — indeterminate (no assessment published) | 195 |
| — refused without a result (`NO_RESULT`, no grade) | 15 |
| No input to scan | 3 |
| Body exists, source unavailable (owner-ruled) | 67 |
| Historical verdicts | 0 |
| Redistributable bodies | 0 — link-only |
| Node types observed | 1,107 across 236,378 instances |
| — catalogue-matched / partly matched / unmatched types | 29 / 10 / 1,068 |

These states are disjoint and reconcile: `11,464 = 11,461 with a body + 3 without`, and
`11,461 = 11,379 native results + 15 refusals + 0 historical + 67 source-unavailable`. A refused
body is not historical — no retired verdict exists — and it is not unread: the engine read it and
published no result, so it is counted, and displayed, as `NO_RESULT` with no grade.

Most scans are **degraded** because the scan recorded a skipped or omitted unit, so its assessment
may have missed findings. Degraded is not a defect count and not a claim about what caused the
omission; the per-scan diagnostics are on each workflow row.

Type/version catalogue matching is a separate descriptive measure: 187,474 of the 236,378 observed
node instances match legacy catalogue records. It includes nodes outside the formal executable
cohort and does not establish reviewed operation scopes or detection accuracy. The older
26 / 9 / 1,072 type counts describe a historical snapshot.

**The original 95%/90% programme coverage targets were MISSED.** In the declared official-package
cohort, only **112 of 144,043 executable instances (0.0777545594%)** meet the reviewed scoped
semantics, and **0 workflows out of 9,669 (0%)** have every executable node covered. The only admitted
reviewed executable scope is exact Gmail node version 2.2 (`2.2.0` after normalization), message
resource, and nine literal operations: `addLabels`, `delete`, `get`, `getAll`, `markAsRead`,
`markAsUnread`, `removeLabels`, `reply` and `send`. Other versions, resources, unknown selectors
and `sendAndWait` do not count. Inert annotations are counted separately.

The formal cohort excludes 1,795 rows: 1,671 community-package rows, 54 invalid node identities,
67 source-unavailable and 3 missing inputs. Zero measurements are unknown. `COMPLETE / FULL_COHORT`
means the measurement finished with explicit exclusions; it does not certify complete semantics or
safety. These are measured programme target misses and documented first-release limitations.

### 📦 Published V4 dataset

The real export produced `release-2026-11-07-9edb75aa0898` in `public-data-model-v4` format:
18 logical relations in NDJSON and SQLite, plus a 12-sheet Excel workbook. The dataset format
version is independent of scanner version 2.x. Download the qualified
[dataset ZIP](https://github.com/jitwark/sfscanner/releases/download/v0.2.1/sfscanner-dataset-v4.zip)
and verify it against [SHA256SUMS](https://github.com/jitwark/sfscanner/releases/download/v0.2.1/SHA256SUMS).
The repaired bundle passes all five actual reopening
checks, including exact Excel metadata, cell, formula and truncation validation. A sweep of
2,935,097 NDJSON string leaves found zero email, token, private-IP or internal-host matches;
the captured zero-match baseline comparison also passes. These checks qualify the dataset
formats and configured privacy controls. Site, package and public delivery have their own
completed checks, recorded in the release record and programme status.

Released source manifest SHA-256: `40177ed565aa1babb1004e5124c8a9b455f215ff8777bfb5f80b029401a74479`.
Released corpus SHA-256: `025e8707c8a9c93d99e6f191e9e23ec73403b7af0e2f419695857e32cd9ab634`.

| Released artifact | Bytes | SHA-256 |
| --- | ---: | --- |
| `public-release.json` | 1,598 | `0e103f9444d5b0ae0ad6dd9e9dceb4b8b8310fc1145582add28b77ab93c205f6` |
| `release.sqlite` | 236,318,720 | `5d8920cbb64f758753740efb9ccfb5a754e5489596bead6ece701f545fbce1a3` |
| `release.xlsx` | 39,089,573 | `0b0d6f46d2de10a1fe64ac159c7d7fab406ec16e116270f34c7830a3125af717` |
| `ndjson/public-release.json` | 3,058 | `b159c952786785e524f7ca0a2bec8e761fe6415fce692af7c8e736d28f3ebeee` |

The NDJSON manifest lists the 18 relation files and their identities. The
[release record](https://github.com/jitwark/sfscanner/releases/download/v0.2.1/release-record.json)
binds the qualified source, package, dataset and both live hosts. Full anonymous readback
verified all 15,198 application files on each host. The larger semantic-coverage programme
remains incomplete, as the measured target misses above show.

A *result* is an admitted scan of the exact body bytes — not a safety verdict. A *degraded* scan may
have missed findings or had its assessment withheld; an *indeterminate* scan publishes no assessment.
Neither is counted as clean, and neither is a low grade.

---

## 🧭 Provenance and rights

Each entry records its origin, the licence facts we could verify, and structure measured from the
body. Rights are conservative on purpose: **0 of 11,464 entries are redistributable**, so the site
ships metadata plus a permalink and never the workflow itself. See
[`docs/LICENSING.md`](docs/LICENSING.md) and [`docs/DATA-AVAILABILITY.md`](docs/DATA-AVAILABILITY.md)
for what that means, entry by entry.

Descriptions written by a model are labelled as such on the page. Grades, readiness and structure
are deterministic and never model-written.

---

## 🤖 Use it from an AI agent

```json
{
  "mcpServers": {
    "sfscanner": {
      "command": "node",
      "args": ["<npm-root>/sfscanner/dist/mcp.js"]
    }
  }
}
```

One tool, `n8n_scan`, scans local workflow files and returns the same structured output as the CLI.
It refuses stdin (the transport owns it) and answers invalid arguments with `-32602` rather than
guessing.

---

## 🗂️ What is in this repository

```
contracts/   shared entry, security and public-data contracts
pipeline/    acquire → rights → scan → derive → export
app/         the Next.js static site, browser scanner and search worker
data/        the packaged corpus: shards, indexes, manifest
packages/    scanner-core and the sfscanner CLI/MCP package
scripts/     build, gates, release staging and verification
docs/        contracts, policies, scanner reference, decisions
```

---

## 📚 Deep docs

- [`docs/scanner/architecture-v2.md`](docs/scanner/architecture-v2.md) — how v2 scanning works
- [`docs/scanner/cli-v2.md`](docs/scanner/cli-v2.md) — CLI/MCP admission, limits and exit codes
- [`docs/scanner/semantic-catalogue.md`](docs/scanner/semantic-catalogue.md) — modelled node types
- [`docs/scanner/limitations.md`](docs/scanner/limitations.md) — the honest limits
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — pipeline and site composition
- [`docs/scanner/programme-status.md`](docs/scanner/programme-status.md) — candidate measurements and release limitations

---

## ⚖️ Licence

MIT for the code and scanner tooling. The catalogue's contents are not the project's to relicense:
bodies are never redistributed, and the dataset terms are stated in
[`docs/LICENSING.md`](docs/LICENSING.md). If you are a workflow author and want an entry changed or
removed, see the contact and rights policies in [`SECURITY.md`](SECURITY.md) and
[`docs/LICENSING.md`](docs/LICENSING.md).
