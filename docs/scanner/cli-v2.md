# n8n-scan CLI v2

> Development surface: the help authority and machine-checked tables include `fix` and its fix-only flags. Native fix application remains unavailable without a conditional-replace host. `--audit-supply-chain` emits validated request metadata and canonical advisory state. Without an admitted snapshot it reports UNAVAILABLE/NO_ADMITTED_SNAPSHOT and unknown package coverage; no network acquisition occurs. See [current scanner status](programme-status.md). This does not certify a newly published CLI version.

Status: normative, offline development surface. Owner: scanner maintainers. Last verified: 2026-10-30. Source of truth: [`packages/scanner-cli/src/v2/help.ts`](../../packages/scanner-cli/src/v2/help.ts), the v2 contracts, and the v2 serializers.

This guide documents the explicit v2 command surface. The package is published on npm as `sfscanner`; this document still does not promise a hosted service or a deployment. v1 compatibility remains documented in [`docs/CLI.md`](../CLI.md).

## Surface parity marker

The block below is machine-checked against the help authority. Do not add a command, option, or exit code here unless the v2 parser and help authority support it.

<!-- scanner-cli-v2:surface -->
### Commands
| Command | Description |
| --- | --- |
| `scan` | Scan one file, directory, or stdin. |
| `fix` | Plan one reviewed fix; native apply stops at HOST_UNSUPPORTED in this build. |
| `rules` | List admitted rule metadata. |
| `explain` | Explain one admitted rule. |
| `profiles` | List defined profiles and admission status. |
| `validate-config` | Validate one explicit local config file. |
| `version` | Print version and authority identities. |

### Options
| Option | Description |
| --- | --- |
| `--help` | Show deterministic help for the selected v2 command. |
| `--schema` | Select the v2 grammar. |
| `--format` | Select json, ndjson, sarif, or table output. |
| `--profile` | Select an admitted profile. |
| `--fail-on` | Set the finding threshold. |
| `--require-complete` | Fail on degraded analysis. |
| `--audit-supply-chain` | Emit validated supply-chain request metadata; JSON or NDJSON only. |
| `--include-readiness` | Include preflight readiness assessment in json, ndjson, or table output. |
| `--max-concurrency` | Bound concurrent inputs. |
| `--concurrency` | Equivalent spelling for max-concurrency. |
| `--timeout` | Set the per-input timeout in milliseconds. |
| `--output` | Write stdout or a local output file. |
| `--config` | Load one explicit local config file. |
| `--rules` | Select the embedded built-in ruleset; the only admitted authority. |
| `--catalogue` | Select the embedded semantic catalogue. |
| `--limits` | Select embedded or local scanner limits. |
| `--target` | Load a local target context. |
| `--n8n-version` | Set the n8n version fact. |
| `--edition` | Set the deployment edition fact. |
| `--deployment` | Set the deployment fact. |
| `--role` | Set the operator role fact. |
| `--task-runner` | Set the task-runner fact. |
| `--community-package` | Record a community package; repeatable. |
| `--configuration` | Record a configuration fact; repeatable. |
| `--approved-domain` | Treat this hostname as approved for UNAPPROVED_DOMAIN; repeatable. |
| `--include` | Replace includes with a POSIX glob; repeatable. |
| `--exclude` | Replace excludes with a POSIX glob; repeatable. |
| `--allow-unsigned-development-rules` | Refused: external rule packs are not admitted, so no pack can be selected. |
| `--no-color` | Disable color in human output. |
| `--root` | Absolute local directory holding the workflow and receipts. |
| `--input` | Root-relative workflow file; stdin cannot be re-read. |
| `--fix` | Select one reviewed fix; apply requires exactly one. |
| `--mapping` | Root-relative credential-mapping receipt. |
| `--endpoint-receipt` | Root-relative endpoint-compatibility receipt. |
| `--confirm` | Explicit confirmation; required for apply and refused for suggest. |

### Exit codes
| Code | Meaning |
| --- | --- |
| `0` | `UNDER_THRESHOLD`: no threshold, completeness, or item failure. |
| `1` | `FINDING_THRESHOLD` or `REQUIRE_COMPLETE`. |
| `2` | `USAGE`: pre-scan command, config, or admission failure. |
| `3` | `ITEM_FAILURE`: input or indeterminate item failure. |
| `4` | `INTERNAL`: internal, serialization, or output failure. |
| `130` | `CANCELLED`: interruption or cancellation. |
<!-- /scanner-cli-v2:surface -->

## Commands and defaults

