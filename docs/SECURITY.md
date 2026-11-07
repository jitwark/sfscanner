# Security posture

> Status: current
> Last verified: 2026-08-31
> Owner: Community Hub maintainers
> Source of truth: `app/app/layout.tsx`, `app/src/scanner/`, and `app/e2e/scanner.spec.ts`

What this site defends against, how, and — where a defence is absent — why that was accepted
rather than overlooked.

The threat model is shaped by one fact: **this is a static export with no server, no
database, no account, no session, and no state-changing action.** There is no privilege to
escalate and no data of yours for us to lose, because we never receive any. Most of the
usual web risk surface is absent by construction rather than by control.

The risk that *is* real is the inverse: we publish 11,464 documents derived from workflows
written by strangers. Untrusted input reaching a page we serve is the main thing to get
right.

---

## The scanner's privacy boundary

The scanner's claim is that your workflow never leaves your browser. Three things support it:

1. **Analysis runs in a Web Worker**, from a module loaded off our own origin. There is no
   upload path in the code because there is no server to upload to. `npm run check:browser-safe`
   audits the scanner's source and import closure for network primitives, and
   `check:browser-safe:emitted` audits the actual built worker bundle after a fresh build.
2. **`connect-src 'self'`** in the Content-Security-Policy, which blocks a script in the
   *document* from fetching another origin.
3. **An end-to-end test records every network request** made during a scan of a workflow
   containing secrets, and asserts that no request is cross-origin, that every request is a
   `GET` or `HEAD` and so cannot carry a body, and that no URL or body contains any of the
   workflow's contents (`app/e2e/scanner.spec.ts`).

### What the CSP does not cover

Earlier versions of this document called `connect-src 'self'` a guarantee independent of our
code being correct. That was wrong, and the overstatement mattered more than the gap it
described. Two residuals:

- **The Worker is not covered by the page's policy.** A worker generally executes under the CSP
  delivered with *its own script response*, not the creating document's `<meta>` policy. GitHub
  Pages serves static files and cannot set response headers, so no policy is delivered for the
  worker script. The advertised `connect-src` is therefore not the network boundary for the code
  that actually reads your workflow.
- **Navigation is not a fetch.** `connect-src` governs fetch/XHR/WebSocket/EventSource/`ping`/
  `sendBeacon`. It does not govern top-level navigation, and navigation directives do not inherit
  `default-src`. Because the policy currently permits inline script, same-origin script that can
  read the workflow could place data in a cross-origin navigation URL via `window.location`, and
  the browser would leave the site and make that request with `connect-src 'self'`,
  `default-src 'self'`, and `form-action 'none'` all still active.

Both were reproduced locally in Chromium under the exact policy this site ships; the probes are
in the audit packets indexed by `docs/audit/HISTORY.md`.

So the accurate statement is: **no code path sends your workflow anywhere, this is enforced by
source and emitted-bundle gates and verified on the exercised path by an end-to-end request
sentinel, and the CSP is defence in depth for the document — not a browser-enforced guarantee
covering the Worker.** Strengthening this beyond its current bound needs a host that can set a
response CSP for the worker script, plus a strict document policy, or a different verified
isolation design.

