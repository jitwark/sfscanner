# Scanner security and disclosure

> Status: current operating boundary; disclosure and release decisions remain owner-gated
> Last verified: 2026-10-17
> Owner: Scanner maintainer
> Source of truth: [`docs/SECURITY.md`](../SECURITY.md), [`SECURITY.md`](../../SECURITY.md), [`GOVERNANCE.md`](../../GOVERNANCE.md), and [the scanner threat model](threat-model.md)

This page tells authors and reviewers how to report a scanner concern without turning a sensitive
workflow into a new disclosure. It documents a process, not an independent security sign-off.

## Analysis boundary

The scanner accepts one workflow JSON document as untrusted bytes and performs bounded static
analysis locally. It does not execute workflow nodes, JavaScript, Python, expressions, shell commands,
SQL, or credentials; contact an n8n instance; resolve the n8n credential store; or make an HTTP, DNS,
socket, telemetry, or remote-import request. URLs and allowlists are analyzed as strings. The
browser Worker has no scanner network primitive; source and emitted-worker checks are local evidence,
not a universal browser or host isolation guarantee.

A finding is evidence of a catalogued shape in the submitted document. It is not a host vulnerability
assessment, an n8n-version/CVE determination, proof that a branch executes, proof that a credential is
live, or a compliance, exploitability, or safety verdict. The scanner cannot see instance settings,
roles, sharing, network/filesystem policy, deployment mode, or the managed credential store. Missing
or unsupported evidence remains `UNKNOWN`, `DEGRADED`, or `INDETERMINATE` as appropriate; it is never
quietly treated as false or clean.

The explicit v2 path admits only `secureflow-scanner@2.0.0` with `beta-default@2.0.0` and built-in
authority. Native v1 and its `scanner-beta-1` identity remain separate compatibility surfaces.
`beta-hardened@2.0.0`, custom packs, Ed25519 signing, and live key rotation are not admitted v2
features.

## Safe report handling

Use synthetic or fully redacted material in every report. Never paste a live credential, API key,
bearer/basic token, cookie, private key, session value, unredacted workflow export, customer data,
pinned execution data, or proprietary prompt. A private channel does not make live secrets safe to
copy. Redaction is pattern-based and can miss data; replace values with stable placeholders before
sharing and verify the result manually.

Include only the minimum needed to reproduce:

1. affected scanner surface and exact engine/profile/schema identity, if known;
2. commit, release candidate, page, or CLI command, without private filesystem paths;
3. a small synthetic fixture or redacted structural description;
4. expected versus observed status, finding, exit code, or data exposure;
5. whether any real secret or personal data may already have been exposed; and
6. a safe reply address and whether the report may be shared with a reviewer.

Do not open a public issue for a suspected vulnerability or attach workflow JSON to a routine issue.
If a secret may have been exposed, rotate it with the service owner first and say only that rotation
was required; do not send the replacement value.

## Private reporting route

Preferred route: [GitHub Private Vulnerability Reporting for `jitwark/n8n-Secureflow`](https://github.com/jitwark/n8n-Secureflow/security/advisories/new), when the repository setting makes that form available. Fallback: [voidsyntax01@gmail.com](mailto:voidsyntax01@gmail.com). If the preferred form is unavailable, use the fallback and mark the message **PRIVATE SECURITY REPORT**.

The current project has one maintainer. The acknowledgement target for security reports is not
confirmed in the repository's security documents — they record it as `OWNER_TO_BE_CONFIRMED` — so
no response time stated here is an SLA, guarantee, or contractual commitment. An independent
security reviewer is currently unstaffed. Do not infer triage, remediation, disclosure, or release
approval from an acknowledgement or from a local test result.

## Severity and response

Severity is provisional until the maintainer has a safe reproduction and understands affected
surfaces. Use the highest supported description, not a confident CVSS score:

| Level | Triage description |
| --- | --- |
| Critical | A plausible path to secret exposure, arbitrary code execution, or release-integrity compromise in a supported scanner/release surface. |
| High | Material cross-boundary disclosure, integrity loss, or denial of bounded scanning without a narrower safe workaround. |
| Medium | A meaningful user or reviewer impact with limited scope, required conditions, or a documented workaround. |
| Low / Info | Hardening, documentation, diagnostic, or low-impact correctness issue that does not establish a security boundary failure. |

The maintainer will privately acknowledge when possible, reproduce with synthetic data, classify the
impact, contain or withdraw an affected prepared artifact if needed, and decide whether a fix,
release-note entry, or coordinated disclosure is appropriate. Timing and disclosure contents are
case-by-case; no fixed remediation or publication deadline is promised. Reports that depend on an
n8n host, credential store, deployment, or third-party service are routed as contextual reports
because this scanner cannot verify those claims itself.

## Review and release status

Local checks can establish parser, no-execution, no-network, redaction, determinism, and contract
properties. They do not establish external CI, independent security review, human adjudication,
legal/rights approval, official SARIF ingestion, TestSprite coverage, deployment safety, publication,
or a production release. Those dispositions remain `PENDING` until a named owner records scope,
evidence, date, and decision. See the [release runbook](release-runbook.md) before attaching a report
to a release decision.

## Non-claims

This page does not claim that the scanner detects every vulnerability, knows an n8n version or host
configuration, inspects a credential store, protects a browser Worker by CSP alone, provides a
response SLA, has an independent reviewer, or has received external security, legal, rights, CI,
deployment, publication, or release approval.
