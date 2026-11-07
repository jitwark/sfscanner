# Scanner false-positive review (SCAN-5)

Reviewed 2026-08-13 against all 18,319 workflows in `D:/projects/n8n-vault-core/templates/`.
Harness: `pipeline/validate-scanner.ts`. Raw reports land in `pipeline/.work/` (gitignored);
this file is the committed record of what was found and what changed.

## Why this review existed

The scanner had never been run outside its own unit tests. The first corpus run graded
**47.2% of real community workflows CRITICAL**. A grade that fires on half the corpus tells a user
nothing, and publishing it next to 15,000 catalogue entries would have made the whole library look
either broken or alarmist. Every correction below is a severity or evidence change. No policy was
deleted, and no genuinely dangerous pattern was made quieter.

## Corpus baseline

| Measure | Value |
| --- | --- |
| Files scanned | 18,319 |
| Parse failures | 8 (`MALFORMED_WORKFLOW`, 0.04%) |
| Crashes | 0, both profiles |
| Scan duration | p50 0.85 ms · p95 2.58 ms · max 90 ms |

The engine itself is sound: it is fast, and it does not fall over on real-world input.
The defects were all in severity calibration and in scoring.

## Findings reviewed and corrected

### 1. `UNKNOWN_NODE_PACKAGE` — 36,581 fires (2.0 per workflow)

**False positive.** The policy flagged any node type not starting with `n8n-nodes-base.`, which
includes `@n8n/n8n-nodes-langchain.*` — nodes that ship with n8n itself. It also fired once per
node instance, so a workflow using one community package eight times looked like eight risks.

Fix: official namespaces (`n8n-nodes-base.`, `@n8n/`) are excluded; remaining third-party packages
produce **one finding per distinct package**; severity `MEDIUM` to `LOW`, because an installed
community node is a provenance fact, not a defect.

Result: 36,581 to **1,793 fires** (-95%).

### 2. `N8N_CODE_NODE` — 19,887 fires (1.1 per workflow), severity HIGH

**Severity error.** The presence of a Code node is workflow anatomy. Rating it HIGH meant any
workflow doing data transformation — most of them — inherited a high-severity finding. The genuinely
risky code patterns are already reported with evidence by the JavaScript, Python, and taint
policies.

Fix: `HIGH` to `LOW`. Count unchanged; it is still reported on every Code node.

### 3. `RAW_SECRET_INDICATOR` — 5,317 fires (29.0%), severity HIGH

**Partly false positive.** The policy emitted HIGH on a *key name* alone. A parameter named `token`
holding `{{ $json.token }}` — the correct way to write an n8n workflow — scored the same as a pasted
API key.

Fix: three evidence levels, three severities.

| Evidence | Severity |
| --- | --- |
| Value matches a provider secret pattern (`sensitive_value`) | HIGH |
| Secret-named key holding an unclassified literal | MEDIUM |
| Secret-named key holding a structure | LOW |
| Secret-named key holding an expression or placeholder | suppressed entirely |

Suppression covers n8n expressions (`{{ }}`, `${ }`, `=`-prefixed), `$json`/`$env`/`$credentials`
references, masked values (`****`), bracketed placeholders (`<your-password>`, `[API_KEY]`), and
`YOUR_API_KEY`-style prose. A classified value also suppresses the key-level finding at the same
path, so one secret is reported once.

Result: 5,317 to **4,137 fires**, and the remainder is graded by evidence rather than by key name.

### 4. `RAW_AUTH_HEADER` — 2,155 fires (11.8%), severity HIGH

**False positive.** Fired on any node defining an Authorization header, including
`Authorization: {{ "Bearer " + $credentials.token }}` — which is the recommended pattern.

Fix: severity now depends on whether a **literal** backs the header. A pasted token stays HIGH; an
expression-driven header is reported at INFO with the title "Authorization header is set from an
expression". Both n8n header shapes (`{ Authorization: v }` and `{ name, value }`) are handled.

### 5. Risk score model — the actual cause of the CRITICAL flood

**Design defect, not a policy defect.** The score was a plain sum of severity weights capped at 100.
Ten Code nodes at HIGH (35 each) reached the CRITICAL threshold (80) by themselves, with no
security-relevant finding involved.

Fix: repeat occurrences of the *same policy* are one risk observed many times. The first occurrence
contributes its full weight, each additional occurrence a quarter of it, capped at twice the first.
Different policies still add independently, so a workflow with several distinct real problems still
grades high.

## Outcome

| Grade | Before | After |
| --- | --- | --- |
| CRITICAL | 47.2% | **3.1%** |
| HIGH | 9.3% | **4.7%** |
| MEDIUM | 13.4% | **43.4%** |
| LOW | 30.2% | **48.8%** |

7.8% of the corpus now carries a HIGH or CRITICAL grade, which is a number a user can act on.

## Regression coverage

`app/src/scanner/false-positive-regression.test.ts` pins every correction, each paired with a
positive case so a fix cannot silently become a blind spot:

- expression-valued and placeholder-valued secret parameters produce no finding; a provider-shaped
  key still reports HIGH;
- an expression-driven Authorization header reports INFO; a pasted bearer token still reports HIGH;
- `@n8n/n8n-nodes-langchain.*` produces no finding; third-party packages report once each;
- twenty Code nodes do not reach HIGH or CRITICAL; a workflow with a shell command, a pasted key,
  and an unauthenticated webhook still grades CRITICAL.

Full app suite after the change: **401 tests green**.

## Note on the two profiles

`beta-default` and `beta-hardened` produce identical grades on every corpus workflow. That is by
design: hardened policies are `REPORT_ONLY` and add findings (taint analysis, AI-agent gating)
without contributing to the score. The catalogue therefore stores the default grade plus a
`hardenedExtra` count. Anyone reading a scan should understand "hardened" as *more detail*, not
*a stricter grade*.
