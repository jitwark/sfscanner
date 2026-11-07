import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '../..');
const text = (source, name, open = '\\[', close = '\\](?:\\s+as const[^;]*;|;)') => {
  const match = source.match(new RegExp(`(?:export const )?${name}[^=]*=\\s*${open}([\\s\\S]*?)${close}`));
  if (!match) throw new Error(`Unable to read ${name}`);
  return match[1];
};

const strings = (source) => [...source.matchAll(/['"]([^'"]+)['"]/g)].map((match) => match[1]);

function parseRules(source, factory, effect, block) {
  const rules = [];
  // The factory's trailing arguments (`cweIds`, and `owaspAgenticIds` for report-only rules) are
  // not part of the rendered reference, so the pattern reads the four metadata arguments and lets
  // any mapping arguments follow before the closing parenthesis.
  const pattern = new RegExp(
    `${factory}\\(\\s*'([^']+)'\\s*,\\s*'([^']+)'\\s*,\\s*'([^']+)'\\s*,\\s*'([^']+)'\\s*(?:,[^)]*)?\\)`,
    'g',
  );
  for (const match of block.matchAll(pattern)) {
    rules.push({
      policyId: match[1], defaultSeverity: match[2], defaultConfidence: match[3],
      precision: match[4], policyEffect: effect,
    });
  }
  if (rules.length === 0) throw new Error(`Unable to read ${factory} entries`);
  return rules;
}

export function parseRuleCatalog(source) {
  const defaults = parseRules(source, 'betaRule', 'LEGACY_SCORE', text(source, 'betaDefaultRuleCatalog'));
  const hardened = parseRules(source, 'reportOnlyRule', 'REPORT_ONLY', text(source, 'betaHardenedRuleCatalog'));
  return {
    profiles: {
      'beta-default': defaults,
      'beta-hardened': [...defaults, ...hardened],
    },
  };
}

export function parseDiagnosticCodes(source) {
  return strings(text(source, 'ANALYSIS_DIAGNOSTIC_CODES'));
}

function valueFor(field, defaults, base, version) {
  if (field === 'schemaVersion') return version;
  const expression = defaults.match(new RegExp(`\\b${field}:\\s*([^,\\n]+)`))?.[1].trim();
  if (!expression) throw new Error(`Unable to read default limit ${field}`);
  const reference = expression.match(/^LIMITS\.(\w+)$/)?.[1];
  const raw = reference
    ? base.match(new RegExp(`\\b${reference}:\\s*([\\d_]+)`))?.[1]
    : expression.match(/^[\d_]+$/)?.[0];
  if (!raw) throw new Error(`Unable to resolve default limit ${field}`);
  return raw.replaceAll('_', '');
}

export function parseScannerLimits(source, baseSource) {
  const version = source.match(/SCANNER_LIMITS_SCHEMA_VERSION\s*=\s*'([^']+)'/)?.[1];
  if (!version) throw new Error('Unable to read scanner limits schema version');
  const fields = strings(text(source, 'SCANNER_LIMITS_FIELDS'));
  const defaults = source.match(/DEFAULT_SCANNER_LIMITS[^=]*=\s*Object\.freeze\(\{([\s\S]*?)\}\);/)?.[1];
  if (!defaults) throw new Error('Unable to read DEFAULT_SCANNER_LIMITS');
  return {
    schemaVersion: version,
    fields,
    defaults: Object.fromEntries(fields.map((field) => [field, valueFor(field, defaults, baseSource, version)])),
  };
}

export function loadScannerDocs(root = ROOT) {
  const read = (file) => readFileSync(resolve(root, file), 'utf8');
  // Both vocabularies are projected from scanner-core, their only declaration site: the rule
  // catalog and the v1 diagnostic code list. The app-local copies were deleted in packet 5.2c,
  // so the generated reference cannot describe a catalog the scanner does not run.
  const catalogueSource = read('packages/scanner-core/src/policy/rule-catalog.ts');
  const diagnosticSource = read('packages/scanner-core/src/policy/policy.ts');
  const limitsSource = read('contracts/scanner-limits.ts');
  const baseLimitsSource = read('contracts/limits.ts');
  return {
    catalogue: parseRuleCatalog(catalogueSource),
    diagnosticCodes: parseDiagnosticCodes(diagnosticSource),
    limits: parseScannerLimits(limitsSource, baseLimitsSource),
    policyInventory: read('docs/scanner/policy-inventory.md'),
    ruleReference: read('docs/scanner/rule-reference.md'),
  };
}

function inventoryPolicyIds(inventory) {
  return [...inventory.matchAll(/^\|\s*(?:Both|Hardened)\s*\|\s*`([A-Z][A-Z0-9_]+)`\s*\|/gm)].map((m) => m[1]);
}

function inventoryProfileCounts(inventory) {
  return Object.fromEntries([...inventory.matchAll(/^\|\s*`(beta-(?:default|hardened))`\s*\|\s*(\d+)\s*\|/gm)]
    .map((m) => [m[1], Number(m[2])]));
}

