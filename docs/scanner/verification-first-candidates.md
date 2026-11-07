# Verification-first candidates

These are known gaps, not implemented behavior. Each row names a claim that a reviewer might expect
the scanner to make and the evidence that a future implementation must supply before it becomes a
shipped requirement. None of them is admitted today: no policy, pattern, analyzer, or profile was
added for this document, and `beta-hardened` stays defined but not admitted.

| ID | Claim | Why it is not implemented | Admission evidence required |
| --- | --- | --- | --- |
| C-064 | Official-namespace masquerade | `UNKNOWN_NODE_PACKAGE` is a prefix rule over `n8n-nodes-base.` and `@n8n/`, so it reports a lookalike type as official. A prefix check cannot prove authenticity. | A pinned official-node registry with a recorded source and digest, a lookalike fixture that fails today, and no prefix heuristic in the rule. |
| C-065 | LangChain tool sinks for taint | The sink map is not source-pinned for LangChain tool nodes, so a taint path into a tool call is not claimed. | A pinned node description for the exact version, a sink fact in the safe-fact registry, and a taint fixture that reaches the sink through the graph. |
| C-070 | Encoded token detection | Encoding classes are unbounded, and blind decoding of arbitrary strings risks false positives on ordinary data. | Accepted encoding classes, positive and near-miss canaries, decoder size/depth bounds, and a redaction path that never emits decoded material. |
| C-074 | Broader JavaScript indicators | No reproducible false-negative fixture exists for the wider API set, so the catalog stays at its selected syntax and API surface. | A fixture that fails today, the rule ID and indicator name it would add, its redaction behavior, and an independent reviewer's precision check. |
| C-075 | Broader Python indicators | Same reason: `python-analysis.ts` recognizes dynamic execution and `subprocess`/`os` process primitives only. | Same evidence as C-074, plus a Python environment/credential-read fixture (`os.environ.get`) and its expected indicator. |

A candidate becomes a requirement only after that evidence exists and a reviewer accepts it. Until
then the conservative behavior is pinned by
[`verification-first-candidates.test.ts`](../../packages/scanner-core/src/policies/verification-first-candidates.test.ts),
which asserts both the missing indicators and the indicators that do work, so a silent behavior
change fails the suite instead of shipping as an unannounced fix.
