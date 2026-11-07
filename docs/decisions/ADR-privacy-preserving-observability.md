# ADR: Privacy-preserving observability

> Status: accepted
> Date: 2026-08-26
> Owner: Community Hub maintainers (see "Owner gap" below — no named individual is assigned yet)
> Formalizes: `docs/superpowers/plans/luna-production-readiness/13-observability-posture.md`

## Context

The production-readiness programme needs a way to know the site, scanner, search, and data releases
are healthy without adding the RUM/Sentry/analytics tooling a typical SaaS product would reach for —
those are explicitly incompatible with this project's static, offline-scanner, no-account, no-tracking
posture (`app/src/ui/site-footer.tsx`: "No account. No upload. No tracking."; verified true across
P0.1/P0.3/P0.4 sweeps: no network primitive in the scanner worker, no analytics script found anywhere
in `app/src`). Without an explicit decision, "we'll add basic analytics later" is exactly the kind of
incremental scope creep that erodes a stated privacy guarantee one small addition at a time.

## Decision

**V1 has no RUM, Sentry-style client error reporting, Firebase Analytics, search telemetry, scanner
telemetry, or workflow-content logs.** Observability instead comes from four layers, all evidence-
based and none requiring a client to transmit anything:

1. **Build and release health** — the canonical release-gate machine summary (commit/release/schema/
   tool identities, command results, durations, artifact counts/sizes/hashes); corpus, exclusion,
   rights, graph, parity, scanner-calibration, search-relevance, page, link, SEO, reproducibility,
   data-export, and supply-chain gates; CI/deploy logs under the repository/host retention policy; the
   immutable release manifest and signed evidence bundle. No raw workflow content, credentials,
   private source URLs, Firebase credentials, or unredacted scanner evidence enters any log.
2. **Client-visible runtime health** — finite route/search/scanner/canvas error states with retry and
   a safe diagnostic code; worker timeout/crash/cancel detection with no stale-request overwrite; a
   zero-uncaught-error/unhandled-rejection/console-error gate across the route matrix; no hidden
   diagnostic transmission; an optional user-initiated "copy diagnostic" containing only allowlisted
   version/code/release fields. The user is the observer — errors are visible and actionable locally,
   without telemetry.
3. **Hosting/deployment health** — Firebase preview deploy result, channel identity/expiry, file/byte
   count, duration; remote synthetic smoke and header/cache/compression/range/noindex checks;
   scheduled/manual post-release canary only if the owner explicitly requests recurring monitoring
   (no heartbeat/monitor automation is added by default); documented responsibility for preview
   expiry, deploy failure, certificate/domain, and rollback.
4. **Product-quality drift** — scanner calibration/adversarial corpus rerun on policy/tool/n8n-
   taxonomy changes and scheduled release cadence; search judged-set validation/rebenchmark on every
   corpus/ranking/search-artifact version change; performance/export size/file-count ratchets on every
   release; rights/exclusion/notice integrity on every source or release change; dependency/security
   audit on every release and a scheduled maintenance cadence.

**Adding any client signal that leaves the browser requires a new privacy/security ADR, a data-flow
diagram, consent/legal review, a retention policy, a threat model, and owner approval.** This ADR is
itself the gate that decision has to pass — not a decision that opt-in telemetry is coming later.

## Owners, triggers, retention, failure thresholds, response (by layer)

| Layer | Trigger/cadence | Retention | Failure threshold | Response |
| --- | --- | --- | --- | --- |
| Build/release health | Every `npm run gates` / CI run | Repository/CI host default retention (GitHub Actions logs) | Any nonzero gate exit | Fix before merge/release; gate summary names the failing check |
| Client-visible runtime health | Continuous (every page load in production) | Not retained anywhere — local to the user's browser session only | Any uncaught error/console error in the automated route-matrix sweep | Fix before the affected route ships; no user data is ever collected to diagnose it remotely |
| Hosting/deployment health | Every preview deploy (Phase 8); no recurring canary unless explicitly requested | Deploy-tool default (Firebase CLI/hosting logs) | Any failed remote smoke/header check | Do not promote the deploy; investigate from the sanitized deploy log |
| Product-quality drift | On every relevant corpus/ranking/policy/dependency change, per the cadence listed above | Versioned alongside the release identity that produced it (immutable, in the release evidence bundle) | Any regression beyond the approved ratchet (search/perf) or any calibration/audit finding | Block the release; the differential/calibration report is the evidence, reviewed before merge |

## Owner gap

This ADR names "Community Hub maintainers" as the collective owner because no individual has been
assigned per-signal ownership yet — that's a real gap, not an oversight papered over. Per-signal named
ownership (who specifically watches the release-gate summary, who owns the deploy-channel expiry
calendar) is deferred to whenever the project has more than one active maintainer; recorded here so
it isn't silently forgotten.

## Explicitly prohibited without a new ADR

RUM (real-user monitoring), Sentry or equivalent client-side error-reporting SDKs, Firebase Analytics
or any analytics SDK, search-query telemetry, scanner-input/scan-result telemetry, and any workflow-
content logging. A future proposal for any of these must supply its own privacy/security ADR, data-
flow diagram, consent/legal review, retention policy, and threat model — this decision does not
pre-approve any of them, and "we already decided to add observability" is not itself sufficient
justification when that future proposal is evaluated.

## Consequences

- No user analytics exist to answer "how many people use the scanner" or "what do people search for"
  — that information is genuinely unavailable, not just unreported. Product decisions rely on the
  corpus's own aggregate `/analytics/` page (statistics about the workflow corpus itself, not visitor
  behavior — see the P0.5 finding about this naming collision) and qualitative/community research
  instead.
- Debugging a user-reported issue relies on the user's own browser tools and the optional "copy
  diagnostic" affordance, not a server-side error dashboard.
- Every phase runbook's own gate gets slightly more load-bearing as the *only* source of release
  confidence, since there is no runtime telemetry fallback — this raises the bar on gate correctness
  and coverage, which is a fair tradeoff already reflected across the phase runbooks.

## What would reverse this

An explicit owner decision to add a specific, scoped telemetry capability, made through the ADR
process this decision itself requires — not an incremental "just add error tracking" change. Any such
future ADR should reference this one and explain specifically what changed (a legal requirement, a
scale threshold, a security incident) rather than treat privacy-preserving observability as merely the
default that happened to ship first.