Use `n8n-scan --schema v2 scan <file|directory|-> [options]` for a scan. Metadata commands also accept the v2 command name without the marker. `explain` takes one rule ID; `validate-config` takes one local config file. Unknown commands, options, positional arguments, and rule IDs are usage failures.

CLI values replace matching values from the explicitly supplied versioned config; config values replace defaults. Repeatable `--include` and `--exclude` values replace config arrays rather than append. Environment variables never change scan semantics. Defaults are JSON, `beta-default`, `INFO`, `false` for `--require-complete`, concurrency `1`, timeout `30000` milliseconds, embedded built-in rules/catalogue/limits, `UNKNOWN` target facts, includes `**/*.json`, excludes `.git/**` and `node_modules/**`, stdout output, and no color for non-TTY output.

`--max-concurrency` and `--concurrency` both accept integers `1..16`. `--timeout` accepts `1..2147483647` milliseconds. Text values and paths are bounded to 4096 characters; include/exclude arrays are bounded to 1024 entries.

`--approved-domain <host>` is repeatable. Values are bare hostnames (no scheme, path, wildcard, or
port), normalized to lowercase, deduplicated, and sorted; at most 1000 are admitted. A config file may
set the same list as `approvedDomains`; CLI values replace it. The list is forwarded to the engine and
only affects `UNAPPROVED_DOMAIN`, whose real capability path produces the finding.

### Fix suggestions and apply

`sfscanner fix suggest --root <absolute-root> --input <relative-file>` selects a reviewed suggestion.
`sfscanner fix apply --root <absolute-root> --input <relative-file> --fix <fix-id> --confirm` also requires explicit confirmation.
Both forms accept an optional `--schema v2` marker. The root must be an absolute local directory;
the input and optional `--mapping` and `--endpoint-receipt` files must be root-relative.
URLs, parent traversal, absolute input paths, and stdin are refused for fix. Receipt flags supply
credential-mapping or endpoint-compatibility evidence only when the selected suggestion requires it.
`--confirm` is refused for suggest. Apply requires both `--fix` and `--confirm`.

Fix output is one JSON `n8n-scan-fix-v2` document. Fix accepts neither `--format`, `--help`, nor
`--output`. Scan accepts JSON, NDJSON, SARIF, or table; metadata accepts JSON or table.
Unknown commands, options, and extra positional arguments are usage failures (exit 2).

The shipped CLI provides one reviewed-fixture suggestion but no conditional-replace apply host.
With that fixture, suggest returns REFUSED/MISSING_PREREQUISITE because it has no confirmation
evidence. Confirmed apply retains its READY plan and suggestion but returns
HOST_UNSUPPORTED/NO_CONDITIONAL_REPLACE (exit 3) before any write: nothing is staged, no backup
is created, and the source is not opened for write. Successful native apply is unavailable and
unclaimed. Fix exit codes are 0 for READY or WRITTEN, 2 for USAGE, 3 for failure/refusal/no
suggestion/unsupported host, and 130 for cancellation.

### Supply-chain evidence

`--audit-supply-chain` is a scan-only boolean, default false. JSON and NDJSON include the
closed `supply-chain-request-v2` request and canonical advisory facts in the native result;
SARIF and table are refused with exit 2. The request distinguishes an explicitly declared
package inventory from an unverified inventory. An explicitly empty scope reports
NO_DECLARED_PACKAGES; an unverified scope reports REFUSED/INVENTORY_UNVERIFIED. Neither proves
that dependencies are absent.

No production advisory snapshot is currently admitted. A requested declared package scope
therefore reports UNAVAILABLE/NO_ADMITTED_SNAPSHOT, with UNKNOWN package coverage and no
fabricated applicability rows. An absent advisory never means a package is safe. Opt-out
scans remain offline and report feature-off advisory metadata.

Target files use `schemaVersion: "scanner-target-v3"`. Each declared `(name, version)` pair is
preserved, including two distinct exact versions of one package. Duplicate pairs, conflicting
versionless entries, malformed versions and old target-schema inputs are rejected. Versions
are strict SemVer; they are not trimmed, coerced or interpreted as ranges. A missing version
stays unknown. Declaring a package is not proof that it is installed.

### Preflight readiness

`--include-readiness` is a scan-only boolean, default false: a default scan omits readiness entirely and never parses the export a second time for it. JSON, NDJSON, and table outputs carry it; SARIF is refused with exit 2. Readiness is declared-workflow evidence only (`NOT_PROVIDED` safety clearance) and never changes the verdict.

