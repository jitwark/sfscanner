import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const DRAFT_2020_12 = 'https://json-schema.org/draft/2020-12/schema';
const SARIF_SCHEMA_URI = 'https://json.schemastore.org/sarif-2.1.0.json';
const DEFAULT_SCHEMA_DIRECTORY = fileURLToPath(new URL('../pipeline/cli/schemas/', import.meta.url));

export const SCHEMA_ARTIFACT_SPECS = Object.freeze([
  {
    fileName: 'scanner-cli-v1.schema.json', id: 'urn:n8n-secureflow:scanner-cli-v1',
    title: 'n8n Scan CLI scanner-cli-v1 output', required: ['schemaVersion', 'results', 'summary'],
    properties: ['schemaVersion', 'results', 'summary'], propertyConsts: { schemaVersion: 'scanner-cli-v1' },
    defs: ['nonEmptyString', 'safeInteger', 'textList', 'position', 'sourceSpan', 'location', 'diagnostic', 'workflow', 'functionSummary', 'integration', 'finding', 'riskAssessment', 'humanSummary', 'resultSummary', 'scanResult', 'error', 'resultItem', 'envelopeSummary'],
  },
  {
    fileName: 'emitted-sarif-2.1.0-profile.schema.json', id: 'urn:n8n-secureflow:emitted-sarif-2.1.0-profile',
    title: 'n8n SecureFlow CLI emitted SARIF 2.1.0 profile', required: ['$schema', 'version', 'runs'],
    properties: ['$schema', 'version', 'runs'], propertyConsts: { $schema: SARIF_SCHEMA_URI, version: '2.1.0' },
    defs: ['nonEmptyString', 'run', 'tool', 'driver', 'rule', 'result', 'textMessage', 'location', 'physicalLocation', 'region', 'invocation', 'notification'],
    sarifDisclaimer: 'not a complete external SARIF 2.1.0 conformance schema',
  },
]);

const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const sameSequence = (actual, expected) => Array.isArray(actual) && actual.length === expected.length && actual.every((value, index) => value === expected[index]);
const add = (errors, fileName, message) => errors.push(`${fileName}: ${message}`);

function validateReferences(value, fileName, expectedDefs, errors, path = '$') {
  if (Array.isArray(value)) return value.forEach((item, index) => validateReferences(item, fileName, expectedDefs, errors, `${path}[${index}]`));
  if (!isObject(value)) return;
  for (const [key, child] of Object.entries(value)) {
    const childPath = `${path}.${key}`;
    if (key === '$ref') {
      if (typeof child !== 'string' || !child.startsWith('#/$defs/')) add(errors, fileName, `${childPath} must be a local #/$defs/... reference; external or malformed $refs are forbidden.`);
      else {
        const target = child.slice('#/$defs/'.length);
        if (!expectedDefs.includes(target) || target.includes('/')) add(errors, fileName, `${childPath} points to undeclared $ref target ${child}.`);
      }
    }
    validateReferences(child, fileName, expectedDefs, errors, childPath);
  }
}

function validateArtifact(value, spec, errors) {
  const fileName = spec.fileName;
  if (!isObject(value)) return add(errors, fileName, 'root must be an object.');
  if (value.$schema !== DRAFT_2020_12) add(errors, fileName, 'must declare Draft 2020-12 in $schema.');
  if (value.$id !== spec.id) add(errors, fileName, `must use the stable $id ${spec.id}.`);
  if (value.title !== spec.title) add(errors, fileName, `must use the stable title ${spec.title}.`);
  if (value.type !== 'object') add(errors, fileName, 'root type must be object.');
  if (value.additionalProperties !== false) add(errors, fileName, 'root additionalProperties must be false.');
  if (!sameSequence(value.required, spec.required)) add(errors, fileName, `required top-level fields must be exactly ${JSON.stringify(spec.required)}.`);
  if (!isObject(value.properties)) add(errors, fileName, 'properties must be an object.');
  else {
    if (!sameSequence(Object.keys(value.properties), spec.properties)) add(errors, fileName, `top-level property keys must be exactly ${JSON.stringify(spec.properties)}.`);
    for (const [key, expected] of Object.entries(spec.propertyConsts)) if (!isObject(value.properties[key]) || value.properties[key].const !== expected) add(errors, fileName, `properties.${key}.const must be ${expected}.`);
  }
  if (!isObject(value.$defs)) add(errors, fileName, '$defs must be an object.');
  else if (!sameSequence(Object.keys(value.$defs), spec.defs)) add(errors, fileName, `$defs keys must be exactly ${JSON.stringify(spec.defs)}.`);
  if (spec.sarifDisclaimer) {
    if (typeof value.description !== 'string' || !value.description.toLowerCase().includes(spec.sarifDisclaimer.toLowerCase())) add(errors, fileName, 'description must explicitly disclaim complete external SARIF conformance.');
  } else if (typeof value.description !== 'string' || value.description.length === 0) add(errors, fileName, 'description must be a non-empty string.');
  validateReferences(value, fileName, spec.defs, errors);
}

export function parseSchemaDocuments(sources) {
  const documents = {};
  const errors = [];
  for (const spec of SCHEMA_ARTIFACT_SPECS) {
    if (!isObject(sources) || !hasOwn(sources, spec.fileName)) { add(errors, spec.fileName, 'JSON source is missing.'); continue; }
    if (typeof sources[spec.fileName] !== 'string') { add(errors, spec.fileName, 'JSON source must be text.'); continue; }
    try { documents[spec.fileName] = JSON.parse(sources[spec.fileName]); }
    catch (error) { add(errors, spec.fileName, `malformed JSON (${error instanceof Error ? error.message : String(error)}).`); }
  }
  return { documents, errors };
}

export function validateSchemaArtifacts(documents) {
  const errors = [];
  for (const spec of SCHEMA_ARTIFACT_SPECS) {
    if (!isObject(documents) || !hasOwn(documents, spec.fileName)) add(errors, spec.fileName, 'parsed artifact is missing.');
    else validateArtifact(documents[spec.fileName], spec, errors);
  }
  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

export async function checkCliSchemaFiles(schemaDirectory = DEFAULT_SCHEMA_DIRECTORY) {
  const sources = {};
  const readErrors = [];
  for (const spec of SCHEMA_ARTIFACT_SPECS) {
    try { sources[spec.fileName] = await readFile(resolve(schemaDirectory, spec.fileName), 'utf8'); }
    catch (error) { add(readErrors, spec.fileName, `could not read JSON artifact (${error instanceof Error ? error.message : String(error)}).`); }
  }
  const parsed = parseSchemaDocuments(sources);
  const validation = validateSchemaArtifacts(parsed.documents);
  const errors = [...readErrors, ...parsed.errors, ...(validation.ok ? [] : validation.errors)];
  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

export function formatSchemaErrors(result) {
  return result.ok ? 'CLI schema artifacts are valid.' : `CLI schema artifact validation failed:\n${result.errors.join('\n')}`;
}

async function main() {
  const result = await checkCliSchemaFiles();
  if (!result.ok) { console.error(formatSchemaErrors(result)); process.exitCode = 1; return; }
  console.log(formatSchemaErrors(result));
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (invokedPath === import.meta.url) await main();
