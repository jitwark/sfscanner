# ADR — Generic node semantic fallback (v2 scanner)

- Status: accepted (owner-directed, 2026-10-17); **contract amended and implemented by the 2026-10-19
  remediation (E-04a/D-01/D-02), frozen pending independent runtime acceptance**
- Packet: `docs/audit/2026-10-17-remediation/generic-fallback-plan.md` (plan), `…-report.md` (evidence)
- Remediation plan: `docs/superpowers/plans/2026-10-19-scanner-remediation-coverage.md` D-02,
  `…-governance.md` E-04; correction receipts
  `docs/audits/2026-10-19-production-readiness/76-semantic-coverage-plan-correction.md` and
  `…/106-semantic-remediation-acceptance-corrections.md`
- Scope: `packages/scanner-core/src/**` only; no bound widening, no new dependency, no promotion

## 1. Context — the coverage gap and its root cause

The v2 engine resolves every node against the admitted built-in semantic catalogue
(`semantics/builtin-catalogue.ts`, 25 records before D-01; 32 records across 31 types after the
2026-10-19 remediation). A node type outside it resolved to nothing in both
places that resolve per node:

1. `v2/scan-workflow.ts` `semanticView()` — the node was simply absent from
   `context.semantics.resolvedNodeSemantics`;
2. `capabilities/semantic-context.ts` — the node produced
   `SEMANTIC_CATALOGUE_MISS` at `required: true`, whose registry row is `BY_CAPABILITY`, i.e.
   `aggregateEffect: INDETERMINATE`, `assessmentEligible: false`
   (`diagnostics/registry.ts:76`).

The gap is the catalogue's node-**type** register (24 types / 25 records before D-01), not a
workflow-size or input-node limit: the admission ceiling remains 5,000 nodes, and the suppressed
assessment was the workflow-level verdict, not a per-node rejection.

`result-v2/compose-result.ts:135` promotes that to workflow status INDETERMINATE, and `:65` nulls
`assessment` whenever the status is INDETERMINATE. The audits themselves never depended on the
catalogue: the structural policies (`policies/*.ts`) run over node types and parameters, so
`RAW_SECRET_INDICATOR`, `RAW_AUTH_HEADER`, `UNAPPROVED_DOMAIN`, `UNKNOWN_NODE_PACKAGE`,
`N8N_EXECUTE_COMMAND`, `N8N_CODE_NODE` and `WEBHOOK_EXPOSURE` were already computed for unmodelled
nodes — and then dropped from the verdict. Captured pre-change evidence (owner scenario,
`manualTrigger → n8n-nodes-base.googleSheets` carrying an AWS secret key):
`status INDETERMINATE`, `assessment null`, `SEMANTIC_CATALOGUE_MISS · INDETERMINATE · eligible:false`,
findings `RAW_SECRET_INDICATOR · HIGH · CONFIGURATION · OBSERVED`, all five capabilities COMPLETED.

Measured effect on the real corpus: **11,029 of 11,043 rescanned rows carried INDETERMINATE with
`assessment: null`; 14 rows carried a grade** (11,464 rows in the census, 11,043 `CURRENT`).

## 2. Decision

An unmodelled node resolves to a **conservative generic fallback record**
(`semantics/generic-fallback.ts`, `semanticId: 'generic.fallback'`) synthesised at the resolution
seam, and the coverage diagnostic for it is emitted at **degraded requiredness**, so the workflow
receives a real grade while the assumption is declared per node.

### 2.1 Fallback record, field by field, and why each value is the conservative choice

