import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { extname, relative, resolve } from 'node:path';

export const GENERATED_DOCS = ['rules.md', 'diagnostics.md', 'limits.md', 'schemas.md', 'cli.md', 'examples.md'];
export const REFERENCE_SCHEMA_VERSION = 'scanner-reference-v1';
const FIXED = {
  rules: ['packages/scanner-core/src/policy/rule-catalog.ts', 'packages/scanner-core/src/v2/admitted-registry.ts', 'packages/scanner-core/src/facts/safe-fact-registry.ts'],
  diagnostics: ['packages/scanner-core/src/diagnostics/registry.ts'],
  limits: ['contracts/scanner-limits-v2.ts', 'contracts/scanner-limits.ts', 'contracts/limits.ts'],
  cli: ['packages/scanner-cli/src/v2/help.ts', 'packages/scanner-cli/src/v2/arguments.ts', 'packages/scanner-cli/src/v2/exit-reducer.ts'],
};
const text = (root, path) => {
  try { return readFileSync(resolve(root, path), 'utf8').replaceAll('\r\n', '\n').replaceAll('\r', '\n'); }
  catch { throw new Error(`Missing scanner reference source: ${path}`); }
};
const block = (source, name, pattern = `(?:export )?const ${name}[^=]*=\\s*`) => {
  const match = source.match(new RegExp(pattern));
  if (!match || match.index === undefined) throw new Error(`Unable to read ${name}`);
  const rest = source.slice(match.index + match[0].length);
  const open = rest.search(/[\[{]/);
  if (open < 0) throw new Error(`Unable to read ${name}`);
  const stack = [rest[open]];
  const pairs = { '[': ']', '{': '}' };
  for (let index = open + 1; index < rest.length; index += 1) {
    if (rest[index] === '[' || rest[index] === '{') stack.push(rest[index]);
    else if (rest[index] === ']' || rest[index] === '}') {
      if (rest[index] !== pairs[stack.at(-1)]) throw new Error(`Malformed ${name}`);
      stack.pop();
      if (stack.length === 0) return rest.slice(open + 1, index);
    }
  }
  throw new Error(`Unable to read ${name}`);
};
const digest = (value) => createHash('sha256').update(value, 'utf8').digest('hex');
export const computeSourceDigest = (entries) => digest(entries.map(({ path, source }) => `${path}\n${source}`).join('\n'));
const sourceDigest = computeSourceDigest;
const strings = (source) => [...source.matchAll(/['"]([^'"]+)['"]/g)].map((match) => match[1]);
const entriesFor = (root, paths) => paths.map((path) => ({ path, source: text(root, path), digest: digest(text(root, path)) }));
const compare = (left, right) => left === right ? 0 : left < right ? -1 : 1;
const required = (value, label) => { if (!value) throw new Error(`Missing scanner reference source data: ${label}`); return value; };
const csvStrings = (source) => strings(source).filter((value) => !value.includes('\\'));
function parseRules(source, mappingSource) {
  const parse = (name, effect, body) => {
    const rows = [];
    const pattern = new RegExp(`${name}\\(\\s*'([^']+)'\\s*,\\s*'([^']+)'\\s*,\\s*'([^']+)'\\s*,\\s*'([^']+)'\\s*,\\s*\\[([^\\]]*)\\](?:\\s*,\\s*\\[([^\\]]*)\\])?\\s*\\)`, 'g');
    for (const match of body.matchAll(pattern)) rows.push({ policyId: match[1], severity: match[2], confidence: match[3], precision: match[4], effect, cwe: csvStrings(match[5]), owasp: csvStrings(match[6] ?? '') });
    return rows;
  };
  const defaults = parse('betaRule', 'SCORING', required(block(source, 'betaDefaultRuleCatalog'), 'beta rules'));
  const hardened = parse('reportOnlyRule', 'REPORT_ONLY', required(block(source, 'betaHardenedRuleCatalog'), 'hardened rules'));
  const mappings = new Map([...mappingSource.matchAll(/mapping\(\s*'([^']+)'\s*,\s*'([^']+)'/g)].map((match) => [match[1], match[2]]));
  if (!defaults.length || !hardened.length || mappings.size === 0) throw new Error('Rule catalogue is empty');
  const declaredIds = [...defaults, ...hardened].map(({ policyId }) => policyId);
  if (new Set(declaredIds).size !== declaredIds.length) throw new Error('Rule catalogue contains duplicate IDs');
  const mapped = (row, profiles) => {
    const capability = mappings.get(row.policyId);
    if (!capability) throw new Error(`Missing v2 rule mapping: ${row.policyId}`);
    return { ...row, capability, effect: capability === 'structural-policies' ? 'SCORING' : 'REPORT_ONLY', profiles };
  };
  const byId = new Map(defaults.map((row) => [row.policyId, mapped(row, ['beta-default', 'beta-hardened'])]));
  for (const row of hardened) {
    const prior = byId.get(row.policyId);
    byId.set(row.policyId, mapped(row, prior ? prior.profiles : ['beta-hardened']));
  }
  return [...byId.values()].sort((left, right) => compare(left.policyId, right.policyId));
}

function parseDiagnostics(source) {
  const rows = [];
  const pattern = /row\(\s*'([^']+)'\s*,\s*'([^']+)'\s*,\s*'([^']+)'\s*,\s*([^,]+)\s*,\s*(null|'[^']*')\s*,\s*'([^']+)'\s*\)/g;
  for (const match of source.matchAll(pattern)) rows.push({ code: match[1], category: match[2], aggregateEffect: match[3], assessmentEligible: match[4].trim().replaceAll("'", ''), v1Code: match[5] === 'null' ? null : match[5].slice(1, -1), v1Projection: match[6] });
  if (rows.length === 0) throw new Error('Diagnostic registry is empty');
  if (new Set(rows.map(({ code }) => code)).size !== rows.length) throw new Error('Diagnostic registry contains duplicate codes');
  return rows.sort((left, right) => compare(left.code, right.code));
}

