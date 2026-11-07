# Scanner v2 normalization

> Status: admitted-core normalization contract; external conformance and release remain gated
> Last verified: 2026-10-17
> Owner: Scanner maintainer
> Source of truth: [`packages/scanner-core/src/source/source-parser.ts`](../../packages/scanner-core/src/source/source-parser.ts), [`packages/scanner-core/src/workflow-v2/normalize-security-workflow.ts`](../../packages/scanner-core/src/workflow-v2/normalize-security-workflow.ts), [`packages/scanner-core/src/workflow-v2/security-workflow.ts`](../../packages/scanner-core/src/workflow-v2/security-workflow.ts), and [`openspec/changes/world-class-scanner-cli/specs/scanner-trust-boundary/spec.md`](../../openspec/changes/world-class-scanner-cli/specs/scanner-trust-boundary/spec.md)

Normalization is the boundary between untrusted workflow bytes and v2 security analysis. It keeps a
bounded source representation, a separate semantic workflow, and explicit ambiguity rather than
silently applying a lossy object parser. It never executes a workflow, expression, getter, or
embedded JavaScript/Python source.

## Bytes-first parser

[`parseSourceDocument`](../../packages/scanner-core/src/source/source-parser.ts) accepts a
`Uint8Array` and resolves a complete [`scanner-limits-v2`](../../contracts/scanner-limits-v2.ts)
record before parsing. The parser:

1. rejects input beyond `maxBytes` with `WORKFLOW_TOO_LARGE`;
2. recognizes an optional UTF-8 BOM, hashes the exact original bytes, and removes only that BOM from
   the decoding payload;
3. decodes with fatal UTF-8 semantics, returning `UTF8_DECODING_FAILED` rather than replacing bad
   bytes;
4. checks document depth before parsing and parses JSON in location-aware mode; and
5. builds a parser-owned, deeply frozen source graph while charging syntax nodes, members/elements,
   duplicate keys, depth-proportional source work, and retained source spans.

`rawSha256` and `utf8Bytes` include the BOM when one was present. A source span's offsets do not:
zero-based UTF-16 and UTF-8 offsets start at the first decoded code unit/byte after the optional BOM.
A span is half-open `[start, end)`; line and column are one-based, and column counts UTF-16 code
units. If the span budget omits a location, the source reference remains present with `span: null`.

The v1 presentation projection uses coordinates in the original JavaScript input string. When the
input has one leading BOM, it adds one UTF-16 code unit to v1 offsets and one column on the first
line; it does not change v2 spans or add the BOM's three UTF-8 bytes to v2 offsets. The direct v1
parser also accepts one leading BOM and rejects another BOM used as JSON syntax.

## Source graph and semantic workflow

The source graph retains member order, duplicate occurrences, scalar lexemes, decoded values, and
source references. [`source-types.ts`](../../packages/scanner-core/src/source/source-types.ts)
defines the internal graph. A source reference contains:

- an effective RFC 6901 pointer;
- a zero-based occurrence path through every ancestor/member segment;
- an `astNodeId` derived from the occurrence path, slot encoding, value kind, and scalar lexeme or
  child identity; and
- an optional source span with line, column, UTF-16, and UTF-8 coordinates.

[`normalize-security-workflow.ts`](../../packages/scanner-core/src/workflow-v2/normalize-security-workflow.ts)
projects that graph into `SecurityWorkflowV2`:

- workflow fields retain their semantic classification (`PLAIN`, `EXPRESSION`, `CODE`,
  `CREDENTIAL_REF`, or `SECRET_CANDIDATE`);
- node ordinal and source occurrence are authoritative; an n8n `id` or `name` is a label and is
  retained only when unambiguous;
- nodes retain type, normalized type version, disabled state, scoring eligibility, parameter,
  credential, and settings fields; and
- every well-shaped connection candidate is retained with its labels, ports, connection type,
  source reference, ordinal, and endpoint resolution.

A source or target label resolves to a node only when exactly one retained node matches. Ambiguous
and unknown labels keep the exact label but omit the ambiguous/unresolved endpoint reference. The
normalizer never fabricates a node identity or dangles a reference to a node that was not retained.