### External rule packs are not admitted

The Ed25519 trust store, active/revoked key rotation, and unsigned development authority (WC-0702 and
WC-0703) are authorised work that is not yet built, and no external rule pack is admittable today. Every caller
route fails closed before any input is selected:

- `--rules` and `--catalogue` accept only `builtin`; any other value is a usage error (`RULE_PACK_INVALID` / `SEMANTIC_CATALOGUE_INVALID`) and exit 2.
- the versioned config rejects a `rules` or `catalogue` value that is not `builtin` as `INVALID_CONFIG`, so a config file cannot smuggle a pack path past the grammar.
- `--allow-unsigned-development-rules` is refused because it has nothing it could admit; the config boolean `allowUnsignedDevelopmentRules` is recorded in `invocation` but selects no authority, and the run continues with the built-in ruleset only.

`packages/scanner-cli/src/v2/external-pack-boundary.test.ts` is the focused proof: a config naming a
pack exits 2 with no machine envelope and no scan, and every accepted run carries the built-in
`scanner-core-builtins@2.0.0` ruleset identity.

## Profiles, limits, and privacy

`beta-default@2.0.0` is admitted and selectable. `beta-hardened@2.0.0` is defined and advertised for truthful visibility, but is not admitted or selectable. Hardened availability requires a separately versioned authority change; its source files alone do not enable it.

The parsed command's `profile` field is the canonical admitted id `beta-default` for both admitted spellings; `beta-default@2.0.0` is admitted input only and stays in the raw CLI override so the invocation's profile source is still `CLI`. The pinned spelling selects the same run as the bare id, and `beta-hardened` remains a usage error.

The v2 authority guarantees:

- v2 is offline and never initiates network requests (HTTP, DNS, sockets, telemetry, or remote imports).
- Labels and output identities never contain absolute paths or workflow source content.
- File output uses a same-directory temporary file and atomic replace; failures and cancellation preserve the prior file.
- beta-default@2.0.0 is admitted; beta-hardened@2.0.0 is defined but not admitted or selectable.
- No shipped path admits an external rule pack: --rules and --catalogue accept only builtin, and --allow-unsigned-development-rules is refused because Ed25519 trust-store admission is deferred.
- No shipped path produces a redacted artifact: maxRedactionPatches and maxRedactedArtifactBytes bound redaction-v2, which is development-only and unwired.
- Published on npm as sfscanner.

The embedded `scanner-limits-v2` defaults are:

| Limit | Value | Limit | Value |
| --- | ---: | --- | ---: |
| `maxBytes` | 1536000 | `maxNodes` | 5000 |
| `maxEdges` | 10000 | `maxConnectionDepth` | 64 |
| `maxParameterDepth` | 64 | `maxParameterLeaves` | 10000 |
| `workerDeadlineMs` | 30000 | `maxSyntaxNodes` | 250000 |
| `maxDocumentDepth` | 256 | `maxMembersAndElements` | 250000 |
| `maxRawEdges` | 50000 | `maxDuplicateKeys` | 1000 |
| `maxDiagnostics` | 1000 | `maxStoredSourceSpans` | 25000 |
| `maxSourceWork` | 1000000 |  |  |
| `maxExpressionTokens` | 100000 | `maxCodeSyntaxNodes` | 250000 |
| `maxGraphOperations` | 1000000 | `maxTaintStates` | 250000 |
| `maxTraceStepsPerFinding` | 100 | `maxFindings` | 5000 |
| `maxRedactionPatches` | 10000 | `maxRedactedArtifactBytes` | 1536000 |
| `maxEvidenceBytes` | 1536000 | `maxSerializedResultBytes` | 5000000 |
| `maxRuleOperations` | 1000000 |  |  |

All limits are admission bounds, not promises that every analyzer will consume the full budget.

v2 is offline and never initiates network requests (HTTP, DNS, sockets, telemetry, or remote imports). Config, rules, catalogue, limits, target, and input references are local or embedded; remote URLs are rejected before selection. Labels and output identities never contain absolute paths or workflow source content. Directory traversal uses case-sensitive POSIX globs over normalized relative `/` labels, excludes `.git/**` and `node_modules/**`, and never follows directory symlinks. Stdin cannot join a batch.

## Output formats and schemas

