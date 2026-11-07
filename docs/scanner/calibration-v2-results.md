# Scanner v2 calibration results

> Status: `HUMAN_REQUIRED` / `INSUFFICIENT_EVIDENCE`  
> Corpus: `n8n-template-api-2026-08-07` (30 captured records)  
> Source of truth: [`data/scanner/calibration-v2-manifest.json`](../../data/scanner/calibration-v2-manifest.json)  
> Machine-readable result: [`calibration-v2-results.json`](calibration-v2-results.json)

## What this artifact says

The captured 30-record template corpus is an evidence-only resource and regression
corpus. Every manifest record remains marked `HUMAN_REQUIRED`; it has no settled
independent reviewer decision. The corpus therefore has **zero settled cases and
30 unresolved cases**. This document does not invent positive, negative,
near-miss, or unsupported labels, and it does not claim scanner findings for any
record.

Independent adjudication requires at least two distinct reviewers per case. Each
reviewer decision records a label, rationale, review date, and the case's source,
commit, path, licence, permission, and digest. Agreement can be settled; a
conflict remains `DISPUTED` until an explicit independent resolution is recorded;
`HUMAN_REQUIRED` and insufficient evidence never become truth by default.

## Metrics availability

Per-rule precision, recall, confusion counts, abstention/degradation counts,
false-negative taxonomy, and Wilson 95% confidence intervals are **unavailable**
for this corpus. Scoring excludes unresolved decisions, so no metric can report a
reassuring 100% from absent evidence. The result JSON intentionally contains an
empty `ruleMetrics` object and marks metrics `INSUFFICIENT_EVIDENCE`.

Latency, memory, RSS, and serialized-result measurements are also `NOT_RUN` for
this unadjudicated corpus. The metrics implementation accepts caller-provided
finite measurements and never consults a clock, random source, locale, network,
or external model.

## External gates

This local artifact does not satisfy independent human adjudication, licence or
permission clearance, legal review, owner approval, CI/platform validation,
deployment, release, signing, or publication gates. A later run may replace the
unavailable result only after those inputs are supplied and the generated JSON is
reproduced from the same provenance-safe corpus.

Focused implementation verification is recorded in
`.superpowers/sdd/task-1002-report.md`.
