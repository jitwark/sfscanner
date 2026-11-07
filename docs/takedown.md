# Takedown and source removal

> Status: current
> Last verified: 2026-08-30
> Owner: Community Hub maintainers
> Source of truth: `docs/takedown.md`, the source registry, and release reports

n8n-secureflow indexes public workflow metadata and derived analysis. It hosts no raw workflow JSON at all: since the 2026-09-27 F-001 ruling every published entry is link-only, and the release publishes derived facts plus a link to the recorded upstream source.

## Request removal

For a routine, non-sensitive catalogue request, including a licence or provenance correction or source or entry removal, email [voidsyntax01@gmail.com](mailto:voidsyntax01@gmail.com?subject=SecureFlow%20takedown%20request) with the relevant catalogue reference and requested action. The private repository contains a structured maintainer issue form for internal triage. Do not put personal data, security reports, credentials, or confidential evidence in a public channel; send those privately to [voidsyntax01@gmail.com](mailto:voidsyntax01@gmail.com).

For copyright notices, personal-data requests, security reports, or any request containing sensitive material, use the private contact: [voidsyntax01@gmail.com](mailto:voidsyntax01@gmail.com). Include:

1. The n8n-secureflow catalogue URL or stable entry ID.
2. The original source URL and, for GitHub entries, repository and path.
3. Your relationship to the work and the reason for removal.
4. Any replacement, licence correction, or upstream deletion evidence.

Do not include credentials, workflow secrets, or sensitive customer data.

## Handling process

A maintainer verifies the request against the provenance stored on the entry. A confirmed source removal marks the source excluded; an entry removal records its stable ID in the exclusions list. The corpus is rebuilt, and the removal check verifies that the entry is absent from catalogue shards, the search index, packs, and pre-rendered pages before redeployment.

Expected acknowledgement is within three business days. Urgent security reports should use the same private contact shown on the takedown request page; do not disclose sensitive details in a public issue.

This project makes no claim to the DMCA section 512(c) safe harbour and has not published a designated agent. A notice can still be sent to the private contact above and will be reviewed under the removal process.

## Verification record

The release record identifies the rebuilt manifest and deployment revision. The old public URL is checked after deployment, while unrelated workflow pages and the upstream links they publish are rechecked to avoid collateral removals.
