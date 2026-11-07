# ADR: Scanner findings are deterministic, never model output

> Status: accepted
> Date: 2026-09-04
> Owner: Community Hub maintainers
> Supersedes: nothing. This records an invariant the codebase has always held but never wrote down.

## Context

The pipeline uses a language model. `data/manifest.json` records
`model: gemini-3.7-flash-low` and `promptVersion: describe-6-json-workflow-lexical-check`, and
every catalogue entry carries `descriptionSource: generated`. The model writes prose about what a
workflow does.

The scanner does not use a model at all. Findings come from hand-written TypeScript policies in
`packages/scanner-core/src/policies/`, each implementing `ScanPolicy` and returning
`ScanFinding[]`.

Nothing recorded *why*. `STATUS.md` stated the rule in its decisions section — *"The scanner is
deterministic and policy-driven. Model output may provide prose only; licences, authors, counts,
links, and security verdicts render from pipeline fields"* — but a status document is a snapshot,
not a decision record, and status documents get rewritten.

The absence had a concrete cost. The repository-root `CLAUDE.md` cited **"ADR-004"** as fixing this
boundary. `ADR-004-scanner-beta-ingestion-boundary.md` exists only in the parent-root legacy tree,
alongside `ADR-001-use-next-drizzle-supabase.md` and `ADR-006-supabase-auth-organization-rls.md` —
the abandoned server product. It is about separating the scanner from ingestion, not about model
output. Every agent and contributor reading `CLAUDE.md` was pointed at a decision record that does
not govern this product and does not say what it was claimed to say.

The temptation this ADR guards against is real and will recur. A model is already in the pipeline
and already writing user-facing text. Asking it to also explain a finding, summarise a workflow's
risk, or grade an entry is one small step from where the code already is, and each step is
individually defensible.

## Decision

**A finding, its severity, a risk grade, and a rights decision are produced only by deterministic
code. Model output never becomes any of them.**

Concretely:

1. Every finding originates in a `ScanPolicy` implementation under
   `packages/scanner-core/src/policies/`, or in the analyzers those policies call.
2. Every finding leaves through `canonicalizeFindings`
   (`packages/scanner-core/src/result/canonical-findings.ts`), which structurally validates and
   redacts it. Malformed policy output is dropped and counted, never thrown, and never rendered.
3. Severity, `policyEffect`, and risk grade come from the rule catalogue and the scoring code, not
   from prose.
4. Rights decisions and licence classifications come from `contracts/rights.ts` and the
   acquisition record, not from inference.
5. Model prose is confined to entry descriptions, is marked `descriptionSource: generated`, and is
   never an input to a policy.

`packages/scanner-core` contains **no network client, no clock, no RNG, and no locale-dependent
ordering**. Three targeted greps over its source returned zero occurrences each on 2026-09-04.
That property is what makes a model call structurally impossible there, not merely discouraged.

## Consequences

**What this buys.**

- **Reproducibility.** The same workflow produces the same findings on any machine, at any time,
  offline. Two scans of the same input are diffable; a change in output means a change in code.
- **Auditability.** A user can ask "why did you flag this?" and be shown a rule, not a sample.
- **Offline operation.** The browser scanner runs in a Web Worker with no network access
  (0 network calls in `app/src/scanner`, verified). The CLI runs with no credentials and no
  connectivity. Neither is possible if a finding needs an API call.
- **No prompt-injection surface in the verdict path.** The scanner reads untrusted workflow JSON,
  including free text in sticky notes and AI-agent prompts. If that text reached a model whose
  output became a finding, a workflow could talk the scanner out of flagging it. It cannot,
  because there is no such path.

**What this costs.**

- Adding a detection means writing a policy, a test, and a calibration case. There is no shortcut
  through a prompt.
- The scanner cannot produce fluent bespoke explanations of novel patterns. Remediation guidance is
  written once, by hand, per rule, in `docs/scanner/policy-inventory.md`.
- Coverage grows linearly with authored rules. `docs/scanner/limitations.md` records what is not
  covered, and that list is honest rather than papered over.

## Scope

This ADR governs findings, severities, grades, and rights decisions. It does **not** forbid model
use elsewhere in the pipeline; entry descriptions are generated today and that is expected to
continue. It also does not forbid a future feature that presents model-written *commentary*
alongside findings — provided such commentary is visibly separated, never alters a verdict, and
never becomes an input to a policy.

Changing the decision requires a superseding ADR that states what replaces reproducibility,
offline operation, and the absent prompt-injection surface.

## References

- `packages/scanner-core/src/policies/` — the policy implementations
- `packages/scanner-core/src/result/canonical-findings.ts` — the single redaction exit boundary
- `docs/scanner/architecture.md` — the four-layer pipeline
- `docs/scanner/limitations.md` — what deterministic coverage does not reach
- `docs/ENRICHMENT-POLICY.md` — where model output *is* permitted
- `ADR-json-only-gemini-input.md`, `ADR-fail-closed-gemini-publication.md`,
  `ADR-structured-description-contract.md` — the constraints on that permitted use