function objectValues(source, declaration) {
  const match = source.match(new RegExp(`${declaration}[^=]*=\\s*(?:Object\\.freeze\\(\\{)?([\\s\\S]*?)(?:\\}\\);|\\}\\s*as const;)`));
  return required(match?.[1], declaration);
}
function fieldMap(source, declaration) {
  const values = {};
  for (const match of objectValues(source, declaration).matchAll(/^\s*([A-Za-z][A-Za-z0-9]*):\s*([^,\n]+)/gm)) values[match[1]] = match[2].trim();
  return values;
}
function parseLimits(v2, v1, base) {
  const fields = csvStrings(required(block(v2, 'SCANNER_LIMITS_V2_NUMERIC_FIELDS'), 'v2 limits fields'));
  if (!fields.length || new Set(fields).size !== fields.length) throw new Error('Scanner limits fields are invalid');
  const versions = { schemaVersion: 'scanner-limits-v2' };
  const baseValues = fieldMap(base, 'LIMITS');
  const v1Values = fieldMap(v1, 'DEFAULT_SCANNER_LIMITS');
  for (const [name, expression] of Object.entries(v1Values)) {
    const ref = expression.match(/^LIMITS\.(\w+)$/)?.[1];
    if (ref) v1Values[name] = baseValues[ref];
  }
  const defaults = { ...v1Values, ...fieldMap(v2, 'DEFAULT_SCANNER_LIMITS') };
  for (const field of fields) {
    const expression = defaults[field];
    const reference = expression?.match(/^DEFAULT_SCANNER_LIMITS\.(\w+)$/)?.[1];
    const value = reference ? v1Values[reference] : expression?.replaceAll('_', '');
    if (!value || !/^\d+$/.test(value)) throw new Error(`Invalid scanner limit: ${field}`);
    versions[field] = Number(value);
  }
  return { fields: ['schemaVersion', ...fields], defaults: versions };
}

