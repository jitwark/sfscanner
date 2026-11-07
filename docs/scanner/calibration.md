# Synthetic scanner calibration

This calibration slice is a redistributable, synthetic corpus for the local
scanner. It contains 27 hand-authored workflow inputs: 14 development cases
and 13 holdout cases. It does not use private workflows, the committed
production corpus, credentials, environment files, Firebase material, or
network services.

The corpus lives in
[`pipeline/calibration/calibration-cases.ts`](../../pipeline/calibration/calibration-cases.ts).
The runner is
[`pipeline/calibration/calibration-runner.ts`](../../pipeline/calibration/calibration-runner.ts),
and it invokes the same transport-free seam used by the CLI:
`pipeline/cli/scan-core.ts`.

## Case contract

Each case carries:

- a stable kebab-case ID and canonical fixture hash;
- a `development` or `holdout` split and an explicit stratum/theme;
- the selected scanner profile and approved-domain input;
- expected policy IDs, effects, and severities;
- expected accepted/rejected status and analysis completeness;
- allowed evidence notes, reviewer identity/date, and reviewer rationale; and
- an optional false-negative-probe marker.

The canonical fixture is hashed with the scanner-core canonical JSON serializer
and SHA-256. Accepted cases must also have canonical JSON equal to the authored
workflow object. Rejected malformed-input cases hash their authored raw input.
Before scanning, the runner rejects duplicate/invalid IDs, missing review
metadata, unsupported profile-policy identities, effect/severity labels that do
not match the selected rule catalogue, malformed status expectations, and hash
or canonical-fixture mismatches. This is intentionally fail-closed.

The fixtures cover the seven direct legacy families, clean controls, JavaScript
and Python analyzer positives/negatives, tainted command and URL flows, an AI
tool-control case, unsupported code variants, indeterminate parameters, and
malformed JSON. A separate adversarial slice adds a cyclic graph,
deep and wide resource payloads, a large-but-accepted value, an oversized
payload, Unicode/control values, malformed Unicode escaping, repeated
JavaScript/Python findings that hit analyzer caps, an unsupported language, and
malformed JavaScript. The unsupported-code probes are deliberately labelled as
semantic dynamic-execution probes even though the current bounded analyzer does
not claim those variants; their misses are surfaced as false negatives.

## Adversarial evidence strata

The additional cases stay synthetic and preserve the development/holdout split:

| Stratum | Cases | What it demonstrates |
| --- | --- | --- |
| `resource-adversarial` | 6 | Cyclic traversal, connection-depth, node-width, parameter-leaf, large-value, and payload-byte boundaries. |
| `input-adversarial` | 2 | Valid escaped control/Unicode data stays accepted; malformed Unicode escape is rejected. |
| `analyzer-adversarial` | 4 | JavaScript/Python repeated-finding caps, unsupported language diagnostics, and malformed-source diagnostics. |

The resource cases intentionally exercise the shared default limits at the
boundary or just beyond it. The large-but-accepted case remains below the byte
cap, while the oversized case exceeds it. The repeated-finding cases expect a
`DEGRADED` result and `ANALYSIS_LIMIT_EXCEEDED`; they measure bounded reporting,
not twelve independent policy examples. The cyclic case demonstrates that a
small cycle terminates with a complete result and no capability finding.

## Report semantics

Call `runCalibration(calibrationCases)` from a Node/pipeline script. Pass an
injected `now` function in tests or reproducibility checks; production-style
runs default to the local monotonic performance clock. No runner path calls a
network or an external model.

Policy precision and recall are binary, case-level measures:

- expected case: the policy ID is present in the case label;
- observed case: at least one scanner finding has that policy ID;
- true positive: both are present;
- false positive: observed but not expected; and
- false negative: expected but not observed.

This avoids treating repeated evidence in one workflow as independent labelled
examples. `precision` or `recall` is `null` when its denominator is zero. The
case result separately records effect/severity mismatches, so a policy can be
present while its output identity still disagrees with the label.

`confusionThemes` groups cases by their authored theme and reports case IDs,
policy-ID coverage, agreement cases, and cases containing false positives or
false negatives. `falseNegativeProbeIds` is the declared probe set;
`observedFalseNegativeCaseIds` is the subset where the current scanner missed a
labelled policy. Grade histograms count `NOT_GRADED` for rejected or
indeterminate results, because an indeterminate result has no risk assessment.
Status histograms distinguish `COMPLETE`, `DEGRADED`, `INDETERMINATE`, and
`REJECTED`.

Runtime includes sample count, total, minimum, p50, p95, and maximum duration
in milliseconds plus a named device profile. Runtime is measured for every
case, including rejected inputs. A controlled clock makes the complete report
byte-stable for repeated tests.

## Evidence boundaries

This is calibration evidence for deterministic policy identity and bounded
scanner behavior, not a prevalence estimate, exploit demonstration, legal
approval, or independent security review. The labels were authored and
reviewed by `synthetic-calibration-reviewer` on 2026-08-31; no second reviewer
was available for this slice. Critical/high labels therefore remain explicitly
subject to independent adjudication before any production decision.

**Honest caveat: this is a synthetic corpus, and a much larger real one already exists
elsewhere.** All 27 cases were hand-authored specifically to exercise policy identities and
bounded behavior, not sampled from real-world usage. Separately, the project's own data pipeline
has scanned and graded 13,221 real, public n8n workflows (the corpus documented in
`docs/audit/2026-09-04/04-DATA-CORPUS-EXPORTS.md`). Those two facts do not currently meet: no
stratified sample of that real corpus has been promoted into this calibration set, so every
precision/recall figure this document's runner produces is a synthetic-only claim. A reviewer
should not read "27/27 cases pass" as evidence about the false-positive rate on real workflows —
it is evidence that the scanner behaves as its authors intended on cases they wrote to test that
intent. Promoting a stratified real sample into calibration (tracked as audit finding B-08) would
produce a materially stronger public claim than synthetic-only evidence ever can, at the cost of
coupling calibration to corpus regeneration. This document itself was, for a period, calibration
evidence that existed in the repository but was not linked from any published index (audit
finding B-06); it is now indexed from [`README.md`](README.md).

The runner does not alter scoring weights, thresholds, policy effects, or
scanner output. In particular, `REPORT_ONLY` observations remain outside the
risk grade. Any future effect/weight/threshold change still requires the
separate scoring ADR, old-versus-new differential, grade-boundary inspection,
determinism/redaction proof, version update, and independent review described
by the Phase 2 plan.

Focused verification:

```text
npx vitest run pipeline/calibration/calibration-runner.test.ts
npm run check:scanner-calibration
```
