# ADR: Deployment environment policy for local-only and timing-sensitive gates

> Status: accepted
> Date: 2026-10-18
> Scope: release gates, the deploy workflow, and CI tolerance

## Decision

Two classes of gate cannot hold on a shared cloud runner. Each gets an explicit **environment policy**
rather than being silently weakened or quietly dropped.

**1. Gates whose input cannot exist in the cloud are local-only.** `check:published-secret-leak` needs
the raw official template corpus, which is local-only and non-redistributable by legal design, and a
cloud runner must not possess or receive it. Under CI, when the raw bodies are absent, the gate exits 0
with a **labelled skip** that states plainly that absence was **not** proven in that environment. Locally
it still fails closed, unchanged. It stays in the `release` sequence, so the deploy keeps running the one
canonical step rather than regressing to an ad-hoc list of checks.

**2. Micro-latency bounds carry a 2.0× CI tolerance.** The stage-35 vitest timeout and the stage-36
main-thread gap bound are millisecond thresholds on a shared runner. Under CI they are 10,000 ms (from
5,000 ms) and 150 ms (from 75 ms) respectively — the same shape of policy
[the scanner v2 performance budget](scanner-v2-performance-budget.md) already applies to p95. The
applied bound and the multiplier are printed, so a tolerated pass cannot be mistaken for a strict one.

**The multiplier now covers the overshoot that motivated it.** The stage-36 failure measured
118.60 ms against 75 ms — **1.58×** — so the first implemented value, 1.5× (112.5 ms), did **not**
cover that exact load and was replaced. At 2.0× the CI bound is 150 ms, which is `31.40 ms` above the
observed `118.60 ms`; the stage-35 overshoot of 5,632/5,000 = 1.13× is covered too. 2.0× is the
owner's chosen value and is recorded as *above the observed spread*, not as a measured ceiling: it is
a tolerance chosen for shared-runner jitter, not a bound any measurement established. The
alternative, consistent with the p95 policy, is to report both bounds as telemetry under CI and keep
enforcing them strictly locally.

## Evidence and scope

- The gate fails closed on **two** inputs — the inventory snapshot and the raw bodies
  (`check-published-secret-leak.mjs:85-98`, the corpus decision itself in
  `scripts/lib/local-only-corpus-policy.mjs`) — and its own message is the reason it must not be handed a
  weaker input: *"it cannot prove absence without the source it is asserting absence about."* The gate
  only requires that every body it reads hash-match the pinned inventory, so it does not care where the
  bytes came from; this decision is about whether they may be transmitted at all, and they may not.
- `deploy.yml:66` runs `npm run release:gates`, so every deploy reached this gate and failed closed on an
  input that cannot exist there. `run-gates.mjs` references neither `--snapshot` nor
  `OFFICIAL_BODIES_SNAPSHOT`.
- Host sensitivity is measured, not assumed. The same two bounds failed under load and passed on a quiet
  host: the vitest case at 5,632 ms against a 5,000 ms default (5/5 passing in isolation at 6.07 s), and
  the e2e main-thread gap at 118.60 / 86.20 / 93.20 ms against `<= 75` **while `scanner.spec.ts` measured
  61.50 ms and passed in the same run**.
- `run-gates.mjs:7-12` already selects `check:scanner-v2-budget:cross-machine` when `CI === 'true'`, whose
  own output states that the p95 dimension was not compared and that byte ceilings and max-bound deadlines
  were enforced. This ADR extends that reasoning to two more host-sensitive bounds rather than inventing a
  new principle for them.

## Consequences

- The deploy no longer fails on an input its environment cannot have, and the skip is visible in the log
  rather than silent — a reader can distinguish "not applicable here" from "passed".
- A CI pass on either timing bound is a **tolerated** pass. The printed bound makes the tolerance
  auditable; it does not make the measurement comparable to a quiet-host run.
- The local `npm run release:gates` run before tagging remains the **strict** gate for all three, and is
  the one whose result may be cited as assurance.
- **Not claimed:** any p95 result; that the tolerances are measured rather than chosen; or that a CI pass
  on these bounds says anything about absolute performance.
- **The p95 dimension was decided from protocol evidence, and none of the CI tolerances cover it.**
  The same-machine record stands: the pre-registered protocol failed at n=7 (`max-bound-workflow`
  mean 862.690 ms, spread 10.824, L₇ = 0.219920 against c = 0.182322), and the strict gate's probe
  measured 878.28645 ms against the old 826.471902 ms limit. The owner then set
  `budgetBaselineP95Ms: 880` for that endpoint, making the proportional 120% limit `1,056 ms`; the
  derivation and its margins are recorded at
  [`scanner-v2-performance-budget.md`](scanner-v2-performance-budget.md). That decision governs the
  strict same-machine invocation only — a CI run still reports p95 as not comparable, and the
  tolerance above is not evidence about p95.
- **The local gate needs its input provisioned.** `check:published-secret-leak` requires the raw corpus
  *and* a verified snapshot, and nothing provisions the latter — so the pre-tagging run is
  `OFFICIAL_BODIES_SNAPSHOT=<repo>/docs/audit/2026-10-17-remediation/E2b-official-bodies-snapshot.json npm run release:gates`,
  or that same path passed to the gate as `--snapshot`. Without it the gate fails closed, which is the
  intended behaviour but makes the runbook's workflow unfollowable as written.