| field | value | conservative because |
|---|---|---|
| `nodeType` | the scanned node's type | `analyzers/destinations/inventory.ts` refuses a record that does not match the node |
| `versionRange` | `GTE 1.0.0` | claims nothing about which n8n versions the assumption applies to |
| `operation` / `entry` | `null` / `NONE` | makes no claim that the node is a trigger or that it has operations |
| `parameterPaths` | `[]` | the record claims to know nothing about the node's parameters; the parameter audits read the parameters themselves |
| `authentication` | `null` | no claim that inbound traffic is authenticated or unauthenticated |
| `credentialPaths` | `['/credentials']` | n8n keeps credentials in one place; the audit path is preserved |
| `destinationPaths` | `[]` | destinations are exact JSON pointers; no wildcard exists, so the honest value is "not claimed" |
| `effects` | `READ_EXTERNAL`, `WRITE_EXTERNAL` | assumes the node may both read and write outside the workflow |
| `endpoints` | `[]` | endpoints are exact pointers; taint still passes through the node (below) rather than being dropped |
| `ports` | `main/0/EACH` | standard main-in → main-out passthrough |
| `overwritePaths` | `[]` | claiming an overwrite would *kill* confidentiality/integrity labels — the opposite of conservative |
| `errorMode` / `retryMode` | `UNKNOWN` | `analyzers/taint-v2/transfer.ts:32` marks taint states uncertain instead of claiming a controlled failure mode |
| `disabledMode` | `SKIP` | catalogue default |
| `provenance` | docs root, digest over the fallback's own contract text, `reviewedAt 2026-10-17`, `reviewer scanner-core-generic-fallback` | no upstream page is claimed as a source; the digest binds the assumption's own text |

The record is **not** added to the admitted catalogue: that would move
`SEMANTIC_CATALOGUE_DIGEST_V2`, which `packages/scanner-cli/src/v2/contracts.ts:44` pins and
`semantics-digest-parity.test.ts` guards, and no upstream source exists to admit it against.

### 2.2 The coverage diagnostics

**Landed private state (2026-10-19 remediation).** A readable unmodelled node emits **two**
diagnostics at its own source location, both at `required=false`, in this order:

| code | registry effect | meaning |
|---|---|---|
| `SEMANTIC_CATALOGUE_MISS` | `BY_CAPABILITY`, resolved at `false` → `DEGRADED`, eligible | the node type has no admitted catalogue record; the same code the fail-closed path emits at caller requiredness |
| `GENERIC_NODE_UNMODELED_CAPABILITY` | fixed `CATALOGUE` / `DEGRADED` / eligible | the verdict rests on unmodelled-capability defaults: destinations are unknown, **not** audited-and-empty |

Neither substitutes for the other. A genuinely unresolvable node keeps only the first at the caller's
requiredness and no capability code: a **required** miss is `INDETERMINATE` with
`assessment:null`, an **optional** miss is `DEGRADED`/eligible and does not null the assessment by
itself. An independent required capability failure still nulls it. The private registry now has 28
rows, and the D-01 catalogue has 32 records across 31 types. E-04a created the active OpenSpec
requirement and the generated registry row/contract mirror; D-02 consumes the registered code and
does not hand-edit generated files. Both codes are per node, deterministic, and cannot null the
assessment by themselves.

The same landing adds `/operation` then `/action` resolution for **catalogue** per-operation
records: a string operation wins even when an action also exists, a non-string value falls through to
the action value, no conflict diagnostic is added, and an unknown action string does not invent a
per-operation generic record (the fallback record keeps `operation: null`). The pointer match remains
the shipped suffix match; it is a bounded limitation, not an exact-pointer guarantee.

