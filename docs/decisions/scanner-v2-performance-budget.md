# ADR: Scanner v2 performance budget evidence

## Status

Accepted for WC-1005 execution on `codex/scanner-world-class`. This ADR governs the
measurement and CI interpretation of the v2 performance budget; it does not change
scanner semantics or production behavior.

## Context

The first WC-1005 live comparison used five samples per fixture. On the same machine,
`max-bound-exceeded-workflow:beta-default@2.0.0` exceeded its approved 110% p95 budget by
`0.280454 ms` (`631.3085 ms` observed versus `631.0280460000001 ms` allowed). A later
20-sample matching-environment rerun also failed closed on genuine scheduling jitter:
`duplicate-workflow:beta-default@2.0.0` measured `11.47476 ms` against an allowed
`11.360173000000001 ms`, an overrun of `0.114587 ms`. Both are preserved as historical
same-machine failures; neither is a reason to waive the strict ratchet.

The authorized 100-sample rerun also recorded two same-machine strict-ratchet failures:
`indeterminate-workflow:beta-default@2.0.0` exceeded its approved p95 budget by
`0.4321305 ms`, and the final `ambiguous-workflow:beta-default@2.0.0` comparison exceeded
its approved p95 budget by `0.6559825 ms`. These remain historical evidence of single-run
jitter, not waivers or tolerances.

## Decision

- Approved evidence is same-machine repeatability evidence only. Each batch uses one warmup and
  one hundred measured samples per fixture; the default policy runs three independent batches.
  The reported latency p95 is the deterministic median of the three batch p95 values, while
  reported maxima are maxima observed across every batch. This `median-batch-p95` aggregation
  is an explicit stability policy, not an absolute tolerance, retry loop, waiver, or bypass.
- A current report may apply the p95 ratchet only when its environment digest matches the
  approved baseline. For an approved baseline p95 below `25ms` (the micro-latency class), the
  explicit budget is `max(baselineP95 * 1.10, baselineP95 + 5.0ms)`. The resulting current
  p95 must also stay at or below the hard `25ms` micro-latency ceiling. This bounded floor
  addresses the observed scheduler/GC jitter without making a slow micro fixture pass
  without a bound. A baseline p95 at or above `25ms` is not micro-latency and keeps exactly
  the proportional budget `baselineP95 * 1.10`.
- Matching-machine runs enforce the resulting micro-floor or proportional budget strictly,
  including when the cross-machine ADR arguments are supplied. The micro floor is an
  explicit budget formula, not a retry, hidden tolerance, environment waiver, or baseline
  rewrite.
- Every max-bound fixture must stay at or below the 5,000 ms maximum observed latency. Valid
  max-bound report metrics require `outcome: 'SUCCESS'` and `failureCode: null`; its analysis
  `status`/grade may be `INDETERMINATE`, with no separate `closed` field.
- Every run enforces these hard byte ceilings, regardless of environment or policy:
  `maxSerializedResultBytes <= 5,000,000`, `maxEvidenceBytes <= 1,536,000`, and
  `maxRedactedArtifactBytes <= 1,536,000`.
- RSS is recorded as process-wide observational evidence from
  `process.memoryUsage().rss`. There is no scanner-only RSS ceiling and the report makes
  no scanner-only memory claim.
- Cross-machine CI is not comparable for p95. It runs through the explicitly named
  `check:scanner-v2-budget:cross-machine` invocation, and the gate sequence selects that
  invocation by itself whenever `CI === 'true'` (`selectScannerV2BudgetGate` in
  `scripts/run-gates.mjs`). That auto-selection is **intended behavior, sanctioned
  2026-09-24**, not an accident of the selector. Under this policy the comparator reports
  the p95 dimension as not comparable rather than silently comparing it; byte ceilings and
  max-bound deadlines remain enforced and cannot be waived. An invocation without the named
  policy fails closed on an environment digest mismatch.
- This evidence makes no production, browser, deployment, or cross-machine performance
  claim.

## Accepted scanner-core change: taint published as a frozen value

Recorded 2026-09-24, owner-sanctioned, alongside the 5.1 packet 2 exception-isolation work.

The taint-to-AI closure the core-registry contract named as mutable was removed. Core now
publishes taint as a frozen value instead of handing `analyzeAiCapabilities` a live reference,
so a later mutation cannot retroactively change AI findings. The measured cost of the
publication copy on a 5,000-node fixture with 9,998 updates is **+13% best-of-7** and
**+18% median** on `analyzeWorkflowTaint`.

**This is not a budget waiver and it does not revise any ratchet.** Two facts keep it outside
the ratchet's scope, and a reviewer should confirm both rather than read this section as a
tolerance:

- The taint path runs only on hardened profiles. The shipped default profile never executes
  it, and every budget fixture named above is a `beta-default` fixture, so the measured delta
  has no ratchet dimension to exceed.
- The 5,000-node fixture is a scale probe, not one of the budget fixtures. Nothing in this
  section changes an approved baseline, the micro-latency floor, the proportional budget, the
  hard byte ceilings, or the max-bound deadlines. The strict same-machine comparator still
  governs unchanged, and a fresh failure is still `OWNER_REVIEW_REQUIRED`.

A fully immutable taint view - deep-frozen states including their inner sets - was measured at
**10-20x** the taint propagation cost and rejected on measurement. A future reader should not
"restore" it as an obvious improvement: the frozen publication copy plus proved non-aliasing is
the sanctioned form.

## Approved re-baseline: boundary counter validation and span accounting (2026-09-25)

Owner-authorized, recorded under the ruling of the same date. This is the one thing the ADR permits
with owner approval: a re-baseline backed by a named cause.

**Cause.** Commit `4e28d91` made the result boundary refuse capability counters that contradict each
other in both directions, and the 5.1 packets before it (`3bb8152`, `2f44a13`, `2ceee56`) made span
accounting and the completeness lattice compute per capability instead of hardcoding. Both are
correctness work that a shipped scan now pays for on every run. The 0.36 ms overrun that stopped the
previous pass on `risky-workflow:beta-default@2.0.0` is ruled that cost rather than jitter.

