# Governance

> This is a single-maintainer project. There is no maintainer group, no board, and no company
> behind it — one person (`@jitwark`, GitHub) makes and is accountable for every decision below.
> This document says so plainly rather than describing a committee that does not exist.

This project combines a browser-local deterministic scanner, a static catalogue, and build-time
acquisition and release tooling. Governance keeps those boundaries explicit and treats rights,
privacy, security, and reproducibility as release concerns rather than informal promises — that
discipline does not depend on headcount.

## Roles

| Role | Responsibility | Held by |
| --- | --- | --- |
| Operator | Public claims, jurisdiction, production authority, and final release decision | `@jitwark` |
| Maintainer | Issue routing, reviews, merges, and conflict resolution | `@jitwark` |
| Scanner maintainer | Core rules, redaction, contracts, parity, and calibration | `@jitwark` |
| Rights and data maintainer | Provenance, exclusions, attribution, and data release | `@jitwark` |
| Security reviewer | Vulnerability triage and security-release recommendation | `@jitwark` |
| Accessibility/product reviewer | User journeys, keyboard support, responsive behavior, and accessibility | `@jitwark` |
| Release reviewer | Build, hashes, notices, rollback, and deployment evidence | `@jitwark` |
| Independent rights/legal reviewer | Separate review of redistribution and public claims | **Unstaffed** |

The last row is deliberately not filled in with the same name as the rest. "Independent" review
means a second person who did not write or approve the original decision; a single maintainer
cannot hold that role for their own work. Until someone else fills it, redistribution and public
rights claims in this project get one person's judgment, not independent review. See
[`docs/sources.md`](docs/sources.md) and [`docs/LICENSING.md`](docs/LICENSING.md); unknown per-entry
rights continue to be handled as link-only or excluded.

## Decision rules

- Public claims, licence choices, workflow redistribution, legal notices, and production promotion
  require an explicit recorded decision with scope, evidence, approver, date, and rollback target.
- If provenance or rights cannot be established, the record remains link-only or is excluded. No
  default licence or download permission is inferred.
- Scanner findings and security grades come from deterministic pipeline fields. Descriptive prose
  cannot override them.
- A release requires the relevant technical gates and a recorded GO decision. Where this document
  calls for independent review and the role is unstaffed, the release record says so explicitly
  rather than silently treating the maintainer's own review as independent.
- Silence is not approval. A production promotion remains paused until the responsible owner
  records the decision.

## Review and escalation

Every pull request is reviewed by `@jitwark`, per `CODEOWNERS`. Because reviewer and author are
frequently the same person for a single-maintainer project, the review record for a
rights/legal- or security-sensitive change should say plainly when self-review was the only
review available — that is a limitation to disclose, not one CODEOWNERS enforcement can hide.

If a second maintainer joins, `CODEOWNERS` and the role table above should be updated in the same
change that grants them access — a person is only listed once they have actually accepted the
responsibility, not in anticipation of it. Rights or legal disagreement blocks redistribution; a
security disagreement blocks the affected release; an unresolved operator or production decision
blocks promotion.

Historical decisions should be retained and corrected by append-only follow-up records. Do not
rewrite release evidence to make an earlier decision appear stronger than it was.

## Contact

For governance questions, open an issue. For anything sensitive (security reports, personal data,
takedown requests involving confidential evidence), use the private channel in
[`SECURITY.md`](SECURITY.md) or [`docs/takedown.md`](docs/takedown.md) instead of a public issue.

## Current status

This document does not grant a licence, establish a legal entity, provide legal advice, or claim
a safe-harbour protection. It does not represent that independent legal or security review has
occurred for any specific release — the "Unstaffed" row above and the decision rules exist
precisely to keep that gap visible instead of papering over it. If the project ever adds a second
maintainer, an operating company, or a formal legal entity, this document should be updated in the
same change that makes it true, not in advance of it.