**Historical note on the initial release.** At the initial release the tag reused
`SEMANTIC_CATALOGUE_MISS` instead of adding a code: `diagnostics/registry.ts` is generated ("DO NOT
EDIT") from a table in `openspec/` by `scripts/`, and the closed allowlist is mirrored into
`contracts/scanner-v2-diagnostics.generated.ts`. Both were outside that packet's allowed scope, and
`contracts/scanner-v2-result.ts` rejects an unregistered code, so a new code would have failed
composition and every `check:*` gate. The fallback's internal name is `semanticId:
'generic.fallback'`. The remediation plan now adds the registered code through the same generator,
not by editing generated files by hand.

The diagnostics are user-visible, not only internal: the v2 report renders every
`analysis.diagnostics` entry in its Coverage diagnostics section
(`app/src/scanner/report-v2/report-coverage.tsx:69-72`) as `CODE · EFFECT`, and the CLI envelope
carries the full result. At this revision a reader sees `SEMANTIC_CATALOGUE_MISS · DEGRADED` per
fallback node; after remediation both `SEMANTIC_CATALOGUE_MISS · DEGRADED` (catalogue coverage) and
`GENERIC_NODE_UNMODELED_CAPABILITY · DEGRADED` (unmodelled-capability assumption) appear, so a reader
knows part of the verdict rests on the assumption rather than on modelled behaviour.

### 2.3 The Global Constraint, addressed

Plan-of-record constraint: *"No current/clean verdict inferred from an engine stamp or sanitized
pack."* This change does not do that, in three checkable ways:

1. **No stamp is read.** Nothing consults a stored verdict, a version field or a freshness receipt.
   The grade comes from `scoreFindingsV2` over findings the same engine produced in the same run.
2. **The audits still run.** The fallback changes only the record used for data-flow assumptions; the
   parameter, credential, secret-indicator and URL audits execute against the node's parameters
   exactly as before (proved by the pre-change capture above, where the secret finding already
   existed while the grade was withheld).
3. **The assumption is labelled, not hidden.** Every fallback node produces a degraded coverage
   diagnostic at its own location — the count of such diagnostics is the number of nodes whose
   analysis rests on the assumption — and the docs define the meaning.

The forbidden pattern (publishing a grade over a sanitized pack, or re-stamping historical rows
without re-scanning) is untouched: this packet writes nothing to `data/` or `app/public/data/` and
runs no promotion.

## 3. What analysis is lost, and how far the loss is bounded

A generic record cannot enable what a modelled record enables. The consumers of the record are
enumerable — `grep` over `packages/scanner-core/src` finds exactly five, all outside the
resolution/scheduler plumbing: `analyzers/destinations/inventory.ts` (the shipped profile's only
semantics consumer) and, in the non-admitted hardened profile, `taint-v2/transfer.ts`,
`taint-v2/worklist.ts`, `taint-v2/catalogue-adapter.ts` and `taint-v2/subworkflow.ts`. The finding
classes that therefore cannot fire *through the catalogue* for a fallback node:

1. **Destination-inventory facts (`destination.v2`).** Modelled records carry `destinationPaths`; the
   fallback claims none, so the inventory emits no destination record for that node. Findings keep
   their own parameter evidence (`UNAPPROVED_DOMAIN`'s destination fact is built in
   `adapter-evidence.ts` from the parameter scan, not from the record), so no finding today loses its
   evidence — but the result-level destination facts of that node are absent.
2. **Taint sink/source/sanitizer behaviour (hardened profile).** No endpoints, no overwrite paths:
   incoming taint passes through with the same field/port/item and is flagged uncertain; the node can
   never be the *entry* of a `TAINTED_*` finding by itself. In the shipped `beta-default` profile no
   taint capability is configured, so this is a statement about the hardened profile only. The
   fallback runs the **seven** policies scored by the admitted `beta-default@2.0.0` profile; the
   **ten** advisory analyzers in `beta-hardened@2.0.0` (17 total) are defined but unadmitted and do
   not run. No claim is made that all 17 policies operate on unknown nodes.
3. **AI/agentic structure.** A fallback record claims only `main` ports, so an unmodelled AI node
   cannot contribute `ai_tool` edges and cannot produce agentic-control findings.
4. **Ingress/authentication semantics.** `authentication`/`entry` are unclaimed. No consumer reads
   them today (`WEBHOOK_EXPOSURE` is parameter-driven), so nothing is lost today; the claim is simply
   not made.
5. **Code-shaped parameters.** Selection for code analysis is by node type
   (`analyzers/code/javascript-analysis.ts:45`), not by semantics: code inside an unmodelled node type
   was never analysed and still is not. The fallback does not add it. The parameter audits still
   inspect those values (test case: secret inside a nested code-shaped parameter is reported).

Bound: "we cannot enumerate the loss" is false for the present consumers (four, listed) and true for
the future: any new rule or consumer that would have used a modelled record for a given node family
cannot be evaluated from a generic record. Enumerating that requires per-family modelling or the
Milestone 2 harvester, because the catalogue records themselves are the only statement of what was
known.

Additional bounded effect: fallback nodes now also enter the destination inventory walk, which is
charged against `maxMembersAndElements`; a very large workflow could exhaust that shared budget
earlier and emit fewer result-level destination facts. Findings are unaffected (they never used the
inventory), so the direction of the failure is "fewer advisory facts", never "clean verdict".

## 4. What stays unassessable (`INDETERMINATE`, `assessment: null`), and why

- **Node fields not readable**: duplicate `parameters` members, non-object `parameters`/`credentials`/
  `settings`, duplicate `id`/`name`/node members, unreadable `typeVersion`/`disabled` — the node's
  `scoringEligibility` is `INDETERMINATE`, the fallback is refused, and the miss keeps the caller's
  requiredness (`INDETERMINATE` for the required structural capability).
- **Unreadable `type` member** (duplicate `type` keys): the node normalizes to an empty type, the
  resolver refuses it, and the scan fails closed with `SEMANTIC_CATALOGUE_INVALID` — never a grade.
- **Duplicate security keys inside parameters**, malformed connection indices and malformed security
  values: their own ambiguity diagnostics are `INDETERMINATE`/ineligible and are unaffected by this
  change.
- **Required budget exhaustion** (`maxDiagnostics`, security-required stored-span loss, redaction
  limits), **required capability failure**, **unknown scoring rule** and **projection loss**: all
  unchanged; each is covered by the fail-open canaries.

These are the inputs for which "we cannot judge this" remains the answer; they are the fail-closed
subject the canaries keep so this cannot drift into "everything is assessable".

## 5. Identity and versioning decision

`ADMITTED_ENGINE_VERSION`, `ADMITTED_PROFILE_ID/VERSION` (`beta-default@2.0.0`) and
`ENGINE_BUILD_DIGEST_V2` stay unchanged, and the ADR states the cost rather than hiding it: the
profile's *meaning* moved (workflows that previously refused to assess are now graded) while its
identity did not, because every identity pin lives outside this packet's allowed scope — the
catalogue/ruleset/profile digests in `packages/scanner-cli/src/v2/contracts.ts`, the claim list in
`packages/scanner-cli/src/v2/help.ts:108`, the generated CLI docs, and the freshness receipts
(`scripts/scanner-result-freshness.json`). A version bump must move those in one step and belongs to
the owner's sequencing; the mitigation shipped now is that the difference is observable per result
(a per-node degraded coverage diagnostic and a status of `DEGRADED` instead of `INDETERMINATE`), so
no result is ambiguous about which behaviour produced it.

## 6. Historical corpus verification (2026-10-17 before/after; not current execution)

This section records the owner-cited measurement that justified the initial fallback. It is **not**
a current private execution: it was not re-run for the 2026-10-19 planned correction, and the
`11,029` / `14` figures are the ADR's **before** measurement, not the state of the current tree.

Measured with the committed derivation, twice, from the repository root — the only difference being
the fallback line:

```
npx tsx pipeline/regenerate/v2-cli.ts --data data \
  --inventory docs/audit/2026-10-17-remediation/C1-real-inventory.json \
  --map pipeline/.work/official-body-map.json \
  --bodies "D:/projects/n8n templates/04_curated_official_and_github/official" \
  --bodies "D:/projects/n8n templates/05_backfilled_official" \
  --out pipeline/.work/generic-fallback-corpus/<before|after>
```

Census identical in both runs (and to the C3 baseline): 11,464 rows; CURRENT 11,043 / HISTORICAL 354 /
SOURCE_UNAVAILABLE 67; 11,066 rows read a body (11,043 `ok`, 23 item failures).

| measure | before (fallback disabled) | after |
|---|---|---|
| status DEGRADED | 0 | 10,844 |
| status COMPLETE | 14 | 14 |
| status INDETERMINATE | 11,052 | 208 |
| rows with a grade | 14 (LOW 13, MEDIUM 1) | **10,858** (LOW 4,847, MEDIUM 4,784, HIGH 638, CRITICAL 589) |
| rows with ≥ 1 finding | 7,766 | 7,766 |
| total findings | 25,158 | 25,158 |
| `SEMANTIC_CATALOGUE_MISS` rows | 11,029 (INDETERMINATE, ineligible) | 11,029 (DEGRADED, eligible) |

The audit output is **identical** before and after — same rows with findings, same finding counts —
which is the measurement behind §2.3: the fallback changed the verdict, not the evidence. The miss
population is unchanged at 11,029 rows and splits into 10,844 that now carry a grade and 185 that
remain INDETERMINATE for an independent reason (the remaining 23 INDETERMINATE rows are item failures
that never produced a status). Other after-run diagnostics: `DEPENDENCY_UNAVAILABLE` 112,
`REQUIRED_CAPABILITY_FAILED` 112, `MALFORMED_CONNECTION_INDEX` 59, `DUPLICATE_SECURITY_KEY` 36,
`MALFORMED_NODE_PARAMETERS` 2, `OPTIONAL_LIMIT_EXCEEDED` 2 — all unchanged from before except the
miss's effect.

Nothing was written under `data/` or `app/public/data/` and no promotion was run; the two runs wrote
only their own `--out` directories under the gitignored `pipeline/.work/`.

The after-run still emits the **single** miss code; the second
`GENERIC_NODE_UNMODELED_CAPABILITY` code and `/action` resolution are the 2026-10-19 planned
remediation (E-04/D-02), not part of this measurement. Do not cite these figures as a current private
scan or as proof the remediation landed.

## 7. Deferred: Automated Semantic Catalogue Harvester (Milestone 2)

Deferred decision, recorded here so it is not lost: generate the catalogue from n8n's official
`INodeTypeDescription` schemas instead of hand-modelling node families. What it changes when it
lands: records carry real parameter paths, destinations, effects and ports, so the fallback applies
to strictly fewer nodes; the assumed knowledge in §2.1 shrinks to the residue the schemas cannot
express. The registered `GENERIC_NODE_UNMODELED_CAPABILITY` code is **not** deferred to this
milestone: the 2026-10-19 remediation adds it through E-04's additive OpenSpec change (row + contract
mirror + digest pins generated together), with D-02 consuming it.

## 8. Consequences

- The shipped browser scanner and the pipeline share the same engine (`packages/scanner-core/src/v2`),
  so both now grade unmodelled workflows, with the coverage diagnostic rendered in the report. The
  **stored** catalogue verdicts are not re-derived by this change: each entry keeps the scanner identity it
  was scanned under, which may predate this engine.
- The result content changes for previously-refused inputs while the identity fields do not (§5).
- No bound (`maxNodes`, `maxBytes`, `workerDeadlineMs`, …) is widened; the added per-node work is
  bounded by budgets that already existed (`maxMembersAndElements` for the inventory).
- Rollback is a revert of four files (`semantics/generic-fallback.ts`, one call site in
  `v2/scan-workflow.ts`, one loop in `capabilities/semantic-context.ts`, plus test expectations).

## Version decision (owner, 2026-10-17): `beta-default@2.0.0` stands

The open question this ADR raised — whether the admitted profile's version must move when its *behaviour*
does — is decided: **keep the identifier, do not bump, do not churn golden fixtures**, and record here that
`2.0.0` **includes the generic integration fallback**.

The honest consequence, stated rather than implied: the same identifier now produces different verdicts than
it did before this change (it previously refused to assess most workflows and now grades them
conservatively), and the admitted-scan identity — which digests the limits and a declared build digest — does
not record that difference. Anyone comparing two runs across this boundary must know it exists, because the
identity tuple will not tell them. The alternative (bump the version and move every pin: goldens, the
canonical claim at `help.ts:108`, the profile manifest and the generated CLI docs) was considered and
declined for this release, so that churn is deferred rather than forgotten.