`json` emits one `n8n-scan-v2` envelope with ordered `tool`, `artifacts`, `invocation`, `results`, `summary`, and `exitReason` fields. Each selected input has one sorted result or closed error item. `ndjson` emits one `n8n-scan-v2-ndjson` header, one sorted result item per input, and one summary line. `sarif` emits one SARIF 2.1.0 run with relative artifact URIs, stable finding fingerprints, and bounded invocation notifications; verified trace spans become code flows only when every span is present. `table` is deterministic human output and is available for scans and metadata commands.

`maxBytes` and `workerDeadlineMs` are shared with the scanner limits contract and are not duplicated in the help source. All limits are admission bounds, not promises that every analyzer will consume the full budget.

## Exit precedence and atomic output

| Behavior | v1 (`scan file`) | v2 (`--schema v2 scan file`) |
| --- | --- | --- |
| Exit on findings | `1` for any finding | `1` only at/above `--fail-on` |
| Exit on malformed input | `3` | `3` (per-item) |
| Input ceiling | 1536000 bytes, enforced before allocation | 1536000 bytes by default; a validated `--limits` document may set `maxBytes` |
| Absolute local path | admitted | admitted |
| SARIF spans | attached when a node span exists | attached when the subject has a span |

After successful pre-scan admission, the winning precedence is: `CANCELLED` (130), `INTERNAL` (4), `USAGE` (2), `FINDING_THRESHOLD` (1), `REQUIRE_COMPLETE` (1), `ITEM_FAILURE` (3), then `UNDER_THRESHOLD` (0). If a finding threshold and `--require-complete` both fire, `FINDING_THRESHOLD` wins regardless of item or concurrency order. `INDETERMINATE` never exits 0. Pre-scan usage/configuration/pack/catalogue failures happen before input selection and emit no machine envelope.

File output refuses every input collision. It writes a same-directory temporary file, serializes and validates fully, then atomically replaces the destination. A serializer or write failure removes only the temporary file and preserves the prior destination. Cancellation preserves the prior destination; stdout cancellation still emits a valid envelope containing completed and cancelled items and exits 130.

The output parent must resolve inside the resolved selection root. A symlinked selection root and an ancestor link that resolves inside the root are allowed; an ancestor link that resolves outside the root is rejected as an admission failure before any temporary file is created or renamed, so the outside destination is not created or overwritten. The rejected path is not echoed. A basename label is display data, not the identity of a selected file: the resolved selected path is what the scanner reads, including for an absolute directory outside the selection root.

## Input paths, and running the installed CLI

Input files may be selection-root-relative, `.` for the selection root itself, or a local absolute
path. Config, limits, target, output and rule references stay **local relative paths**: the parser
refuses any value that begins with a URI scheme (`https:`, `file:`), a leading `/`, a drive letter
(`C:`) or a UNC prefix (`\\`), while an input absolute path is admitted only when it is local (no
scheme, no UNC, no `..` segment). Labels and SARIF URIs never contain an absolute path: an absolute
input inside the selection root is labelled by its relative path, and one outside it by its
basename. The rejected value is never echoed back.

### Windows example

From the workspace root, after `npm run build:scanner`:

```powershell
node packages/scanner-cli/dist/main.js --schema v2 scan packages/scanner-cli/src/v2/__fixtures__/clean-workflow.json --format json
node packages/scanner-cli/dist/main.js --schema v2 scan C:\workflows\clean-workflow.json --format json
```

The first input is selection-root-relative. The second is an absolute path outside the selection
root and is labelled by its basename (`clean-workflow.json`); an absolute input inside the selection
root keeps its relative label instead. An absolute spelling never reaches output identity, and no
label or SARIF URI carries a drive letter or a leading slash.

### Installing it

`sfscanner` is published on the public npm registry. `private: false` in
`packages/scanner-cli/package.json` is a packaging flag, not an availability claim. Install the
released package, or build the same tarball from this checkout and install that:

```powershell
npm pack --workspace sfscanner            # sfscanner-<version>.tgz
npm install --no-save .\sfscanner-<version>.tgz
npx --no-install sfscanner scan --schema v2 <relative-input.json>
```

The tarball is the same build the registry copy is made from; installing it locally is a developer
workflow, and the registry copy is the released artifact.

## Local examples

The safe synthetic workflow, explicit config, config validation script, and CI command recipe in [`examples/scanner-cli/`](../../examples/scanner-cli/) contain no credentials, remote references, absolute paths, or deployment steps. From the repository root, after dependencies are installed, run:

```text
npx --no-install tsx examples/scanner-cli/validate-config.mjs
```

The command reads only `examples/scanner-cli/config.json` and reports the normalized config. The CI recipe runs the same offline checks plus the focused help/parity tests; it does not publish anything.