**Measurement.** `node --import tsx scripts/measure-scanner-v2.mjs --write`, unchanged three-batch,
one-warmup, one-hundred-sample policy. The environment digest is **identical** to the baseline it
replaces, so the two are comparable and no cross-machine argument applies.

**What the re-measurement showed, in both directions.**

| Fixture | Previous p95 | New p95 | Delta |
| --- | --- | --- | --- |
| `ambiguous-workflow` | 13.25150 | 17.47645 | +4.22 |
| `duplicate-workflow` | 10.27488 | 15.44888 | +5.17 |
| `indeterminate-workflow` | 12.00931 | 13.77088 | +1.76 |
| `malformed-workflow` | 3.78232 | 4.45105 | +0.67 |
| `risky-workflow` | 12.08815 | 16.19488 | +4.11 |
| `safe-workflow` | 9.09592 | 10.17409 | +1.08 |
| `unicode-bom-workflow` | 11.66470 | 11.40401 | -0.26 |
| `max-bound-exceeded-workflow` | 604.17827 | 358.80603 | -245.37 |
| `max-bound-workflow` | 822.95443 | 688.72659 | -134.23 |
| `oversized-workflow` | 924.41329 | 856.46985 | -67.94 |

Every sub-25 ms fixture except `unicode-bom` rose, which is the sanctioned cause showing up as
measurement. The three fixtures at or above 25 ms **fell**, by 7% to 41%; those runs are dominated by
bound-exceeded and oversized paths that the same 5.1 work lets exit earlier, but this section attributes
only the micro rise, which the ruling names. The falls are recorded as measured, not explained.

**A reader must know the consequence for the larger fixtures.** They are in the proportional class, so a
lower baseline is a **tighter** future budget, not a looser one: `max-bound-exceeded-workflow`'s budget
drops from 664.6 ms to 394.7 ms. This re-baseline is therefore not a blanket relaxation. If a future pass
fails on one of those three, the comparison is against the tighter number, and the honest question is
whether that fixture's p95 has genuinely become that fast on a quiet host — not whether the ratchet should
move again.

**Outcome of the first pass after the re-baseline (recorded 2026-09-25).** `risky-workflow`, the fixture the
re-baseline exists for, **passed**. The sequence then stopped at the same gate on a different fixture:
`max-bound-exceeded-workflow:beta-default@2.0.0` measured p95 **408.768875 ms** against the re-baselined
proportional budget **394.686633 ms** (3.6% over), where that budget is `358.80603 * 1.10` from the table
above. The warning in the preceding paragraph is therefore not hypothetical - it happened on the first
attempt, on the fixture whose baseline fell furthest.

Three same-machine measurements of this fixture now exist: `604.17827` (the replaced baseline), `358.80603`
(the re-baseline run), `408.768875` (this pass). A spread that wide on one host means a single-run baseline
is not a usable ratchet for it: this fixture's p95 is dominated by the bound-exceeded path rather than by
steady per-scan work, so it moves with scheduling and with how quickly the work budget trips.

**This is left exactly as measured and is not resolved here.** Retrying until it passes, bypassing the
check, or re-baselining again are all prohibited without a new owner ruling, and the re-baseline that moved
this fixture's budget from 664.6 ms to 394.7 ms was authorised for a named cause that does not extend to
this fixture - its lower number was recorded as measured, not explained. The honest options are to establish
this fixture's distribution across repeated runs and set a budget from that evidence, or to stop comparing
its p95 and rely on the deadline and byte ceilings that are already non-waivable; both change what the
ratchet asserts and are the owner's to choose. A reader must not treat the table above as a settled
improvement for the three non-micro fixtures.

**What is unchanged.** The micro-latency floor formula `max(baselineP95 * 1.10, baselineP95 + 5.0 ms)`, the
proportional budget for baselines at or above 25 ms, the hard 25 ms micro ceiling, the byte ceilings
(`maxSerializedResultBytes <= 5,000,000`, `maxEvidenceBytes <= 1,536,000`,
`maxRedactedArtifactBytes <= 1,536,000`), the max-bound deadlines, the strict same-machine comparator, and
the prohibition on retry or bypass. The four historical same-machine failures recorded in the Context
above remain recorded as failures; this re-baseline does not convert any of them into a pass.

**Scope of the authorisation.** It covers the measured cost of the named correctness work and nothing
else. A future overrun on any fixture that has no comparable named cause is a regression, and the result is
`OWNER_REVIEW_REQUIRED` again.

## Owner amendment: Windows p95 tolerance (2026-09-25)

**Ruling.** The owner directed: “Freeze the current measured performance with a 20% tolerance on Windows. Record the host environment in the performance ADR; do not block on dedicated cloud Linux hardware.” This dated amendment supersedes the earlier 110% proportional ratchet and the prior statements that the p95 budget has no tolerance. Those statements, including later restatements of the 110% formula in this ADR, remain as records of the policy in force before this amendment; this amendment is now the operative rule. The approved baseline is not rewritten.

**Host binding.** The approved comparison host is Windows 11 Pro, version `10.0.22631`, OS build `22631` (x64), with an AMD Ryzen 7 4800H with Radeon Graphics CPU and `15.42 GiB` OS-visible physical memory. Same-host p95 comparison still requires the approved baseline's matching environment digest and measurement policy. This is a Windows baseline decision; dedicated cloud Linux hardware is not a release prerequisite, and p95 from another environment remains non-comparable under the existing named cross-machine policy.

**Tolerance and regression.** On the recorded host, the proportional p95 budget is now `baselineP95 * 1.20` (a 20% tolerance); for micro-latency baselines the existing `max(baselineP95 * 1.20, baselineP95 + 5.0 ms)` formula still applies, with its hard `25 ms` current-p95 ceiling unchanged. For the recorded `max-bound-exceeded-workflow` baseline of `358.80603 ms`, the budget is `430.567236 ms`; the previously recorded `408.768875 ms` result is within this amended tolerance. It remains documented as a failure under the prior 110% rule and is not erased or used to rewrite the baseline.

