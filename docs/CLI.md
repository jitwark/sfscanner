# Offline scanner CLI

> Status: published `sfscanner@0.2.1`; local workspace adapter reference below
> Last verified: 2026-11-08 (published archive and 23 package controls)
> Owner: n8n-Secureflow Community Maintainers
> Source of truth: `packages/scanner-cli/`, published archive, and `pipeline/cli/` for the workspace adapter

Install the published command with `npm install -g sfscanner@0.2.1`. The anonymous registry
download matches the qualified release archive. See the [package usage guide](../packages/scanner-cli/README.md)
for the installed CLI/MCP interface and [programme status](scanner/programme-status.md) for the
release and coverage limits. The workspace commands below remain the local adapter reference;
they do not require a new npm publication. The current UI overhaul does not change CLI semantics.

The current CLI adapter runs the deterministic scanner locally. It does not upload workflow
content or make a network request during a scan. It accepts JSON files, recursive directories, or
stdin and uses the same parser, limits, and scanner result schema as the browser worker.

## Examples

```powershell
npm run scan:cli -- scan workflow.json --format=json
npm run scan:cli -- scan workflows --format=sarif --fail-on=HIGH
Get-Content workflow.json -Raw | npm run scan:cli -- scan - --format=table
npm run scan:cli -- rules
npm run scan:cli -- explain N8N_EXECUTE_COMMAND
npm run scan:cli -- version --format json
npm run scan:cli -- --help
npm run scan:cli -- --version
```

`npm run scan:cli` is the supported shortcut declared in the root `package.json`; it expands to
`tsx pipeline/cli/n8n-scan.ts`. Everything after `--` is passed to the CLI unchanged.

The compatibility vocabulary below is checked against the local `--help`, `scan --help`, the
version document the CLI emits, and the exit-code definitions by `scripts/check-cli-docs.mjs`.
Keep it aligned when the experimental adapter changes; this is a documentation check, not a claim
that the adapter is already a standalone package.

<!-- cli-docs:surface -->
### Commands

| Command | Meaning |
| --- | --- |
| `scan` | Scan workflow JSON from files, directories, or stdin. |
| `rules` | List scanner rules. |
| `explain` | Explain one scanner rule. |
| `version` | Print CLI and scanner versions. |

### Options