const hasToken = (source, token) => source.includes(`\`${token}\``);

export function renderRuleReference(catalogue, diagnosticCodes, limits) {
  const defaults = catalogue.profiles['beta-default'];
  const hardened = catalogue.profiles['beta-hardened'];
  const defaultIds = new Set(defaults.map((rule) => rule.policyId));
  const rows = hardened.map((rule) => `| ${defaultIds.has(rule.policyId) ? 'Both' : 'Hardened'} | \`${rule.policyId}\` | \`${rule.policyEffect}\` | ${rule.defaultSeverity} | ${rule.defaultConfidence} | ${rule.precision} |`);
  const limitRows = limits.fields.map((field) => `| \`${field}\` | ${field === 'schemaVersion' ? `\`${limits.schemaVersion}\`` : limits.defaults[field]} |`);
  return `# Scanner rule reference

<!-- Generated by scripts/check-scanner-doc-consistency.mjs; do not edit manually. -->

This compact reference contains only metadata owned by the runtime catalogue and contracts. Full
threat, evidence, remediation, completeness, and false-positive guidance remains in the
[policy inventory](policy-inventory.md).

<!-- scanner-docs:version -->
## Versioning

- Policy implementation version: \`scanner-beta-1\`.
- Limits contract schema: \`${limits.schemaVersion}\`.
- This file is regenerated/parity-checked when those source contracts change.

<!-- scanner-docs:limits -->
## Limits

The shared scanner limits contract has these fields and current defaults:

| Field | Default |
| --- | ---: |
${limitRows.join('\n')}

<!-- scanner-docs:privacy -->
## Privacy and residual host assumptions

The scanner processes pasted workflow content locally in a browser Worker; it does not upload the
workflow or make a network request with its content. Findings are redacted before presentation,
but redaction is pattern-based and is not a guarantee that every secret or personal datum is found.
The browser, extensions, host, memory, cache, and ordinary static-site traffic remain outside this
scanner guarantee.

<!-- scanner-docs:sarif -->
## Result formats

JSON is the scanner result contract. The report adapter emits SARIF \`2.1.0\`; SARIF rules and
results carry the policy ID and policy effect, while finding results also carry severity and
confidence. Report-only findings do not change the risk grade.

## Profiles and catalogue metadata

| Profile | Policy count |
| --- | ---: |
| \`beta-default\` | ${defaults.length} |
| \`beta-hardened\` | ${hardened.length} |

| Profiles | Policy ID | Effect | Default severity | Default confidence | Precision |
| --- | --- | --- | --- | --- | --- |
${rows.join('\n')}

## Completeness and diagnostics

\`COMPLETE\` means no known diagnostic was emitted. \`DEGRADED\` and \`INDETERMINATE\` statuses
are documented in the policy inventory; diagnostic IDs are kept there in parity with the runtime
vocabulary:

${diagnosticCodes.map((code) => `- \`${code}\``).join('\n')}
`;
}

export function auditScannerDocs(input) {
  const errors = [];
  const expected = input.catalogue.profiles['beta-hardened'].map((rule) => rule.policyId);
  const documented = inventoryPolicyIds(input.policyInventory);
  const expectedSet = new Set(expected);
  const documentedSet = new Set(documented);
  for (const id of [...expectedSet].filter((value) => !documentedSet.has(value)).sort()) errors.push(`policy inventory is missing policy ID: ${id}`);
  for (const id of [...documentedSet].filter((value) => !expectedSet.has(value)).sort()) errors.push(`policy inventory has extra policy ID: ${id}`);
  for (const id of [...documentedSet].filter((value) => documented.filter((item) => item === value).length > 1).sort()) errors.push(`policy inventory repeats policy ID: ${id}`);

  const counts = inventoryProfileCounts(input.policyInventory);
  for (const [profile, rules] of Object.entries(input.catalogue.profiles)) {
    if (!(profile in counts)) errors.push(`policy inventory is missing profile count: ${profile}`);
    else if (counts[profile] !== rules.length) errors.push(`profile ${profile} documents ${counts[profile]} policies; runtime catalogue has ${rules.length}`);
  }
  for (const code of input.diagnosticCodes) if (!hasToken(input.policyInventory, code)) errors.push(`policy inventory is missing diagnostic ID: ${code}`);

  for (const [name, marker] of [['limits', 'scanner-docs:limits'], ['privacy', 'scanner-docs:privacy'], ['SARIF', 'scanner-docs:sarif'], ['version', 'scanner-docs:version']]) {
    if (!input.ruleReference.includes(`<!-- ${marker} -->`)) errors.push(`rule reference is missing ${name} anchor`);
  }
  const generated = renderRuleReference(input.catalogue, input.diagnosticCodes, input.limits);
  if (input.ruleReference !== generated) errors.push('rule reference does not match generated runtime metadata');
  return { errors, generated };
}