Any same-host p95 above the applicable 120%/micro-floor budget, any current micro p95 above `25 ms`, or any violation of the hard byte ceilings or `5,000 ms` max-bound deadline remains a regression. The hard byte ceilings (`maxSerializedResultBytes <= 5,000,000`, `maxEvidenceBytes <= 1,536,000`, and `maxRedactedArtifactBytes <= 1,536,000`) and max-bound work deadline are unchanged and non-waivable. No retry, bypass, or baseline rewrite is authorized by this tolerance; an over-budget result without a new owner ruling remains `OWNER_REVIEW_REQUIRED`.

## Owner amendment: pre-registered repeated-run p95 adjudication (2026-09-26)

**Ruling.** The owner selected the repeated-run p95 rule for the current 2.5/10.3 gate. It
prospectively adjudicates the two already-failing max-bound p95 endpoints; it does not erase
their single-run failures, change the 20% threshold, rewrite the baseline, modify the ordinary
one-report comparator, waive hard limits, or authorize retry-until-green. A study PASS resolves
only the current 2.5/10.3 p95 evidence. FAIL or INCONCLUSIVE leaves 10.3 and 8.1 blocked.
Future normal invocations remain the one-report comparator unless separately authorized.

This pre-registered seven-to-ten-launch study is the isolated acceptance sample set requested
by the existing 2.5 row and supersedes its earlier standalone two-sample wording; no additional
post-study reruns are authorized or required.

**Co-primary endpoints.** Both endpoints are primary; neither is normalized against the other:

| Case | Fixed baseline p95 | 1.20 budget | Fixture input SHA-256 |
| --- | ---: | ---: | --- |
| `max-bound-exceeded-workflow:beta-default@2.0.0` | 358.80603 ms | 430.567236 ms | `b29d2e46dd49b107f119c0088799b15394529d36e05114e49a71cdbff4f660f5` |
| `max-bound-workflow:beta-default@2.0.0` | 688.726585 ms | 826.471902 ms | `2a4f7269027bc534617dd64717c466311bf268a4d98bb724f737e7121c0bafbf` |

The second is a same-class companion and diagnostic control, and is co-primary because its
failed run exceeded its own budget. Never subtract, normalize, or otherwise adjust the target
by the control.

**Independent observations.** For each independent fresh-process launch and each case, use the
existing case p95: the median of that launch's three batch p95s under the `median-batch-p95`
policy. Divide by that case's fixed approved baseline p95 and take the natural logarithm to
obtain one log ratio. The independent unit is the process launch: the 100 per-call times and
three batch p95s are retained evidence, not 100 × 3 independent observations.

**Interval assumptions.** The interval procedures assume independent/exchangeable process
launches drawn from a stable distribution under the frozen host state. Separate processes and
five-minute cooldowns do not prove stationarity. Record launch order, timestamps, and each
preflight state; any detected drift aborts INCONCLUSIVE. Do not attribute unexplained variance
to a cause.

**Two-look alpha-spending decisions.** Statistical looks occur only after launches `n=7` and
`n=10`; do not make an interim statistical look at `n=8` or `n=9`. For each endpoint, sort the
log ratios as `y_(1)…y_(n)` and let the threshold be `c = ln(1.20)`. At each look, define the
exact one-sided upper bound using the largest `k_U >= 1` for which
`sum(j=0..k_U-1, C(n,j)) / 2^n <= 0.025`, with `U_n = y_(n-k_U+1)`. Define the lower bound
using the largest `k_L >= 1` for which the same tail sum is `<= 0.0125`, with
`L_n = y_(k_L)`. These are bounds in log-ratio units. At `n=7`, both `k_U` and `k_L` are 1
(maximum/minimum); at `n=10`, both are 2 (second-largest/second-smallest). PASS iff both
endpoints have `U_n <= c`; FAIL iff either endpoint has `L_n > c`, with FAIL precedence.
The alpha allocations across two looks bound the PASS false-label probability by 0.05 for
any bad endpoint (intersection-union: PASS requires both endpoints). FAIL false-label
probability is at most 0.05 by Bonferroni over two endpoints and two looks.

**Precision intervals.** At each statistical look, use two-sided exact order-statistic
intervals with total alpha `0.0125` per endpoint per look: choose the largest `k >= 1` for
which `2 * sum(j=0..k-1, C(n,j)) / 2^n <= 0.0125`; the log-scale interval is
`[a,b] = [y_(k), y_(n-k+1)]`. Bonferroni over two endpoints and two looks gives simultaneous
coverage of at least 95% for this interval family. At `n=7`, no finite interval exists
(`2/128 = 0.015625 > 0.0125`). If neither one-sided decision is reached at `n=7`, precision
is unmet and launches 8–10 run as one fixed block, with no interim statistical look. At
`n=10`, `k=1` (sample range; `k=2` has tail `22/1024 = 0.02148 > 0.0125`); use the
sequentially valid two-look interval `[a,b]` to report the multiplicative relative half-width
`h = exp((b-a)/2)-1`, with precision target `h <= 0.05`. Any remaining threshold overlap at
`n=10` is INCONCLUSIVE whether `h <= 0.05` or not; `h` describes precision and never waives
the pass boundary. These are simultaneous two-look intervals, not fixed-n 97.5% intervals at
an adaptively selected `n`.

At `n=7`, stop on PASS or FAIL; if neither decision is reached, run the full fixed 8–10 block.
At `n=10`, stop on PASS or FAIL as defined above; otherwise stop INCONCLUSIVE. Do not exclude
or replace samples for outliers, GC, load, or outcome. A non-waivable byte, deadline, or
outcome-contract failure in a valid report is FAIL. Because `--record` writes only after every
fixture completes, if no JSON record exists but stderr/exit explicitly identifies a hard-bound
enforcement failure, classify FAIL; a generic process/report failure is INCONCLUSIVE. Any
provenance or metadata failure is also INCONCLUSIVE; retain all completed reports.