## Canonical identity and ordering

The identity helpers are [`source-identities.ts`](../../packages/scanner-core/src/source/source-identities.ts),
[`node-edge-identity.ts`](../../packages/scanner-core/src/workflow-v2/node-edge-identity.ts), and
[`workflow-digest.ts`](../../packages/scanner-core/src/workflow-v2/workflow-digest.ts).

- `rawSha256` is SHA-256 over the exact input bytes.
- The normalizer's semantic digest is over the canonical security workflow, including the ambiguity
  records. The v2 scan entrypoint binds that normalized digest to the canonical target
  `contextDigest` before exposing `input.semanticSha256`.
- `ambiguitySha256` is SHA-256 over the canonical ambiguity array. Thus a duplicate or graph
  ambiguity changes semantic identity even if an ordinary object projection would have selected the
  same last member.
- Node identity hashes `secureflow-node-ref-v2`, the source ordinal, and source `astNodeId`.
- Edge identity hashes its ordinal, optional endpoint identities, exact labels, connection type,
  source/target ports, source `astNodeId`, and resolution state.
- Identity tuples are length-prefixed and locale-independent. The canonical serializer orders keys
  by Unicode code point and emits no insignificant whitespace.

Source occurrence order is preserved during parsing and normalization. Ambiguities sort by source
occurrence, registry kind order, related identities, and ambiguity ID. Result arrays then follow the
v2 result rules: capabilities by manifest order; diagnostics by capability, registry code,
location, and ID; facts/traces by ID; findings by severity, rule, subject identity, and finding ID.

## Duplicate-key and malformed-value semantics

Duplicate members are evidence, not a last-write-wins convenience. The normalizer records every
occurrence and assigns an impact:

| Situation | V2 treatment |
| --- | --- |
| Duplicate workflow metadata only | Retain all occurrences and emit `DUPLICATE_METADATA_KEY`; status is degraded. |
| Duplicate `nodes`, `connections`, node `id`/`name`, or another graph-identity input | Retain source evidence and emit a graph-identity ambiguity; no identity is collapsed. |
| Duplicate node `type`, `parameters`, credentials, settings, or execution-control/security fields | Mark the node `scoringEligibility: INDETERMINATE` and emit `DUPLICATE_SECURITY_KEY`; a scoring candidate is `UNKNOWN`, not an asserted observation. Required loss makes the aggregate result indeterminate. |
| Duplicate members nested below parameters, credentials, or settings | Treat as security-consumed input even when the duplicate is several levels down; do not inspect only the last member. |
| Duplicate `node` or `index` in a connection candidate | Retain the raw edge, mark its graph identity ambiguous, and do not choose an endpoint from conflicting values. |
| A non-object `parameters`, credentials, settings, or control value where an object is required | Retain the malformed source reference, emit `MALFORMED_NODE_PARAMETERS`, exclude that node from a trustworthy scored conclusion, and do not invent `{}`. |
| A malformed type, type version, or required workflow shape | Return a bounded `MALFORMED_WORKFLOW` outcome or record a security ambiguity; never coerce arbitrary data into a valid security field. |

A metadata-only duplicate may remain analyzable with degraded status. A duplicate that can change a
scoring conclusion is never represented as a clean or ordinary graded result. This is the boundary
that reconciles the native v1 parser's historical diagnostics with v2's explicit ambiguity model.

## Bounded limits

The v2 parser and normalizer use inclusive budgets. Exactly the maximum charged unit is accepted;
the next unit returns the registered failure. Source-shape limits reject before a semantic skeleton
exists; isolated analyzer limits are represented later as capability diagnostics.

