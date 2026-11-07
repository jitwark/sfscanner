# Privacy

> Status: current
> Last verified: 2026-09-05
> Owner: Pipeline maintainer
> Source of truth: `pipeline/sanitize/`, `pipeline/audit-privacy.ts`, and final package validation

n8n-secureflow has no accounts, cookies, analytics beacon, API, database, or application server.

## Workflow scanner

When you paste or drop a workflow into `/scanner`, parsing and deterministic scanning run in a Web Worker in your browser. The workflow is not uploaded to n8n-secureflow. The scanner does not make a network request with the pasted content.

## Catalogue

Catalogue pages are static files served by the configured hosting provider, including Firebase Hosting when a preview is deployed there. A hosting provider may observe or retain request metadata under its own policies. A browser downloads only the static page, search index, catalogue shards, and charts: no workflow JSON is offered for download, because every entry is link-only since the 2026-09-27 F-001 ruling, and the packs that used to carry bodies are empty. Link-only entries open their upstream source in the browser.

The site does not store workflow contents in local storage. It may store a theme preference locally, and the browser may cache downloaded static files.

## What is actually in the published text — measured

The sanitizer redacts credentials, secrets, pinned data and code bodies during acquisition. That is
what we *do*; this is what the artifacts *contain* afterwards, which is a different question and
had never been asked.

`npm run check:corpus-privacy` sweeps every published string a reader can see — title, summary,
description, source metadata, hostnames, integrations — for four shapes. It reports counts and
entry ids and never a matched value: a privacy check that logs the addresses it found has published
them a second time, into CI output retained for weeks. It runs in the release sequence and fails if
a count rises above the recorded baseline.

Measured on 2026-09-05 across all 11,464 published entries:

| Shape | Occurrences | Entries |
| --- | ---: | ---: |
| Email address | 7 | 5 |
| Bearer token or API key | 0 | 0 |
| Private or loopback IP address | 0 | 0 |
| Hostname on a private network (`.local`, `.internal`, `.lan`, `.corp`) | 0 | 0 |

**All seven email addresses were inspected. None belongs to a real person we know of**: every one
appears inside a generated description as an illustrative example — *"imagine a new lead submits a
form with the email …"*. They are invented by the description model, not harvested from a workflow.
That is not entirely comfortable, because an invented address can collide with a real one, and it
is recorded here as a known property of generated prose rather than presented as a clean result.

Zero credential-shaped strings and zero private network addresses across 11,464 entries is the
result the sanitizer was built for, and it is now measured rather than assumed.

## Third parties

A link-only entry may navigate to its upstream source, such as GitHub or n8n.io, only after you select that link. Those services apply their own privacy policies. n8n-secureflow does not proxy those requests.

## Contact

For a privacy concern or a request to remove a source or entry, email [voidsyntax01@gmail.com](mailto:voidsyntax01@gmail.com). Do not post personal data, workflow details, or other sensitive material in a public channel. Routine licence corrections that contain none of those details may use [the routine request email](mailto:voidsyntax01@gmail.com?subject=SecureFlow%20takedown%20request). Include the relevant catalogue URL and upstream link so the report can be verified.