**Hard limits and per-launch policy.** Every launch retains one warmup, 100 measured calls per
batch, three batches, and the existing `median-batch-p95` policy. Max-bound latency remains
at most 5,000 ms; `maxSerializedResultBytes <= 5,000,000`,
`maxEvidenceBytes <= 1,536,000`, and `maxRedactedArtifactBytes <= 1,536,000` remain
non-waivable. Valid max-bound report metrics require `outcome: 'SUCCESS'` and
`failureCode: null`; `status`/grade may be `INDETERMINATE`, with no separate `closed` field.

**Frozen runner and identity.** The candidate before this documentation amendment is commit
`e4d7ff1972d3926b86b8c466268fb49e045bd0f5`; its tracked tree was clean before the amendment.
The frozen runner is Node `v22.17.0`, `win32/x64`, AMD Ryzen 7 4800H with Radeon Graphics,
16 logical CPUs, ADR-approved Windows 11 Pro build `22631`, and `15.42 GiB` visible RAM.
The baseline environment digest `631dfdb1a52971e815052de7008460ba4b56082b076ee6f51701779de321cb59`
must match every report. Freeze these SHA-256 identities in the study snapshot:

| Input | SHA-256 |
| --- | --- |
| `docs/scanner/baseline-v2.json` | `a4a36d1fb2ddbd5a4b26ab0ea07af9c51173719ec043789efd591ebdca08674b` |
| `scripts/measure-scanner-v2.mjs` | `d4ef1f04b0dcc8be4baa9a02d638247f36a030759900e78ebecf21e3649b7c31` |
| `scripts/compare-scanner-v2-budget.mjs` | `8f423b468c24354b203c7bc4251de198b91f8dcbdf6ab9404b808fb7fddf9e55` |
| `packages/scanner-core/src/__fixtures__/v2-adapter-fixtures.ts` | `76922335dd1e923127fd6cef5ee4bf1638e44edb8db3c8e859bdb51f95c34eaa` |
| `package.json` | `c405c0661aaa54f0ece83eb10072a6d107f208d63198468cb028c5cab0291a56` |
| `package-lock.json` | `e31896b5a6e298102262814b425112cdf5f6ed86f58a1a954ac2c8cd8709feac` |

All study reports must agree with one another on environment, tool/script/fixture digests,
and measurement policy. Do not require the current sampler SHA to equal the older pinned
baseline tool SHA; do not rewrite the baseline. No source changes are permitted during the
study.

**Launch and host protocol.** Before launch 1, create/check a unique study directory under
gitignored `pipeline/.work` and save this protocol snapshot and all identity hashes there.
Record the power plan and power source first. The plan is Balanced
(`381b4222-f694-41f0-9685-ff5bb260df2e`); power-source evidence is
`System.Windows.Forms.SystemInformation.PowerStatus.PowerLineStatus = Online` and
`Get-CimInstance -Namespace root/wmi -ClassName BatteryStatus` reporting
`PowerOnline=True, Discharging=False, Charging=False`. Do not change the plan or power source;
require the plan GUID and all these observable source states to remain unchanged throughout.
Each launch is a fresh sequential Node process using
`node --import tsx scripts/measure-scanner-v2.mjs --samples 100 --warmups 1 --batches 3 --record <unique-path-under-pipeline/.work>`.
Use a distinct report-record path and stdout file for every launch. `--write` is forbidden.
Before launch 1 and between every later launch, require a fixed five-minute idle cooldown,
then collect a separate 60-second, 1-Hz Windows `\Processor(_Total)\% Processor Time`
preflight. The recorded `Get-UICulture` is `en-US`, so use this English counter path. Record
all sample timestamps and the total sample span; fail closed unless exactly 60 finite samples
and their timestamps/span are present. Require mean CPU use `<= 10%` and no sample `> 20%`,
with no repository build, test, or benchmark process.
Do not wait or retry until quiet: a failed preflight before launch 1 means NO STUDY; after
any launch it stops the study INCONCLUSIVE, retaining all
reports with no replacements. Capture only pre/post host diagnostics; do not poll during
timed scans. No launch may be omitted or replaced.

**Start, stop, and abort.** Start only after the study directory, protocol snapshot, identities,
and host state are recorded, the five-minute idle cooldown completes, and the first preflight
passes. Stop at the first prescribed PASS or FAIL, after the `n=10` decision, or when an
abort condition requires INCONCLUSIVE; do not run beyond a terminal outcome. Continue the
full fixed 8–10 block when prescribed unless a specified FAIL or abort stops the study. Any
power-source change or later preflight failure aborts as INCONCLUSIVE. A provenance,
metadata, or process failure likewise aborts INCONCLUSIVE with all completed reports retained
and no replacement launches.


**Instrumentation and frozen prior failure.** The runner has no dedicated GC/event-loop
instrumentation; it is unavailable for this study. Retain per-call and per-batch distributions
and out-of-band CPU/power diagnostics, but add no instrumentation and infer no cause. Keep the
sampler's `performance.now()` region unchanged.

The original full stdout file for the failed run was not retained. The exact available
two-row excerpt, also preserved by candidate commit `e4d7ff1`, is:

| Case | p95 | Budget | Overrun |
| --- | ---: | ---: | ---: |
| `max-bound-exceeded-workflow:beta-default@2.0.0` | 474.46662 ms | 430.567236 ms | +10.2% |
| `max-bound-workflow:beta-default@2.0.0` | 856.11656 ms | 826.471902 ms | +3.6% |

These remain failed single-run results; the absent full stdout is not reconstructed, and that
gate is not fabricated or rerun by this amendment.

## Study outcome: INCONCLUSIVE (2026-09-26)