| Boundary | Limit | Source outcome |
| --- | ---: | --- |
| Input bytes | `maxBytes = 1536000` | `WORKFLOW_TOO_LARGE` |
| Syntax nodes | `maxSyntaxNodes = 250000` | `WORKFLOW_TOO_COMPLEX` |
| Document depth | `maxDocumentDepth = 256` (also bounded by parser safety depth) | `WORKFLOW_TOO_COMPLEX` |
| Members/elements | `maxMembersAndElements = 250000` | `WORKFLOW_TOO_COMPLEX` |
| Source work | `maxSourceWork = 1000000`, charged as the sum of parsed context depths | `WORKFLOW_TOO_COMPLEX` / `SOURCE_WORK_LIMIT` |
| Duplicate keys | `maxDuplicateKeys = 1000` | `WORKFLOW_TOO_COMPLEX` when the reserved ambiguity budget is exhausted |
| Workflow nodes | `maxNodes = 5000` | `WORKFLOW_TOO_COMPLEX` |
| Raw edges examined | `maxRawEdges = 50000` | `WORKFLOW_TOO_COMPLEX` |
| Retained edges | `maxEdges = 10000` | `WORKFLOW_TOO_COMPLEX` |
| Connection-object nesting depth | `maxConnectionDepth = 64` | `WORKFLOW_TOO_COMPLEX` |
| Parameter depth | `maxParameterDepth = 64` | `WORKFLOW_TOO_COMPLEX` |
| Parameter leaves | `maxParameterLeaves = 10000` | `WORKFLOW_TOO_COMPLEX` |
| Stored spans | `maxStoredSourceSpans = 25000` | Omit optional spans with an explicit diagnostic; required identity loss is indeterminate |

All other v2 limits, including diagnostics, expression/code syntax, graph operations, taint states,
trace steps, findings, evidence, redaction, serialization, and rule operations, are listed in
[contracts-v2.md](contracts-v2.md) and the canonical
[`scanner-limits-v2.ts`](../../contracts/scanner-limits-v2.ts) contract. Each limit's admitted state
(`WIRED`, `DORMANT`, or `UNWIRED`) and whether it has a per-scan usage row are declared once there —
in `ADMITTED_LIMIT_STATES` and `MEASURED_LIMIT_IDS` — and are not restated per surface. A source
budget failure is not a partial clean scan.

## Unknown and indeterminate outcomes

Normalization reports explicit uncertainty instead of treating absence as safety:

- a readable node with no matching semantic catalogue record resolves to the conservative generic
  fallback ([`generic-fallback.ts`](../../packages/scanner-core/src/semantics/generic-fallback.ts),
  [ADR](../decisions/ADR-generic-node-semantic-fallback.md)) and emits both
  `SEMANTIC_CATALOGUE_MISS` (no admitted record) and `GENERIC_NODE_UNMODELED_CAPABILITY`
  (unmodelled-capability assumption; destinations unknown, not audited-and-empty) at degraded
  requiredness once per fallback node, so the workflow is graded `DEGRADED` while the assumption
  stays labelled; a genuinely unresolved node keeps only the miss at the caller's requiredness (a
  required miss is `INDETERMINATE`/`assessment:null`, an optional miss is `DEGRADED`/eligible and
  does not null the assessment by itself), and an unreadable node `type` refuses the scan
  with `SEMANTIC_CATALOGUE_INVALID`.
- missing target facts remain `UNKNOWN` and are not inferred from workflow shape;
- unknown or dynamic parameter values remain unknown in downstream evidence; and
- `AMBIGUOUS`, `UNRESOLVED`, malformed, or security-duplicate graph inputs cannot support a
  complete reachability, dominance, sanitization, or approval claim.

`COMPLETE` is reserved for a result with no non-`NONE` diagnostic and no omitted required work.
`DEGRADED` means safe optional/report-only loss. `INDETERMINATE` means required evidence may be
missing or contradictory; its result has `assessment: null` and no reassuring summary. See
[`analysis-completeness.ts`](../../packages/scanner-core/src/result/analysis-completeness.ts),
[contracts-v2.md](contracts-v2.md), and the
[v2 result contract](../../openspec/changes/world-class-scanner-cli/result-v2-contract.md).

## Non-claims

Normalization proves only bounded, deterministic interpretation of submitted bytes. It does not
prove that a branch executes, that a URL is reachable, that a credential is valid, that a host is
patched, or that a workflow is safe. No source snippet, secret, raw lexeme, or exception text is
serialized as scanner truth.