| Option | Meaning |
| --- | --- |
| `--help` | Show help text. |
| `--version` | Print the CLI version. |
| `--json` | Emit machine-readable version metadata. |
| `--format` | Select `table`, `json`, or `sarif` output. |
| `--output` | Write output atomically to a path. |
| `--profile` | Select the scanner policy profile. |
| `--approved-domain` | Allow a domain; repeat for multiple domains. |
| `--fail-on` | Set the finding severity threshold. |
| `--max-concurrency` | Bound concurrent inputs (1-16). |
| `--timeout` | Set the hard per-scan limit in milliseconds (1-2147483647, `setTimeout`'s safe range). |
| `--include` | Include matching directory paths. |
| `--exclude` | Exclude matching directory paths. |
| `--no-color` | Disable color in human-readable output. |

### Exit codes

| Code | Meaning |
| ---: | --- |
| `0` | Scan completed under the threshold. |
| `1` | Findings meet `--fail-on`. |
| `2` | Usage or configuration failure. |
| `3` | Input or indeterminate scan failure. |
| `4` | Internal failure. |
| `130` | Interruption or cancellation. |
<!-- /cli-docs:surface -->

`--output report.json` writes through a temporary file and refuses to overwrite an input. JSON and
SARIF remain parseable when one file in a batch is malformed, oversized, or otherwise indeterminate;
diagnostics are represented in the result document or written to stderr. Results are sorted by
normalized path regardless of `--max-concurrency`.

`--help` prints the general command reference; `scan --help` prints the scan options. `--version`
prints the human-readable one-line version, while `version` emits the stable machine-readable
version document and `version --format table` emits the readable one. The current entry point
routes `version`, `rules`, and `explain` through the versioned grammar, which takes
`--format json|table`; the `version --json` spelling is still defined by the v1 command contract
below but is rejected with exit code 2 today.

Exit codes are stable: `0` means complete under the threshold, `1` means findings meet `--fail-on`,
`2` means usage/configuration failure, `3` means an input or indeterminate scan, `4` means an
internal failure, and `130` is reserved for interruption.

## Profiles, limits, and scoring

`beta-default` is the default profile. It applies the reviewed structural policies used for the
ordinary risk grade. `beta-hardened` defines advisory source-span, JavaScript, Python, taint, and AI
capability analysis, but it is not admitted or selectable, so those analyzers do not run in the
shipped path. If it is admitted later, its findings are report-only and would not silently change
the legacy score. A profile is a policy choice, not a promise that a workflow is safe.

The shared scanner contract currently bounds one input at 1,536,000 UTF-8 bytes, 5,000 nodes,
10,000 graph edges, depth 64 for connections and parameters, and 10,000 parameter leaves. The
default worker deadline is 30,000 ms; `--timeout` can impose a stricter per-input CLI deadline, up to
2,147,483,647 ms (`setTimeout`'s safe maximum — a larger value is rejected at parse time rather than
silently clamped to an effectively instant timeout). `--max-concurrency` is bounded separately, from
1 to 16.
The code-analyzer definition caps each source at 100,000 bytes and ten findings, and the
`beta-hardened` definition caps its combined analyzer findings at 100 per workflow. Because
`beta-hardened` is not admitted, no shipped scan applies those caps; when a limit is reached in a
shipped path, the result carries an indeterminate/degraded diagnostic rather than pretending that
the scan was complete.

The grade is a triage signal. Severity weights are CRITICAL 55, HIGH 35, MEDIUM 18, LOW 6, and
INFO 1; repeated instances of the same policy are discounted, workflow size can add up to 20
points, and the total is capped at 100. `--fail-on HIGH` means “exit 1 when a HIGH or CRITICAL
finding is present”; it does not convert the report into a security certification.

## Output and CI examples

JSON uses the versioned `scanner-cli-v1` envelope. SARIF uses SARIF 2.1.0 with deterministic rule
and result ordering. v1 attaches a physical location with a span when a node span exists and omits
the location otherwise; v2 emits physical locations when the subject has a span.
Validate locations with your SARIF consumer before enabling code-scanning upload; an upload without
resolvable physical locations is not a compatibility claim. Validate or archive the output as an
artifact rather than parsing table output:

```powershell
npm run scan:cli -- scan workflow.json --format=json --output=scan.json --fail-on=HIGH
if ($LASTEXITCODE -eq 1) { Write-Error 'Scanner threshold reached'; exit 1 }
if ($LASTEXITCODE -ge 2) { Write-Error 'Scanner could not produce a complete result'; exit $LASTEXITCODE }
```

For SARIF consumers:

```powershell
npm run scan:cli -- scan workflows --format=sarif --output=scan.sarif --no-color
```

Versioned schema artifacts are committed under `pipeline/cli/schemas/`: `scanner-cli-v1.schema.json`
describes the JSON envelope and `emitted-sarif-2.1.0-profile.schema.json` describes the narrow SARIF
shape emitted by this adapter. Both are self-contained Draft 2020-12 documents with local `$ref`
links. The local contract validator remains the fail-closed runtime compatibility reference until
package extraction is complete: it checks required fields, outcome/status consistency, deterministic
order, and SARIF references. The SARIF file is intentionally not a complete external SARIF
conformance schema, and neither artifact claims that all findings are exhaustive.

## Configuration, approved domains, and privacy

The experimental adapter has no implicit configuration file. Put options in the command line so a
recorded CI invocation is self-contained. Repeat `--approved-domain` for each exact host that the
workflow is allowed to call; an expression-built or unresolved destination remains only partly
known. Use `--include` and `--exclude` to make directory selection explicit, and keep `--output`
outside the input tree when possible.

The scan path is local-only and does not upload workflow content. The CLI reads files or stdin,
parses them in memory, and emits redacted findings. It does not execute workflow code. This does
not make a workflow safe: rotate any exposed credential, review every finding, and treat missing
or degraded analysis as a reason to investigate. For false positives, retain the input locally,
record the policy ID and evidence, and report the smallest reproducible example through the
project's security or takedown contact process; never paste secrets into an issue.

The adapter is published. Its extracted package is `sfscanner`
(`packages/scanner-cli`), which declares the `sfscanner` and `sfscanner-mcp` bins, so
`npm install -g sfscanner` installs it.
Cross-platform clean-install verification, the complete golden parity matrix, and independent
release review remain open in the scanner CLI OpenSpec package.