**Outcome.** INCONCLUSIVE; no gate closure. Only launch 1 of the requested initial seven-launch set
completed; there was no `n=7` look, launch 2, replacement, or statistical decision. Launch 1 ended
at `2026-09-26T03:39:17.0648152Z`, but the required immediate post-run power/identity snapshot was
not captured until `2026-09-26T04:34:52.8676105Z`, a delay of `3335.8027953` seconds
(`55m35.8s`). This missed capture cadence triggered the preregistered abort. Gemini incident
re-review approved the INCONCLUSIVE outcome: later matching host state does not repair the missed
capture, and launch-1 p95s cannot pass the gate. This protocol authorizes no replacement run. 10.3
and 8.1 remain blocked pending a new owner ruling.

**Launch-1 diagnostics only.** The `max-bound-exceeded` p95 was `359.565945 ms` against
`358.80603 ms` baseline (`1.002117899x`); the `max-bound` p95 was `662.90271 ms` against
`688.726585 ms` baseline (`0.962504896x`). These one-launch ratios are descriptive only, not
PASS/FAIL gate results, and do not establish a performance regression. All 10 case records
completed with `measurementPass=true` and `ceilingsPass=true`; maximum observed latency was
`1030.3256 ms` (below `5,000 ms`) and byte limits passed. The valid max-bound record has
`outcome=SUCCESS`, `status=INDETERMINATE`, and `failureCode=null`.

**Provenance and retained artifacts.** Protocol commit/head was
`62ad5b99fb4774a0e3c8f65bf6c8d938e98a66be` with a clean tracked tree; code candidate
`e4d7ff1972d3926b86b8c466268fb49e045bd0f5` is its ancestor. Frozen hashes and the approved
environment digest matched. The valid prelaunch CPU preflight recorded 60 finite timestamped
samples across `59.424s` (mean `1.4934%`, maximum `4.0488%`); power and identity matched. An
initial PowerShell metadata setup error occurred before any CPU counter invocation and was
followed by this successful preflight. The study artifacts are in the gitignored, workstation-local
directory `pipeline/.work/scanner-v2-luna6-20260926-c96fd924960e43c3b233dc5c8c22fa7f/`:

| Artifact | SHA-256 |
| --- | --- |
| `launch-01.report.json` (132,426 bytes; exit 0) | `206b9fa00eafd662a786405b9d32d0ff9d7270669beb3edf7a0b0500fb688eb3` |
| `protocol-deviation.json` | `f3eaf41786a2a6903e037cd40789aa3e9415a9f4260d95768871e38d0551f126` |
| `preflight-before-launch-01.json` | `858188dfaa091cb9042bdda791c8e95483f6342f8582745bbdc7185f85080184` |
| `launch-01-execution.json` | `6db3b1351733b2202b137392c9b7cbede5246b9f16887f408fe0637f6bbb71e8` |

The full stdout for launch 1 is unavailable; it was not reconstructed, and no rerun was made.

## Owner update: per-fixture p95 budget baseline (2026-09-26)

**Ruling.** Set the Windows p95 budget baseline for
`max-bound-exceeded-workflow:beta-default@2.0.0` to **475 ms**. The existing 20% tolerance
therefore sets its proportional comparison limit to **570 ms**. This supersedes the earlier
no-rebaseline rule for this endpoint only; the companion endpoint remains at its recorded
688.726585 ms baseline and 826.471902 ms limit.

**Measurement integrity.** The 475 ms value is an owner-selected budget input, not a measured
p95. Keep the baseline report's measured summary unchanged (`latencyMs.p95 = 358.80603 ms`,
`latencyMs.max = 448.94689999999537 ms`) and encode the policy separately as
`budgetBaselineP95Ms: 475`. The comparator uses that override for p95 arithmetic only. It is
carried forward by `--write` only when both the Windows environment digest and fixture input
hash still match; a changed identity requires a new owner decision.

The two-look study remains **INCONCLUSIVE**: the delayed host-state capture, one-launch sample
count and absence of an `n=7` look are unchanged. Comparing its retained report under this
new baseline is an ordinary comparator result, not a statistical PASS for the aborted study.
The 5,000 ms max-bound deadline and all byte ceilings remain non-waivable.

## F-018 investigation record: `oversized-workflow` p95 on the recorded host (2026-09-27)

**What failed.** The release sequence stopped at `check:scanner-v2-budget:cross-machine` on

```
- oversized-workflow:beta-default@2.0.0 latency p95 1046.71ms exceeds proportional 120% budget 1027.76382ms
```

a `+18.94618 ms` overrun of `1.2 * 856.46985 ms`, the budget this ADR sets for a measured
baseline p95 at or above the 25 ms micro class.

**Reproduction, 2026-09-27.** `npm run check:scanner-v2-budget:cross-machine` on this host, from
the same commit, reproduced the gate and reported one more case over budget:

```
Scanner v2 performance budget failed
- max-bound-workflow:beta-default@2.0.0 latency p95 846.56589ms exceeds proportional 120% budget 826.471902ms
- oversized-workflow:beta-default@2.0.0 latency p95 1108.298735ms exceeds proportional 120% budget 1027.76382ms
```

`max-bound-workflow` is the co-primary control of the 2026-09-26 study above; its `846.56589 ms`
is `+20.093988 ms` over its own budget and the fourth same-host observation of that case
(`688.726585 ms` baseline, `662.90271 ms` and `856.11656 ms` from the study, and now
`846.56589 ms`).

**Post-change re-run, 2026-09-27.** After the guard-order pin below landed,
`npm run check:scanner-v2-budget:cross-machine` reported

```
Scanner v2 performance budget failed
- oversized-workflow:beta-default@2.0.0 latency p95 1060.77046ms exceeds proportional 120% budget 1027.76382ms
```

`+32.99 ms` over the budget, with `max-bound-workflow` back under its own. The change under test
is a test-only pin plus this record, so the re-run is a further sample of the same distribution
rather than a fix; it is reported here with the rest instead of being presented as one.

