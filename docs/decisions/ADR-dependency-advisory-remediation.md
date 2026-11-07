# ADR: dependency advisory remediation for the October candidate

> Status: accepted for the October completion candidate — including the owner-waived `braces` advisory,
> with the waiver scoped by advisory id in `scripts/lib/audit-waivers.json` (see Gate consequence below)
> Date: 2026-10-17
> Scope: A1a/A1b, root and app dependency manifests and the single lockfile update

## Decision

Raise the supported patch floors and pin the patched transitive lines with nested `overrides` —
including `sharp`, whose patched release the hoisted tree would otherwise not adopt, because `next`
declares it as an optional dependency at `^0.35.4`. Patch level only: no
framework major/minor movement, no source modernization, and no `npm audit fix --force`.

| Package | From | To | Advisory and fixed version (official) |
| --- | --- | --- | --- |
| `next` | 16.3.6 | 16.3.8 | six advisories, all `>=16.0.0 <16.3.8` / `>=16.3.0 <16.3.8` — GHSA-3w37-wq28-93x7, GHSA-4jqv-mc3x-m676, GHSA-39w2-rjm5-chcv, GHSA-f87g-xv8r-7p7x, GHSA-mcj8-r9mp-w47p, GHSA-cjq9-62q9-8jv4 |
| `eslint-config-next` | 16.3.6 | 16.3.8 | no direct advisory for this package (GitHub advisory search returns none for `eslint-config-next`, `@next/eslint-plugin-next` or `fast-glob`); its audit entry exists only because it carries the `braces` chain below, and it **stays** at 16.3.8 |
| `sharp` | 0.35.4 | 0.35.5 | librsvg use-after-free (CVE-2026-96889, RCE on glibc when decoding SVG through sharp), `sharp<0.35.5` — GHSA-wq5f-xc86-pv6w |
| `source-map-js` | 1.2.1 (transitive) | 1.2.2 | indexed source-map section offsets DoS, `>=1.0.0 <1.2.2` — GHSA-68fv-2mgg-jv7q |
| `brace-expansion` | 1.1.18 / 5.0.9 (transitive) | 1.1.21 / 5.0.12 | brace-group recursion/quadratic DoS — GHSA-q2hr-2g5m-vwhr (`<1.1.21 \|\| >=4.0.0 <5.0.12`), GHSA-qhr7-859c-m2p7, GHSA-6j4f-fj2g-mc7p |

Transitive lines are pinned with nested npm `overrides` keyed by their parent, so the 1.x consumers
(`minimatch@3`, via `eslint`) and the 5.x consumer (`minimatch@10`, via `typescript-eslint`) each
receive the patched release of their own major rather than a cross-major force.

## Evidence

- `docs/audit/2026-10-17-remediation/npm-audit.json` records the planning-time audit:
  `{info:0, low:0, moderate:0, high:9, critical:0}`. Nine package entries are not nine independent
  exploits; the entries are the package graph nodes that the advisories above propagate through
  (`next`, `sharp`, `source-map-js`, `brace-expansion`, and the `eslint-config-next` →
  `@next/eslint-plugin-next` → `fast-glob` → `micromatch` → `braces` chain).
- Registry metadata read 2026-10-17: `next` stable `16.3.8` (latest `16.4.2`), `sharp` `0.35.5`,
  `source-map-js` `1.2.2`, `brace-expansion` `1.1.21` and `5.0.12`.
- `@next/eslint-plugin-next@16.3.8` still declares `fast-glob: 3.3.1`, whose `micromatch@4.0.8`
  resolves `braces@3.0.3`.
- `next@16.3.8` requires Node `>=20`; the candidate toolchain is Node 22 LTS, so no runtime floor
  changes.

## Accepted residual

`braces` stays at `3.0.3`. The official advisory GHSA-vfj7-8cjw-p6xm (CVE-2026-93687, CVSS 4.0 8.7,
EPSS 0.757%) covers `braces <= 3.0.3` and states **Patched versions: None**; `3.0.3` is the newest
published release and `micromatch@4.0.8` is its newest release too. The audit therefore retains
**five high entries — `braces`, `micromatch`, `fast-glob`, `@next/eslint-plugin-next`,
`eslint-config-next` — which are one advisory propagating through one chain**, not five findings.
Every one of those entries offers the same remedy: downgrade `eslint-config-next` to `14.2.35`, a
semver-major Next downgrade this ADR refuses.

No released version of the plugin removes the chain: `@next/eslint-plugin-next` `16.3.8`, `16.4.0`,
`16.4.2` and `16.5.0-canary.15` all declare `fast-glob: 3.3.1` (registry, 2026-10-17), and
`eslint-config-next` itself is only an entry because it depends on that plugin.

Reachability: the chain enters through ESLint configuration only. It is not in `next build`, not in
any emitted browser or worker byte, and the DoS requires an attacker-controlled brace pattern handed
to `micromatch`; the only patterns here are repository-owned lint globs.

