# sfscanner 🔍

**Deterministic, offline security scanning for n8n workflows** — JSON, NDJSON, a table, or SARIF 2.1.0. The workflow never leaves your machine.

> **Licensing:** MIT for this package's code and scanner tooling. The catalogue dataset has separate Personal / Non-Commercial terms; see https://github.com/jitwark/sfscanner/blob/main/docs/LICENSING.md.

> Release candidate: the supported profile is `beta-default`; experimental hardened analysis is not publicly admitted. Supply-chain opt-in reports canonical advisory state and unknown coverage when no snapshot is admitted. See the [CLI guide](https://github.com/jitwark/sfscanner/blob/main/docs/scanner/cli-v2.md) for supported contracts and limits.
```bash
npx sfscanner scan my-workflow.json
```

> This package is the scanner. The workflow **catalogue** — 11,464 public n8n workflows, their
> provenance and how much of each one the scanner could actually read — lives on the website:
> <https://jitwark.github.io/sfscanner/>.

---

## ⚡ Quickstart

```bash
# one file, human-readable
npx sfscanner --schema v2 scan workflow.json --format table

# a directory, SARIF for GitHub code scanning
npx sfscanner --schema v2 scan ./workflows --format sarif > results.sarif

# pipe a workflow straight from a clipboard or curl
cat workflow.json | npx sfscanner scan -

# see the rules, then read one in full
npx sfscanner --schema v2 rules --format table
npx sfscanner --schema v2 explain N8N_EXECUTE_COMMAND
```

Node **22** is the only supported line (`engines: >=22 <23`). The CLI is ESM-only and no CommonJS artifact is shipped; `require('sfscanner')` is not supported. Runs have been verified on Windows; Linux and macOS are not yet a verified matrix.

---

## 🧠 What it actually checks

Seven admitted rules in the `beta-default` profile. Every row carries a severity, a confidence and a
CWE: these are deterministic pattern and configuration matches, **not** a safety guarantee, and not a
verdict about whether a workflow is safe to run.

| Rule | Severity | Confidence | CWE |
| --- | --- | --- | --- |
| `N8N_EXECUTE_COMMAND` | CRITICAL | HIGH | CWE-78 |
| `N8N_CODE_NODE` | LOW | HIGH | CWE-94 |
| `RAW_AUTH_HEADER` | HIGH | MEDIUM | CWE-522, CWE-798 |
| `RAW_SECRET_INDICATOR` | HIGH | MEDIUM | CWE-798 |
| `UNAPPROVED_DOMAIN` | MEDIUM | HIGH | — |
| `UNKNOWN_NODE_PACKAGE` | LOW | MEDIUM | CWE-1357 |
| `WEBHOOK_EXPOSURE` | MEDIUM | MEDIUM | CWE-306 |

The `beta-hardened` profile is **defined but not admitted** — `sfscanner --schema v2 profiles` says
so, and selecting it fails instead of silently running something weaker.

---

## 📤 Output and exit codes

Formats: `json` (default), `ndjson`, `sarif`, `table`. SARIF is 2.1.0 with CWE tags, so GitHub,
GitLab and VS Code can read it directly.

Every one of these is a first-class surface, and none is deprecated: the JSON result, NDJSON
streaming, SARIF 2.1.0 and the table stay supported for the scanner, while the published dataset
bundle keeps its NDJSON shards, SQLite database and Excel workbook. Removing a format needs usage or
cost evidence, an owner decision, migration or export access and explicit documentation — a research
note is not enough. See [Preflight and handover](../../docs/scanner/preflight-handover.md#preserved-product-formats).

| Exit | Meaning |
| :---: | --- |
| `0` | Clean — nothing met the `--fail-on` threshold. |
| `1` | Findings at or above `--fail-on`, or a degraded result under `--require-complete`. |
| `2` | Usage or configuration error. |
| `3` | Malformed input, a failed/timed-out input, or an `INDETERMINATE` result — unless a finding at/above `--fail-on` already decided exit 1. |
| `4` | Internal error or a memory ceiling. |
| `130` | Interrupted. |

`--fail-on <CRITICAL|HIGH|MEDIUM|LOW|INFO>` (Default: `INFO`). `--schema v2` is required for
directory scans, `--output` and `--fail-on`; without it those are usage errors by design.

Optional readiness assessment: `--include-readiness` (default `false`) extends `json`, `ndjson`, or `table` output with offline preflight checks (completeness status, declared credentials, integrations, and subworkflows). SARIF format combined with `--include-readiness` is rejected.

---

## 🤖 MCP server

The package ships `sfscanner-mcp` — a stdio JSON-RPC MCP server with **one** tool, `n8n_scan`. It
scans local workflow files with the same engine and returns the same structured output, so an agent
can read a workflow before it imports it.

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

`<npm-root>` is `npm root -g`. The single tool takes `inputs` (local paths; stdin `-` is refused
because the transport owns stdin), plus optional `format`, `failOn`, `profile`, `include`, `exclude`.
Invalid arguments answer JSON-RPC `-32602` without running a scan.

---

## 🛡️ Limits, honestly

- Inputs are bounded: 1,536,000 bytes per file by default, 5,000 nodes, 10,000 edges, a 30 s worker
  deadline, and a validated `--limits` document can tighten or raise the byte ceiling.
- The scan runs in a worker; if the worker cannot be terminated the item is reported `FAILED` rather
  than "probably fine".
- Node types the scanner does not model are reported as **unknown**, not as safe. Version ranges are
  matched as catalogued; there is no nearest-neighbour guess.
- Coverage of the published corpus lives on the website, with explicit counts for bodies that are
  missing, source-unavailable, degraded and indeterminate.

---

## 📚 Documentation

- [`docs/scanner/cli-v2.md`](../../docs/scanner/cli-v2.md) — v2 admission rules and Windows example
- [`docs/scanner/limitations.md`](../../docs/scanner/limitations.md) — what the scanner does not do
- [`docs/scanner/preflight-handover.md`](../../docs/scanner/preflight-handover.md) — offline preflight and handover: prerequisite and target checks, opt-in privacy preparation, preserved output formats, bounded catalogue expansion
- [`docs/scanner/rule-reference.md`](../../docs/scanner/rule-reference.md) — every rule and remediation
- [`docs/scanner/migration-v1-v2.md`](../../docs/scanner/migration-v1-v2.md) — v1 remains supported
- [`docs/LICENSING.md`](../../docs/LICENSING.md) — licence terms

v1 (`sfscanner scan file.json`) still works for one input with the `beta-default` profile.

---

## ⚖️ Licence

MIT for this package's code and scanner tooling. The catalogue dataset has separate Personal /
Non-Commercial terms; see https://github.com/jitwark/sfscanner/blob/main/docs/LICENSING.md.
The dataset is not shipped in this package. A finding tells you what to read before importing a
workflow; it does not make one safe.