**The hypothesis that was tested, and why it does not hold.** Commit `56e369a` added a
node-count guard to `app/src/scanner/scan.worker.ts` that `JSON.parse`s the document before
deciding. The prime hypothesis for this failure was that the guard makes an over-`MAX_BYTES`
document — this fixture's shape — pay a parse the engine never reaches, since
`parseSourceDocumentWithLimits` (`packages/scanner-core/src/source/source-parser.ts:30`) refuses
over-budget bytes from an O(1) length check before it parses anything. Two facts in the tree
rule the worker out as a contributor to this number:

- **The gate never runs the worker.** The measured region is
  `scripts/measure-scanner-v2.mjs:147`, which calls `scanFixture` (`:111-114`): one
  `encoder.encode(fixture.json)` plus a direct `scanWorkflowV2({ bytes, profile, limits })` call
  into `packages/scanner-core/src/v2/index.ts`. No file in the gate's import graph imports
  `app/src/scanner/scan.worker.ts`, and the fixture's input hash is still the pinned baseline's
  `0b4f1eb3be6325ec918e26683bf81a848e51f199ffb755c02ac650dbf4bed43c`, so the timed work is the
  same work the baseline timed.
- **The guard is already ordered that way.** `nodeLimitRejection`
  (`app/src/scanner/scan.worker.ts:169-184`) returns on `bytes.length > MAX_BYTES` as its first
  statement, ahead of the file's only `JSON.parse` at `:173`; the shape guards (`nodes` an array,
  `connections` an object) follow the parse and the count check is last. For an over-`MAX_BYTES`
  document the guard's only cost is the byte length the request needs anyway to hand the engine
  its `bytes`.

**What the fixture's cost is instead.** The timed region is dominated by the engine's own request
boundary validation over a 1,536,011-byte `Uint8Array` (`bytesCopy` in
`packages/scanner-core/src/v2/scan-workflow.ts`), which every scan enters before any document
work. The fixture is one 1.5 MB `data` string, so `WORKFLOW_TOO_LARGE` is decided at the size
check in that same path and no parse of the payload happens on either side.

**Same-host movement, which is larger than the overrun.** Every number below is the same case,
the same fixture input hash, and the approved host digest `631dfdb1a52971e815052de7008460ba4b56082b076ee6f51701779de321cb59`:

| Observation | p95 | Where it is recorded |
| --- | ---: | --- |
| superseded baseline (re-baselined 2026-09-25) | 924.41329 ms | the re-baseline table above |
| approved baseline in force | 856.46985 ms | `docs/scanner/baseline-v2.json` |
| sequence failure, 2026-09-27 | 1046.71 ms | the gate output at the top of this section |
| reproduction, 2026-09-27 | 1108.298735 ms | the reproduction output above |
| post-change re-run, 2026-09-27 | 1060.77046 ms | the post-change re-run above |

The overrun is `18.94618 ms`; the movement between the two recorded same-host baselines alone is
`67.94 ms`, and every `2026-09-27` observation of this case is above the budget those baselines
set, so on this host state the strict comparison cannot pass whatever the code under test does.
On this fixture the p95 is set by one allocation-heavy boundary copy rather than by steady
per-scan work, so a single strict comparison of it is not a usable regression signal at a 20%
tolerance.

**Repeated same-policy launches on this host (2026-09-27).** The gate's own policy — one warmup,
three batches of one hundred timed calls, `median-batch-p95` — was replayed for this fixture alone
in three fresh processes, with the frozen fixture hash and the digest above. Each launch's three
batch p95s and its case p95:

| Launch | batch p95s (ms) | case p95 (ms) | against `1.2 * 856.46985 = 1027.76382` |
| --- | --- | ---: | ---: |
| 1 | 1067.54502 / 1089.95930 / 1090.717525 | 1089.95930 | `+62.19548` |
| 2 | 895.24663 / 1036.310145 / 1627.787225 | 1036.310145 | `+8.546325` |
| 3 | 919.186665 / 1073.685945 / 1096.305555 | 1073.685945 | `+45.922125` |

All three exceeded the budget, by `0.8%` to `6.1%`, and one batch inside launch 2 reached
`1627.787225 ms`. A single launch's own three batch p95s move by up to `732.540595 ms` (launch 2),
which is larger than the overrun that stopped the sequence (`18.94618 ms`). Two further same-host
observations of this case are retained locally under `.superpowers/sdd/task-2.5-runs/`
(`smoke-record-5x1.json` `1008.70346 ms` and `smoke-record-5x1-postfix.json` `899.71676 ms`, both
recorded under a five-sample one-batch policy, the same digest and the same fixture hash), so they
describe the fixture's movement rather than the gate policy.

**Per-call attribution of the fixture's cost (2026-09-27).** Measured in one process on this host:
`encoder.encode` of the fixture JSON costs `0.42 ms` p50; a `JSON.parse` of the same string costs
`1.369 ms` p50 and `4.377 ms` p95; one `Object.getOwnPropertyNames` over the fixture's
1,536,011-byte `Uint8Array` — the first step of `bytesCopy`'s per-index validation at
`packages/scanner-core/src/v2/scan-workflow.ts:64` — costs `689.431 ms` p50; and the engine call
with prebuilt bytes costs `848.671 ms` p50 / `974.457 ms` p95 against `846.029 / 935.212 ms` for
the gate's own `encode`-then-call region. The fixture's measured cost is one allocation-heavy
builtin inside boundary validation that no commit in this range changed; the parse the hypothesis
named would have cost `1.369 ms` p50 at most and is not executed for this shape. No dependency in
the measured path moved either: between the baseline's commit and this one, `package.json` and
`package-lock.json` changed only the `next` and `eslint-config-next` ranges (`~16.3.4` to
`~16.3.6`), which the gate's import graph does not load.

