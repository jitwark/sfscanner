# Security policy

> This is a single-maintainer project (see `GOVERNANCE.md`) with no numbered release yet. The
> response expectations below are what one person can actually commit to, not an aspirational
> SLA — treat the absence of a promise as more honest than an unenforceable one.

## Scope and boundary

The application is a static export with a browser-local scanner. It has no application server,
database, account system, or API in the shipped site. A pasted workflow is parsed and scanned in
a Web Worker; the scanner does not upload workflow content or make runtime network requests with
it — enforced by source and emitted-bundle checks (`check:browser-safe`,
`check:browser-safe:emitted`) and verified on the exercised path by an end-to-end network
sentinel (see [`docs/SECURITY.md`](docs/SECURITY.md) for the full mechanism and its known limits).

The catalogue and release artifacts are a separate trust boundary. They contain public-source
metadata and derived analysis. A downloadable workflow body requires an explicit provenance and
rights decision; a link-only record points to its upstream source and is not proxied by the site.

## Supported versions

| Version | Supported |
| --- | --- |
| `main` branch | Yes — this is the only thing that exists. No tagged or numbered release has shipped yet. |

Once a first tagged release ships, this table will be replaced with real version rows and this
sentence will go away. Until then, "supported" means "the only build a report can be reproduced
against."

## Reporting a vulnerability

**Preferred: GitHub Private Vulnerability Reporting**, on the "Security" tab of
[`jitwark/sfscanner`](https://github.com/jitwark/sfscanner) → "Report a vulnerability."
It keeps the report private to the maintainer by default and threads the conversation next to the
code, which is the least error-prone way to report something sensitive on GitHub. (This is the
recommended channel; if it is ever found to not be enabled on the repository, use the email
fallback below and say so — do not assume it is active without checking the tab yourself.)

**Fallback: email** [voidsyntax01@gmail.com](mailto:voidsyntax01@gmail.com) if you cannot use
Private Vulnerability Reporting, or the finding also needs to reference non-code material (a
catalogue entry, a data-rights concern) that GitHub's security tab isn't the right place for.

Do not publish credentials, private workflow JSON, personal data, exploit details, or other
sensitive material in a public issue. A regular GitHub issue is public by default — the
false-positive/false-negative scanner-accuracy issue template is for correctness, not for
anything that needs to stay confidential.

Include the smallest safe reproduction:

- affected commit, page, command, or file;
- impact and expected versus observed behavior;
- whether a secret, personal data, or workflow content may be involved;
- a redacted reproduction or synthetic fixture where possible;
- a safe reply channel.

Never send a real credential to demonstrate a finding.

## Response process and expectations

This is one person, not a security team, and there is no on-call rotation behind it. What can
honestly be promised:

- **Acknowledgment:** best-effort within 7 days. If you haven't heard anything in that window,
  a follow-up on the same thread is completely reasonable — it may have been missed.
- **Triage:** after acknowledgment, the report is validated and its impact and reachability
  assessed against the scope above. There is no fixed SLA for this step; a client-side static
  site has a narrower blast radius than a server-backed product, but that doesn't excuse a slow
  look at something serious.
- **Fix and disclosure:** for a confirmed issue, the fix ships as a normal commit/PR once
  verified. Coordinated disclosure timing is negotiable case by case — ask, rather than assuming
  a fixed embargo window neither side agreed to.

There is currently no independent security reviewer (see `GOVERNANCE.md`'s "Unstaffed" row) —
triage and remediation are the same person's judgment. That's a real limitation for a severe
finding, and it's disclosed here rather than implied away.

## Out of scope

The site does not execute workflows or credentials, operate an n8n instance, or accept workflow
uploads through a server. Reports that depend on those absent services should state the
assumption so they can be routed correctly. A scanner result is deterministic analysis guidance,
not an authorization to run a workflow and not a guarantee that a workflow is safe.

Reports about a third-party dependency's own CVE are welcome context but should go to that
project first; this repository's response is limited to updating the pinned version and
re-verifying our own gates, not patching someone else's code.
