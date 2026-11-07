import { describe, expect, it } from 'vitest';
import { parseSchemaDocuments, validateSchemaArtifacts } from './check-cli-schema-files.mjs';

const DRAFT = 'https://json-schema.org/draft/2020-12/schema';
const SCANNER_ID = 'urn:n8n-secureflow:scanner-cli-v1';
const SARIF_ID = 'urn:n8n-secureflow:emitted-sarif-2.1.0-profile';
const scannerDefs = ['nonEmptyString', 'safeInteger', 'textList', 'position', 'sourceSpan', 'location', 'diagnostic', 'workflow', 'functionSummary', 'integration', 'finding', 'riskAssessment', 'humanSummary', 'resultSummary', 'scanResult', 'error', 'resultItem', 'envelopeSummary'];
const sarifDefs = ['nonEmptyString', 'run', 'tool', 'driver', 'rule', 'result', 'textMessage', 'location', 'physicalLocation', 'region', 'invocation', 'notification'];
const definitions = (names) => Object.fromEntries(names.map((name) => [name, { type: 'object' }]));

function validArtifacts() {
  return {
    'scanner-cli-v1.schema.json': {
      $schema: DRAFT, $id: SCANNER_ID, title: 'n8n Scan CLI scanner-cli-v1 output', description: 'Versioned JSON envelope emitted by the local n8n Scan CLI.', type: 'object', additionalProperties: false,
      required: ['schemaVersion', 'results', 'summary'], properties: { schemaVersion: { const: 'scanner-cli-v1' }, results: { $ref: '#/$defs/resultItem' }, summary: { $ref: '#/$defs/envelopeSummary' } }, $defs: definitions(scannerDefs),
    },
    'emitted-sarif-2.1.0-profile.schema.json': {
      $schema: DRAFT, $id: SARIF_ID, title: 'n8n SecureFlow CLI emitted SARIF 2.1.0 profile', description: 'This is not a complete external SARIF 2.1.0 conformance schema; use a full validator for that guarantee.', type: 'object', additionalProperties: false,
      required: ['$schema', 'version', 'runs'], properties: { $schema: { const: 'https://json.schemastore.org/sarif-2.1.0.json' }, version: { const: '2.1.0' }, runs: { $ref: '#/$defs/run' } }, $defs: definitions(sarifDefs),
    },
  };
}

describe('CLI schema artifact gate', () => {
  it('parses both JSON sources and reports malformed input', () => {
    const valid = validArtifacts();
    const parsed = parseSchemaDocuments(Object.fromEntries(Object.entries(valid).map(([name, value]) => [name, JSON.stringify(value)])));
    expect(parsed.errors).toEqual([]);
    expect(parsed.documents['scanner-cli-v1.schema.json']).toMatchObject({ $id: SCANNER_ID });
    expect(parsed.documents['emitted-sarif-2.1.0-profile.schema.json']).toMatchObject({ $id: SARIF_ID });
    const malformed = parseSchemaDocuments({ ...Object.fromEntries(Object.entries(valid).map(([name, value]) => [name, JSON.stringify(value)])), 'scanner-cli-v1.schema.json': '{' });
    expect(malformed.errors.join('\n')).toMatch(/scanner-cli-v1\.schema\.json.*malformed JSON/i);
  });

  it('accepts both artifacts when their stable metadata and local refs are intact', () => {
    expect(validateSchemaArtifacts(validArtifacts())).toEqual({ ok: true });
  });

  it('fails closed when an artifact is missing or is not an object root', () => {
    const artifacts = validArtifacts();
    delete artifacts['emitted-sarif-2.1.0-profile.schema.json'];
    artifacts['scanner-cli-v1.schema.json'] = [];
    const result = validateSchemaArtifacts(artifacts);
    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toMatch(/emitted-sarif.*parsed artifact is missing/i);
    expect(result.errors.join('\n')).toMatch(/root must be an object/i);
  });

  it('rejects draft, ID, required-field, and definition-key drift', () => {
    const artifacts = validArtifacts();
    const scanner = artifacts['scanner-cli-v1.schema.json'];
    scanner.$schema = 'https://json-schema.org/draft/2019-09/schema'; scanner.$id = 'urn:n8n-secureflow:scanner-cli-v2'; scanner.required = ['schemaVersion', 'results']; delete scanner.$defs.envelopeSummary;
    const result = validateSchemaArtifacts(artifacts);
    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toMatch(/Draft 2020-12/i);
    expect(result.errors.join('\n')).toMatch(/stable \$id/i);
    expect(result.errors.join('\n')).toMatch(/required top-level fields/i);
    expect(result.errors.join('\n')).toMatch(/\$defs keys/i);
  });

  it('rejects external refs and refs to undeclared definitions', () => {
    const artifacts = validArtifacts();
    artifacts['scanner-cli-v1.schema.json'].properties.results.$ref = 'https://example.test/schema.json';
    artifacts['emitted-sarif-2.1.0-profile.schema.json'].$defs.run.$ref = '#/$defs/notDeclared';
    const result = validateSchemaArtifacts(artifacts);
    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toMatch(/external or malformed \$refs/i);
    expect(result.errors.join('\n')).toMatch(/undeclared \$ref target/i);
  });

  it('requires the SARIF description to disclaim complete external conformance', () => {
    const artifacts = validArtifacts();
    artifacts['emitted-sarif-2.1.0-profile.schema.json'].description = 'SARIF profile.';
    const result = validateSchemaArtifacts(artifacts);
    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toMatch(/complete external SARIF.*conformance/i);
  });
});