**Why the cross-machine invocation did not report the p95 as non-comparable.** Comparability is
decided by the environment digest alone (`compareScannerV2Budget`), and that digest is built from
node version, platform, arch, CPU model and CPU count — it records no load, thermal or co-tenancy
state. A delegated run on the approved host therefore collides with the baseline digest, the
named cross-machine policy does not engage, and the strict same-machine ratchet applies exactly as
the Decision section above requires. The jitter source that motivates the policy is invisible to
the digest that decides whether the policy applies.

**What this section does not do.** It adds no tolerance, waiver, retry, or baseline rewrite. The
ratchet stays `1.2`, `docs/scanner/baseline-v2.json` is unchanged, and the failed run remains a
failed run: a same-host p95 above the applicable budget without a new owner ruling is
`OWNER_REVIEW_REQUIRED`. The disposition is the owner's, and the honest options are the ones this
ADR already names — establish this fixture's distribution across repeated launches and set a
`budgetBaselineP95Ms` policy input from that evidence, stop comparing this fixture's p95 and rely
on the non-waivable byte ceilings and the 5,000 ms deadline, or reduce the engine's own
boundary-validation cost, which is `packages/scanner-core` work outside this phase.

## Owner amendment: the named cross-machine invocation does not compare p95 (2026-09-27)

**Ruling.** The owner ruled on 2026-09-27 that the explicitly named
`check:scanner-v2-budget:cross-machine` invocation must report the p95 latency dimension as
**not comparable instead of failing the gate on it**, and must say so in its output, whether or
not the environment digest matches the approved baseline. The comparator implements this as the
`p95Comparable` result flag and the policy note on the gate's final line.

**Clause superseded, narrowly.** For the named invocation only, this amendment supersedes the
Decision clause *“Matching-machine runs enforce the resulting micro-floor or proportional budget
strictly, including when the cross-machine ADR arguments are supplied.”* That clause remains in
force for every invocation that does not supply the named ADR path and justification: an
invocation without the named policy still enforces the p95 ratchet on a matching digest and
still fails closed on a digest mismatch.

**Why the clause could not discriminate on this host.** The F-018 record immediately above is
the evidence, and it is cited rather than restated:

- Comparability is decided by the environment digest alone, and that digest records only node
  version, platform, arch, CPU model, and CPU count. It records no load, thermal, or co-tenancy
  state, so a delegated or CI run on the approved host collides with the baseline digest, the
  named policy never engaged, and the strict ratchet was applied to a measurement whose host
  state was not verified.
- The measurement's own noise is larger than the margin it is judged against. On
  `oversized-workflow:beta-default@2.0.0` a single launch's three batch p95s moved by up to
  `732.540595 ms` (launch 2), against an overrun of `18.94618 ms`. Every same-policy observation
  recorded on 2026-09-27 was over budget, spanning `0.8%` to `7.8%`.

**What is unchanged.** The hard byte ceilings (`maxSerializedResultBytes <= 5,000,000`,
`maxEvidenceBytes <= 1,536,000`, `maxRedactedArtifactBytes <= 1,536,000`) and the `5,000 ms`
max-bound deadline stay enforced under the named invocation, exactly as before, and cannot be
waived; the named policy skips only the p95 dimension. The `1.2` ratchet, the micro floor, the
hard `25 ms` micro ceiling, the `budgetBaselineP95Ms` owner input, and every baseline value are
unchanged, and `docs/scanner/baseline-v2.json` is not rewritten. Retry, bypass, and re-baselining
remain prohibited. The failed runs recorded above remain failed runs; this amendment does not
convert any of them into a pass, it records that the named invocation stops re-litigating them.

**Consequence for evidence.** A green cross-machine entry now means the byte ceilings and the
max-bound deadlines held. It is **not** evidence that the p95 ratchet passed, and the gate's own
output states that the p95 dimension was not compared. A latency regression must still be
established by an isolated same-machine pass on a quiet host against the approved baseline -
that is the ordinary `check:scanner-v2-budget` invocation, which keeps the strict ratchet and the
digest-mismatch failure.

## Owner decision: `max-bound-workflow` p95 baseline set from protocol evidence (2026-10-18)

**Ruling.** The owner closed the open `budgetBaselineP95Ms` input for
`max-bound-workflow:beta-default@2.0.0` by setting it to **880 ms**. The measured summary in
`docs/scanner/baseline-v2.json` is left unchanged (`latencyMs.p95 = 688.726585 ms`,
`latencyMs.max = 838.4933000000019 ms`); the policy input is recorded beside it as
`budgetBaselineP95Ms: 880`, the same mechanism the 2026-09-26 update uses for
`max-bound-exceeded-workflow`. For this endpoint the new input supersedes that update's sentence
leaving the companion at its recorded 688.726585 ms baseline and 826.471902 ms limit.

**The two thresholds, stated before the observations.**

- Baseline in force until now: the measured `688.726585 ms`.
- Old comparison limit: `688.726585 * 1.20 = 826.471902 ms` (the proportional 120% budget).
- New comparison limit: `880 * 1.20 = 1,056 ms`.

**Derivation from the two evidence records.**

1. B5's pre-registered protocol on the post-fallback engine (`B5-rerun-report.md`) ran seven fresh
   launches, each with one warmup, three batches of one hundred samples and the `median-batch-p95`
   case rule. The case p95s were `862.823425`, `862.388065`, `858.13715`, `861.66554`, `860.641095`,
   `868.96086`, `864.212275 ms`: mean `862.689773 ms` (`862.690`), spread `10.82371 ms` (`10.824`).
   The highest case p95 is `868.96086 ms`; the per-launch recorded maxima ranged from `871.73 ms`
   to `995.98 ms`. Every launch exceeded the `826.471902 ms` limit, by `+3.83%` to `+5.14%`, and
   every log ratio `1.245977`-`1.261692` exceeded `c = ln(1.20)`.