function parseCli(help, args, exits) {
  const list = (name) => csvStrings(required(block(help, name), name));
  const commands = list('V2_COMMANDS');
  if (!commands.length || new Set(commands).size !== commands.length) throw new Error('CLI command registry is invalid');
  const optionDetails = [...help.matchAll(/\{\s*name:\s*'(--[a-z][a-z0-9-]*)'\s*,\s*value:\s*'([^']*)'\s*,\s*commands:\s*([^,]+),\s*description:\s*'([^']*)'(?:,\s*default:\s*'([^']*)')?/g)].map((match) => ({ name: match[1], value: match[2], description: match[4], default: match[5] }));
  if (!optionDetails.length || new Set(optionDetails.map(({ name }) => name)).size !== optionDetails.length) throw new Error('CLI option registry is invalid');
  const options = optionDetails.map(({ name }) => name).sort(compare);
  const limits = [...new Set([...required(block(help, 'V2_LIMITS'), 'V2_LIMITS').matchAll(/^\s*([a-z][A-Za-z0-9]+):/gm)].map((match) => match[1]))].sort(compare);
  if (!limits.length) throw new Error('V2 limits registry is empty');
  const exitCodes = [...required(block(help, 'V2_EXIT_CODES'), 'V2_EXIT_CODES').matchAll(/\b\d+\b/g)].map((match) => Number(match[0])).sort((a, b) => a - b);
  if (!exitCodes.length || new Set(exitCodes).size !== exitCodes.length) throw new Error('V2 exit code registry is invalid');
  const exitReasons = list('V2_EXIT_REASONS').sort(compare);
  const claims = list('V2_CANONICAL_CLAIMS');
  const parserOptions = new Set([...args.matchAll(/'(--[a-z][a-z0-9-]*)'/g)].map((match) => match[1]));
  for (const option of options) if (option !== '--schema' && option !== '--help' && !parserOptions.has(option)) throw new Error(`CLI option is not parsed: ${option}`);
  const reducerCodes = [...exits.matchAll(/code:\s*(\d+)/g)].map((match) => Number(match[1]));
  if (JSON.stringify([...new Set(reducerCodes)].sort((a, b) => a - b)) !== JSON.stringify(exitCodes)) throw new Error('CLI exit code registry differs from reducer');
  const exitMapping = [...exits.matchAll(/([A-Z_]+):\s*Object\.freeze\(\{\s*reason:\s*'([^']+)'[^}]*code:\s*(\d+)/g)].map((match) => ({ key: match[1], reason: match[2], code: Number(match[3]) })).sort((left, right) => left.code - right.code || compare(left.key, right.key));
  return { commands, options, optionDetails, limits, exitCodes, exitReasons, exitMapping, claims };
}

function discoverExamples(root) {
  const output = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const full = resolve(directory, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (['.json', '.txt', '.mjs'].includes(extname(entry.name))) output.push(relative(root, full).replaceAll('\\', '/'));
    }
  };
  visit(resolve(root, 'examples'));
  return output.sort(compare).map((path) => ({ path, source: text(root, path), digest: digest(text(root, path)) }));
}

export function loadScannerReferenceSources(root) {
  const resolved = resolve(root);
  const sources = Object.fromEntries(Object.entries(FIXED).map(([name, paths]) => [name, entriesFor(resolved, paths)]));
  const rules = parseRules(sources.rules[0].source, sources.rules[2].source);
  const admitted = Object.fromEntries(['ADMITTED_ENGINE_ID', 'ADMITTED_ENGINE_VERSION', 'ADMITTED_PROFILE_ID', 'ADMITTED_PROFILE_VERSION', 'RULESET_ID_V2', 'RULESET_VERSION_V2'].map((name) => [name, required(sources.rules[1].source.match(new RegExp(`${name}\\s*=\\s*'([^']+)'`))?.[1], name)]));
  const diagnostics = parseDiagnostics(sources.diagnostics[0].source);
  const limits = parseLimits(sources.limits[0].source, sources.limits[1].source, sources.limits[2].source);
  const schemas = readdirSync(resolve(resolved, 'schemas')).filter((name) => name.endsWith('.schema.json')).sort(compare).map((name) => { const path = `schemas/${name}`; const source = text(resolved, path); const value = JSON.parse(source); if (!value.$id || !value.title || !value.type) throw new Error(`Invalid schema: ${path}`); return { path, source, digest: digest(source), value }; });
  if (!schemas.length) throw new Error('No scanner schemas found');
  const cli = parseCli(sources.cli[0].source, sources.cli[1].source, sources.cli[2].source);
  const examples = discoverExamples(resolved);
  if (!examples.length) throw new Error('No scanner examples found');
  sources.schemas = schemas.map(({ path, source, digest: value }) => ({ path, source, digest: value }));
  sources.examples = examples;
  return { docs: Object.fromEntries(GENERATED_DOCS.map((name) => [name, true])), sources, rules, admitted, diagnostics, limits, schemas, cli, examples };
}

const link = (path) => `[\`${path}\`](../../../${path})`;
const UNWIRED_REDACTION_LIMITS = Object.freeze(['maxRedactionPatches', 'maxRedactedArtifactBytes']);
const UNWIRED_REDACTION_NOTE = '`maxRedactionPatches` and `maxRedactedArtifactBytes` bound the redaction-v2 operation, which is development-only and unwired: no shipped path produces a redacted artifact, so these two defaults are inert contract fields.';
const sourceLines = (entries) => entries.map(({ path, digest: value }) => `- ${link(path)} — sha256 \`${value}\``).join('\n');
const header = (title, entries) => `# ${title}\n\n<!-- Generated by scripts/generate-scanner-reference.mjs; DO NOT EDIT. -->\n<!-- scanner-reference:version=${REFERENCE_SCHEMA_VERSION} -->\n<!-- scanner-reference:sources=${entries.map(({ path }) => path).join(',')} -->\n<!-- scanner-reference:digest=${sourceDigest(entries)} -->\n\n`;

function renderRules(model) {
  const rows = model.rules.map((row) => `| \`${row.policyId}\` | ${row.profiles.join(', ')} | ${row.effect} | ${row.capability} | ${row.severity} | ${row.confidence} | ${row.precision} | ${row.cwe.length ? row.cwe.join(', ') : '—'} |`);
  return `${header('Scanner v2 rules', model.sources.rules)}Runtime rule metadata only; v1 documentation and non-admitted profiles remain unchanged.\n\n## Authority\n- Engine: \`${model.admitted.ADMITTED_ENGINE_ID}@${model.admitted.ADMITTED_ENGINE_VERSION}\`\n- Admitted profile: \`${model.admitted.ADMITTED_PROFILE_ID}@${model.admitted.ADMITTED_PROFILE_VERSION}\`\n- Ruleset: \`${model.admitted.RULESET_ID_V2}@${model.admitted.RULESET_VERSION_V2}\`\n\n## Rules\n| Rule | Profiles | Effect | Capability | Severity | Confidence | Precision | CWE |\n| --- | --- | --- | --- | --- | --- | --- | --- |\n${rows.join('\n')}\n\n## Sources\n${sourceLines(model.sources.rules)}\n`;
}
function renderDiagnostics(model) {
  const rows = model.diagnostics.map((row) => `| \`${row.code}\` | ${row.category} | ${row.aggregateEffect} | ${row.assessmentEligible} | ${row.v1Code ? `\`${row.v1Code}\`` : '—'} | ${row.v1Projection} |`);
  return `${header('Scanner v2 diagnostics', model.sources.diagnostics)}The diagnostic vocabulary and v1 projection metadata are read from the runtime registry.\n\n| Code | Category | Aggregate effect | Assessment eligible | v1 code | Projection |\n| --- | --- | --- | --- | --- | --- |\n${rows.join('\n')}\n\n## Sources\n${sourceLines(model.sources.diagnostics)}\n`;
}
function renderLimits(model) {
  const rows = model.limits.fields.map((field) => `| \`${field}\` | ${model.limits.defaults[field]} |`);
  return `${header('Scanner v2 limits', model.sources.limits)}Defaults are the bounded scanner contract, not a throughput or availability promise.\n\n| Field | Default |\n| --- | ---: |\n${rows.join('\n')}\n\n${UNWIRED_REDACTION_NOTE}\n\n## Sources\n${sourceLines(model.sources.limits)}\n`;
}
function renderSchemas(model) {
  const sections = model.schemas.map(({ path, value }) => `### ${link(path)}\n- Title: ${value.title}\n- Schema ID: \`${value.$id}\`\n- Type: \`${value.type}\`\n- Required: ${(value.required ?? []).map((item) => `\`${item}\``).join(', ') || '—'}\n- Properties: ${Object.keys(value.properties ?? {}).sort(compare).map((item) => `\`${item}\``).join(', ') || '—'}`);
  return `${header('Scanner v2 schemas', model.sources.schemas)}The checked-in JSON Schemas are rendered as metadata; the JSON files remain authoritative.\n\n${sections.join('\n\n')}\n\n## Sources\n${sourceLines(model.sources.schemas)}\n`;
}
function renderCli(model) {
  const commandRows = model.cli.commands.map((name) => `| \`${name}\` | v2 command |`);
  const optionRows = model.cli.options.map((name) => { const option = model.cli.optionDetails.find((item) => item.name === name); return `| \`${name}\` | \`${option?.value ?? ''}\` | ${option?.description ?? 'supported v2 option'}${option?.default ? ` Default: ${option.default}.` : ''} |`; });
  const limitRows = model.cli.limits.map((name) => `| \`${name}\` | ${UNWIRED_REDACTION_LIMITS.includes(name) ? 'bounded default exposed by help; development-only, unwired redaction-v2 operation' : 'bounded default exposed by help'} |`);
  const exitRows = model.cli.exitCodes.map((code) => { const reasons = model.cli.exitMapping.filter((item) => item.code === code).map((item) => item.reason).join(', '); return `| \`${code}\` | ${reasons || 'documented v2 exit code'} |`; });
  return `${header('Scanner v2 CLI', model.sources.cli)}The CLI help, parser, and exit reducer are the runtime authority.\n\n## Commands\n| Command | Meaning |\n| --- | --- |\n${commandRows.join('\n')}\n\n## Options\n| Option | Syntax | Description |\n| --- | --- | --- |\n${optionRows.join('\n')}\n\n## Limits named by help\n| Limit | Meaning |\n| --- | --- |\n${limitRows.join('\n')}\n\n## Exit codes\n| Code | Meaning |\n| --- | --- |\n${exitRows.join('\n')}\n\n## Exit reasons\n${model.cli.exitReasons.map((reason) => `- \`${reason}\``).join('\n')}\n\n## Canonical claims\n${model.cli.claims.map((claim) => `- ${claim}`).join('\n')}\n\n## Sources\n${sourceLines(model.sources.cli)}\n`;
}
function renderExamples(model) {
  const sections = model.examples.map(({ path, source }) => { let body = source; if (path.endsWith('.json')) body = `${JSON.stringify(JSON.parse(source), null, 2)}\n`; if (path.endsWith('.mjs')) body = `sha256: ${digest(source)}\n`; return `### ${link(path)}\n\n\`\`\`${path.endsWith('.json') ? 'json' : 'text'}\n${body.trimEnd()}\n\`\`\``; });
  return `${header('Scanner v2 examples', model.sources.examples)}Examples are local synthetic fixtures and command references; they do not establish release, publication, or security approval.\n\n${sections.join('\n\n')}\n\n## Sources\n${sourceLines(model.sources.examples)}\n`;
}

export function renderScannerReference(model) {
  const output = { 'rules.md': renderRules(model), 'diagnostics.md': renderDiagnostics(model), 'limits.md': renderLimits(model), 'schemas.md': renderSchemas(model), 'cli.md': renderCli(model), 'examples.md': renderExamples(model) };
  for (const [name, value] of Object.entries(output)) { if (!value.endsWith('\n') || value.includes('\r') || /(?:[A-Z]:\\|\\\\|\/(?:Users|home|private|mnt)\b|(?:password|secret|token|api[_-]?key|credential|authorization|cookie|bearer)\s*[:=]\s*['"][^'"]+)/i.test(value)) throw new Error(`Unsafe generated output: ${name}`); }
  return output;
}
