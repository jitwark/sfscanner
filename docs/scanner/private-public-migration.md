# Private → public migration ledger

`docs/scanner` ships into the standalone scanner repository. Everything in this table must exist
there; most of it was written and accepted here first. This file records **where each public-only
fix landed privately and what proves it**, plus what is still unrun. It is not a release note and
it is not corpus coverage.

Evidence dates are the receipt dates. A receipt says what was accepted on that candidate; it does
not name the current release identity, and nothing here re-derives a pin.

## Public-only fixes

| Public-only fix | Private landing | Verification |
| --- | --- | --- |
| Root `src/index.ts` plus the `"."` ESM export | C-01 | `packages/scanner-cli/src/package-exports.test.ts` — "resolves every advertised subpath by its published specifier from a clean install", "typechecks a strict NodeNext consumer of the installed root and subpaths" |
| MCP console-to-stderr diversion | B-01 | `packages/scanner-cli/src/v2/mcp-child-process.test.ts` — "diverts console sentinels to stderr and keeps stdout protocol-only" |
| Absolute input admission (`v2/path-admission.ts`) | C-04 | `packages/scanner-cli/src/v2/absolute-path.test.ts` |
| Generic-fallback two-code contract and `/operation` → `/action` resolution | E-04 owns the registry row and vocabulary; D-02 consumes them | `packages/scanner-core/src/capabilities/semantic-fallback-diagnostic.test.ts`, `packages/scanner-core/src/semantics/generic-fallback.test.ts` (action-only, conflict, non-string, unknown action), `packages/scanner-cli/src/v2/fallback-exit-matrix.test.ts` |
| Composite action builds a pinned scanner checkout, not the caller workspace | C-05 | `packages/scanner-cli/src/action-surface.test.ts` (structure plus the executed guards and the real CLI run) |

The second fallback code is **not** a rename of the miss. `packages/scanner-core/src/capabilities/
semantic-context.ts:46-47` emits both `SEMANTIC_CATALOGUE_MISS` and
`GENERIC_NODE_UNMODELED_CAPABILITY` per generic node, each at `required=false`, because the miss
means "no admitted catalogue record" while the capability code means "the verdict rests on
unmodelled-capability defaults". Both have a registry row (`packages/scanner-core/src/diagnostics/
registry.ts:77-78`). The older `GENERIC_NODE_FALLBACK` spelling still appears in older review text;
the shipped name is `GENERIC_NODE_UNMODELED_CAPABILITY`. This ledger makes no claim about how many
rules the scanner ships or about the precise semantics of any individual capability.

The public tree is reference evidence only: read its two-code implementation and tests, never edit,
sync, or roll them back. Migration order is C-05 after C-01 and D-02; D-02 after D-01 and E-04's
additive vocabulary slice, which applies the registry row and generated contract together.

## Action inputs as shipped

`.github/actions/scan/action.yml` (extracted as-is; it never runs in this repository).

| Input | Required | Default | Meaning |
| --- | --- | --- | --- |
| `scanner-ref` | yes | — | Full 40-hex commit SHA of the scanner repository to build. A branch, tag, short SHA, or uppercase hex is refused with exit 2 before any checkout. |
| `scanner-repository` | no | `jitwark/n8n-Secureflow` | Scanner repository to check out. |
| `path` | no | `.` | Workflow file or directory, relative to `GITHUB_WORKSPACE`. |
| `fail-on` | no | `high` | Minimum severity that fails the run (`critical`, `high`, `medium`, `low`, `info`). |
| `sarif-file` | no | `n8n-scan.sarif` | SARIF output path, relative to `GITHUB_WORKSPACE`. |

Outputs are `sarif-file` and `exit-code`, both written to `GITHUB_OUTPUT` after the scan, including
when the scan fails.

## Source isolation

The scanner is checked out at `.scanner-source` **inside the caller workspace** (`actions/checkout`
accepts only a workspace-relative `path`), installed with `npm ci --ignore-scripts`, and built with
`npm run build --workspace=sfscanner` in that directory. Nothing is installed or built in the
caller's own tree.

With the default `path: .`, the CLI walks `**/*.json` and excludes only `.git/**` and
`node_modules/**`; a checkout beneath the workspace would therefore be consumed as caller input.
Measured before the fix: `.scanner-source/package.json` appeared as an admitted input and produced
`MALFORMED_WORKFLOW` with exit 3. The scan step now passes the CLI's existing `--exclude` flag with
`.scanner-source/**`, and spells out `.git/**` and `node_modules/**` because supplying any
`--exclude` replaces the built-in defaults. `action-surface.test.ts` runs the shipped scan script
against the real locally built CLI and fails if that exclusion is removed.

Residual, disclosed and not re-ban-able here: the pre-scan guard in the run block is lexical, not
`realpath`/symlink aware, so an in-workspace symlink can still point outside. Writing the declared
SARIF file (and `GITHUB_OUTPUT` lines) into the caller workspace is the intended contract, not a
read-only violation — the contract bans caller dependency installs and builds, not the report.

## Evidence status (dated)

| Receipt | What it accepted on its date | What it is not |
| --- | --- | --- |
| [`119-semantic-metadata-independent-security-runtime-acceptance.md`](../audits/2026-10-19-production-readiness/119-semantic-metadata-independent-security-runtime-acceptance.md) | `SEC_RUNTIME_READY` for that candidate: built CLI, spawned stdio MCP, core/pipeline retention, offline installed consumer, including the C-04 admission files | not a release approval, not a code/type re-review, not this checkout's identity |
| [`127-web-remediation-completion.md`](../audits/2026-10-19-production-readiness/127-web-remediation-completion.md) | web lane source complete | public journey and release identity still blocked |
| [`146-browser-grade-root-fix.md`](../audits/2026-10-19-production-readiness/146-browser-grade-root-fix.md) | browser report/export grade parity | not a package identity |
| [`149-private-governance-accuracy-implementation.md`](../audits/2026-10-19-production-readiness/149-private-governance-accuracy-implementation.md) | governance documents match the shipped binary, with its own gates | not a corpus or release claim |

## Historical unrun checkpoint — superseded for the published v0.2.1 release

The statements below describe the earlier migration checkpoint. Public extraction and publication subsequently passed; product source 6313d89097c09faad499f54deeee33c6571109d5 is public, and the actual pinned Action scan/SARIF run 42424040201 passed. The public caller uses immutable accepted pins, not zero placeholders. Formal corpus measurement completed with 112/144,043 reviewed executable instances and 0/9,669 fully modelled workflows; the 95%/90% targets were missed. See [programme status](programme-status.md) for current release facts.

- **Public extraction** of these files (`scripts/extract-public-repo.mjs`) — UNRUN.
- **Corpus scan / full corpus coverage** — UNRUN. No rule count or coverage figure is claimed here.
- **Live composite action run** — BLOCKED, no published scanner commit exists. The example's action
  pin and `scanner-ref` are both all zeros and say so; the zeros are coherent placeholders, not a
  resolvable reference.
- **Published commit for the example** — UNRUN. When one exists, replace **both** zeros with that
  same full 40-hex SHA in one change, then record the live run. No fake SHA, no network lookup, and
  no publish from this repository.

## Verification hooks

- `npx vitest run --project scanner-cli packages/scanner-cli/src/action-surface.test.ts` — action
  structure, executed ref/path guards, and the real-CLI isolation/exit-propagation runs.
- `npx vitest run scripts/ci-workflow.test.mjs` — the extracted `ci.yml` still carries the
  standalone repository identity and source-only gate sequence.