References: [W3C CSP Level 3](https://www.w3.org/TR/CSP3/) separates fetch and navigation checks;
[MDN `connect-src`](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/connect-src)
lists the APIs it controls.

Findings are produced by hand-written deterministic rules. No model is called during a scan,
and no model output is authoritative for any security verdict anywhere in the system — a
boundary fixed by ADR and not changeable by configuration.

## Content-Security-Policy

Delivered as a `<meta http-equiv>` element, because GitHub Pages serves static files and
cannot set response headers.

| Directive | Value |
| --- | --- |
| `default-src` | `'self'` |
| `script-src` | `'self' 'unsafe-inline'` |
| `style-src` | `'self' 'unsafe-inline'` |
| `img-src` | `'self' data:` |
| `font-src` | `'self'` |
| `connect-src` | `'self'` |
| `worker-src` | `'self' blob:` |
| `base-uri` | `'none'` |
| `form-action` | `'none'` |
| `object-src` | `'none'` |

`'unsafe-inline'` for scripts is unavoidable: the theme bootstrap and JSON-LD blocks are
inline, and a static export has no per-request nonce. It is worth being plain that this
weakens the XSS mitigation the CSP would otherwise provide — which is why the injection
defences below are enforced at the point of rendering rather than delegated to the policy.

Fonts are self-hosted at build time by `next/font`, so the export makes no runtime request to
any third party and `font-src 'self'` holds.

## Accepted risk: no framing protection

**`frame-ancestors` is absent, and the site can be embedded in an iframe by anyone.**

The directive cannot be delivered here. The CSP specification requires user agents to ignore
`frame-ancestors` — along with `report-uri` and `sandbox` — when a policy arrives in a
`<meta>` element, and browsers log a console error for each one on every page load. A static
export has no response to attach a real header to.

**Decision: accepted, not mitigated.** Clickjacking works by tricking a victim into
performing an action in an authenticated context they cannot see. This site has no
authentication, no cookies, no session, no persisted state, and no action that changes
anything — the only interactive surfaces are a search box and a local scanner that writes
nothing anywhere. An attacker who frames the site can show a visitor a workflow catalogue.
There is nothing to capture and nothing to trigger.

A `_headers`-style configuration file was considered and rejected: GitHub Pages ignores such
files entirely, so shipping one would create the appearance of protection on the deploy
target that actually serves this site, which is worse than a documented absence.

**Reverse this decision if any of the following becomes true** — each independently makes
framing exploitable:

- accounts, sign-in, or any authenticated view
- cookies, `localStorage` used for anything but the theme, or any server-side session
- any state-changing action: submitting, saving, voting, reporting, purchasing
- deployment to a host that can set response headers, at which point
  `frame-ancestors 'none'` costs nothing and should simply be set

## Injection defences

Each of these was a live defect found and fixed during the build; the reference is
[`archive/BUILD-HISTORY.md`](archive/BUILD-HISTORY.md).

- **JSON-LD escaping.** `JSON.stringify` output written into `dangerouslySetInnerHTML` let a
  workflow title containing `</script>` close the element and execute script. `<`, `>`, `&`,
  U+2028 and U+2029 are now escaped, pinned by tests.
- **URL scheme validation.** A link-only entry's canonical URL comes from a crawled
  repository. A permalink of `javascript:alert(...)` reached `<link rel="canonical">` and
  `og:url` verbatim. `safeHttpUrl` now parses rather than pattern-matches, so `JavaScript:`
  and leading whitespace cannot slip past.
- **Invisible character stripping.** A right-to-left override in a title renders
  `report‮gnp.exe` as `reportexe.png` in a tab, a search result, and a social card. HTML
  escaping does not catch it because nothing is escaped and nothing executes. `stripInvisible`
  removes the override characters while deliberately leaving homoglyphs and non-Latin scripts
  intact — a catalogue of international workflows must not mangle legitimate titles.
- **Prompt-injection fixtures.** Workflow content reaching the description model is covered by
  adversarial fixtures. The model's output cannot set a licence, a rights status, a security
  grade, or a count regardless of what a workflow's text instructs.

## Secret handling

Workflows are sanitized before they are scanned, described, or packaged — including workflows
that are never published, because scanning a raw body and a redacted one yields different
grades and publishing both side by side misrepresents the sources differently.

The release gate runs a privacy audit over every packed body and fails closed on a forbidden
root field or a secret-shaped string. The audit of the two pack files as they stood before the
2026-09-27 flip (covering all 288 entries that were then redistributable) returned zero hits for
forbidden fields, official raw signatures, authorization literals, canaries, and secret-shaped
strings; the packs have been empty since that date, so no packed body ships at all. This is a local
data audit, not a rights or legal approval.

### Release-gate custody: the published-secret sweep

A second, stricter sweep asks a different question: does a literal secret value from the
*unsanitized* official corpus reach a **published artifact**? It is
`scripts/check-published-secret-leak.mjs`. Two inputs outside the repository decide whether it can
run at all, and it fails closed without them rather than compare against whatever it finds:

- **The snapshot** — `pipeline/.work/official-bodies-snapshot.json`, a verified inventory every body
  read must match file by file. It must be provisioned explicitly with `--snapshot <file>` or
  `OFFICIAL_BODIES_SNAPSHOT`; there is no default lookup. The release descriptor names that path as
  its input snapshot (`scripts/lib/release-descriptor.mjs`).
- **The bodies** — the sibling directory
  `<workspace>/../../n8n templates/04_curated_official_and_github/official`, which lives outside the
  repository entirely. Override with `--bodies <dir>` or `OFFICIAL_BODIES_DIR`.

**Custody and access boundary.** One release operator holds both inputs, on the operator's host,
outside version control. The bodies must never enter the repository and the snapshot must never be
committed. Only that operator regenerates either, and regenerating invalidates the previous sweep —
any generated-byte change requires a fresh sweep of the exact staged bytes before they are published
or committed.

**`npm run release:gates` does not provision these inputs.** `scripts/run-gates.mjs` lists the gate
in the release sequence but exports neither variable, so the sequence reaches it only if the operator
exported them first. Provision both before a release-gate run, or the sequence stops there.

**It is not a hosted-CI gate.** Neither `.github/workflows/ci.yml` nor
`.github/workflows/deploy.yml` references it: the trusted bodies are not available to CI, so the
sweep runs locally or on the operator's runner by design. That is the honest boundary, and it is why
the artifact is a local evidence log rather than a CI badge.

**Its positive control runs on every invocation.** Synthetic values are planted in a temporary
artifact and the real sweep must detect them, or the gate fails; `--plant-leak` adds that control
artifact to the sweep so the red verdict can be demonstrated on demand without touching the corpus.
A leak gate that has only ever passed is not evidence. A verified run on 2026-09-27 reported zero
verbatim strict matches across 15,400 published artifacts, with 9 widened-sweep matches reported and
not asserted, and the control detecting 5/5 planted values.

## Reporting a vulnerability

Use [voidsyntax01@gmail.com](mailto:voidsyntax01@gmail.com), the private contact on the takedown
request page, to report the problem and how to reproduce it. Do not open a public issue with
vulnerability details or sensitive data. Routine licence corrections with no personal data,
credentials, or security details may email [voidsyntax01@gmail.com](mailto:voidsyntax01@gmail.com?subject=SecureFlow%20takedown%20request).
For content removal rather than a vulnerability, use [`takedown.md`](takedown.md).