**Gate consequence — decided by the owner, 2026-10-17.** `npm audit --audit-level=moderate` is a core
release gate (`scripts/run-gates.mjs:31,146-147`) and it exits `1` on these five entries; it is executed
by the top-level `.github/workflows/ci.yml` `community-hub` job (`npm run gates`) and by
`.github/workflows/deploy.yml` (`npm run release:gates`). The residual therefore blocked the site's CI
gate job and its Pages deploy. The plan's instruction was to record the blocker rather than weaken the
gate, so this ADR escalated it rather than choosing, and the owner has now decided: **accept and waive
the advisory for this release, wait for an upstream patch, and do not force a semver-major Next
downgrade.** The directive also rules out the third option below (a production-surface-only audit), and
rules out making either repository public.

The waiver is implemented as a gate that still works rather than a gate that is switched off:

- `scripts/lib/audit-waivers.json` is the registry of accepted advisories. Each entry names the
  advisory id, the package, the dependency chain, why it is unreachable here, who decided it and when,
  and what would end the waiver.
- `scripts/audit-with-waivers.mjs` (run as `npm run check:audit`) runs the same
  `npm audit --json --audit-level=moderate`, subtracts **only** advisories whose id appears in that
  registry, prints every waiver it applies, and exits `1` on anything else.
- The `audit` stage in `scripts/run-gates.mjs` runs this gate instead of `npm audit` directly, so
  `gates`, `gates:source` and `release:gates` all evaluate it identically. `audit` remains a core gate
  and is still not excluded from the source sequence.

Two properties were verified rather than assumed, and they are the reason this is a scoped exception and
not a silent weakening: with the registry in place the gate exits `0` and prints all five entries as
waived; with an **empty** registry the same gate exits `1` and lists all five as un-waived. A new
advisory therefore cannot ride along on this waiver. The first implementation passed an empty registry
— npm's `via.source` is a numeric advisory id, and a parentless propagation node was passing vacuously —
and both bugs were caught by that second run, which is why the tooth proof is recorded here as part of
the decision rather than as a detail of the tooling.

The three options that were offered unilaterally:

1. hold the release until upstream patches `braces` — **not taken**; the owner accepted the residual;
2. drop the Next ESLint plugin from linting (loses Next's rule set — a product decision) — **not taken**;
3. change the gate to audit the production surface only (`--omit=dev`) — a policy weakening that would
   also stop the gate from seeing runtime advisories — **explicitly not taken**; the registry keeps the
   runtime and dev surfaces under the same check and waives by advisory id instead.

Note that `audit` runs in **every** gate sequence: it is a `CORE_GATES` member and is not in
`SOURCE_EXCLUDED` (`scripts/run-gates.mjs`), so `gates`, `gates:source` and `release:gates` all evaluate
it — the per-push `community-hub` source sequence included, not only the toplevel job. (An earlier
revision of this paragraph claimed `gates:source` excluded `audit`; that was wrong, and the sequences
are the evidence.)

## Consequences

- One lockfile update, applied by root, with the full `npm audit --json` result retained alongside
  the planning-time baseline so the delta is auditable.
- Any change to `next` patch level invalidates font-preload (`FE-02`) and emitted-worker evidence;
  those checks re-run on the rebuilt candidate rather than being carried forward.
- Install-lifecycle surface of the new tree was compared against HEAD: the `hasInstallScript` set is
  unchanged (`esbuild`, `fsevents`, `playwright/node_modules/fsevents`, `unrs-resolver`).

## Revisit trigger

A published patched `braces` release, an `eslint-config-next` release that drops `fast-glob`, a new
advisory inside the current ranges, any change that would require moving off the `16.3.x` line, or
either override-masking case:

- the bare-name overrides (`sharp`, `source-map-js`) silently install their pinned version even if a
  parent later requires a different major — so revisit when `next` moves off `sharp` `0.35.x`, or
  `postcss` / `css-tree` / `@tailwindcss/node` move off `source-map-js` `1.x`;
- the keyed overrides (`minimatch@3`, `minimatch@10`) do not match a new `minimatch` 4–9 range or a
  `brace-expansion` 2.x/3.x consumer; those lines have their own patched releases (2.1.7 / 3.0.9)
  that no override currently covers.

## November 7, 2026 release recheck

The resumed release audit found eight propagated package entries rooted in
`minimatch@10.2.6`, covered by
[GHSA-g3hv-75wg-m249](https://github.com/advisories/GHSA-g3hv-75wg-m249).
The advisory identifies versions `>=7.0.0 <11.0.1` as affected and `11.0.1` as
patched. The existing `minimatch@10` override now selects `11.0.1`; the independent
`minimatch@3` and brace-expansion overrides remain in place. This changes ESLint's
TypeScript tooling dependency, with no scanner runtime dependency change.

Node 22.17.0 incremental installation ran with lifecycle scripts disabled.
Unrelated install metadata changes were restored verbatim; comparison with the
immediate pre-edit snapshot shows only the minimatch upgrade and its new
`@isaacs/nonrecursive-glob-match@1.1.0` dependency. The complete workspace lint and
existing moderate-level audit gate pass after this change; the audit reports no
advisories. No new waiver or audit exclusion was added. Independent review is
recorded in `docs/audit/2026-11-03-first-release/DEPENDENCY-REVIEW-20261107.md`.