2. The strict same-machine gate's single probe (`B5-strict-p95-gate.md`) measured `878.28645 ms`
   against the same `826.471902 ms` limit: `+51.8145 ms`, `+6.269%`, ratio `1.275232`. It is
   `+15.60 ms` (`+1.81%`) above B5's mean and `+9.33 ms` (`+1.07%`) above B5's highest case p95, so
   it sits just outside the seven-launch range and inside the per-launch maxima.

**Where 880 ms sits.** It is `+17.31 ms` (`+2.01%`) above the n=7 mean, `+11.04 ms` (`+1.27%`)
above the highest case p95, `+1.71 ms` (`+0.20%`) above the strict probe, and below the largest
per-launch maximum (`995.98 ms`). The margin that matters is against the **multiplied** threshold,
because the comparator compares a current p95 with `1.2 * budgetBaselineP95Ms`: at 880 ms the limit
is `1,056 ms`, which is `177.71 ms` (`20.2%`) above the probe and `60.02 ms` above the worst
per-launch maximum. The 1.71 ms between 880 and 878.286 is not the headroom and must not be read as
one.

**A deliberate decision on protocol evidence, not a budget loosened from one sample.**
`B5-strict-p95-gate.md` records that the n=7 crossing statistic and the single probe are different
measurements, that a single probe can neither reproduce nor refute the study's statistic, and that
the two are not reconciled by hand. The 880 ms input is taken from the repeated-launch distribution
- the sample the owner's option (1) asked for - with the probe as a same-host cross-check, not from
either observation alone. No retry was run to obtain a different number.

**Why the latency moved: the graded population grew.** The generic fallback's own report
(`generic-fallback-report.md`, section 5) records its `rows carrying a grade` measure as **14**
before (LOW 13, MEDIUM 1) and **10,858** after. Its reconciliation is `11,043` `ok` corpus rows =
`10,844` `DEGRADED` + `14` `COMPLETE` + `185` `INDETERMINATE` (the `23` item failures are also
`INDETERMINATE`, giving the `11,066` status total). The `SEMANTIC_CATALOGUE_MISS` population is
unchanged at `11,029` rows and splits into `10,844` now graded plus `185` that stay
`INDETERMINATE` for an independent eligibility reason. The increase is therefore `10,844` newly
graded rows (`10,858` total carrying a grade, up from `14`). The C3 promotion census's write count
is the same `10,858` (`written 10,858 / retained-unassessed 185`) because its write set is exactly
those graded rows; it is not a second, independent measurement of the fallback's effect. B5 records
the consequence for this fixture: `max-bound-workflow` returns `COMPLETE` where the baseline
observed `INDETERMINATE`, so the timed run now executes the full graded path the baseline number did
not measure.

**What this does not change.** The `1.2` proportional multiplier, the micro-latency floor, the hard
`25 ms` micro ceiling, the byte ceilings (`maxSerializedResultBytes <= 5,000,000`,
`maxEvidenceBytes <= 1,536,000`, `maxRedactedArtifactBytes <= 1,536,000`), the `5,000 ms` max-bound
deadline, the strict same-machine comparator, and the prohibition on retry or bypass all stay in
force. The override is carried forward by `--write` only while the Windows environment digest and
the fixture input hash still match; a changed identity requires a new owner decision. The historical
failures recorded above remain failures: this decision resets one endpoint's budget input from
measured evidence and does not relabel the n=7 FAIL or the single-probe failure as a pass.

## Ownership and review

- Owner: WC-1005 scanner performance-budget maintainers.
- Review status: The explicit micro-latency floor is the accepted WC-1005 budget revision.
  Normal review must verify the comparator and focused evidence; if a fresh strict live
  comparator fails, the result is `OWNER_REVIEW_REQUIRED` and no retry or bypass is allowed.

## CI policy invocation

The ordinary `check:scanner-v2-budget` gate is the strict same-machine path and the only one
that enforces the p95 ratchet. The gate sequence selects
`check:scanner-v2-budget:cross-machine` on its own whenever `CI === 'true'`, and that
auto-selection is intended and sanctioned (2026-09-24) rather than a loophole. The reason is
that CI and delegated agent runs share a host with unrelated work, which produces scheduler
and garbage-collection jitter that no baseline can absorb, so p95 measured there is not
comparable evidence. A caller may still invoke either script explicitly. The cross-machine
script points to this repository ADR and passes the fixed justification used by the
comparator, so reviewers can inspect both values in `package.json` and this ADR.

**What a CI run does and does not prove.** Under the cross-machine policy the enforced
invariants are the hard byte ceilings (`maxSerializedResultBytes <= 5,000,000`,
`maxEvidenceBytes <= 1,536,000`, `maxRedactedArtifactBytes <= 1,536,000`) and the max-bound
execution deadlines; these stay enforced and cannot be waived. The micro-latency p95
comparison is reported as not comparable and is **not** a CI claim - it belongs to an isolated
benchmark pass on a quiet host, which is where a latency regression must be established. A
green cross-machine budget gate therefore means the byte ceilings and the deadlines held; it
is not evidence that the p95 ratchet passed.

## Consequences

The approved baseline is regenerated from actual execution under the unchanged three-batch
policy and records the samples, warmups, aggregation identifier, environment, tool, and
fixture digests. Baseline and current reports with different measurement policy metadata are
rejected before latency comparison.

For micro fixtures, the explicit floor may accept up to a 5ms absolute increase when that is
larger than the 110% proportional budget. This trades a bounded false-pass risk for fewer
same-machine false failures caused by the documented sub-25ms scheduler/GC noise floor.
The hard 25ms current-p95 ceiling limits that tradeoff; it cannot be waived, and the
proportional budget remains unchanged for all baselines at or above 25ms.

Cross-machine CI remains useful for hard resource and deadline regressions without turning
incomparable latency numbers into a performance claim. Keep that division explicit when reading a
gate summary: a cross-machine budget entry proves the byte ceilings and the max-bound deadlines,
while the p95 dimension it reports as not comparable still needs an isolated benchmark pass before
anyone can call it a pass or a failure. External-machine, production-traffic, and deployment
validation remain outside this local evidence.
