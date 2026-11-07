import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { scanJson } from './scan-core.js';
import { validateCliJsonDocument, validateSarifDocument } from './cli-schema.js';

type JsonSchema = {
  $schema?: unknown;
  $id?: unknown;
  title?: unknown;
  description?: unknown;
  type?: unknown;
  required?: unknown;
  additionalProperties?: unknown;
  properties?: Record<string, unknown>;
  $defs?: Record<string, unknown>;
};

async function readSchema(name: string): Promise<JsonSchema> {
  const source = await readFile(new URL(`./schemas/${name}`, import.meta.url), 'utf8');
  return JSON.parse(source) as JsonSchema;
}

function refs(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(refs);
  if (!value || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([key, item]) => [
    ...(key === '$ref' && typeof item === 'string' ? [item] : []),
    ...refs(item),
  ]);
}

type CompiledSchema = (value: unknown) => boolean;
type AjvConstructor = new (options?: Record<string, unknown>) => {
  compile(schema: Record<string, unknown>): CompiledSchema;
};

// `ajv@^6.15.0` is declared in this workspace's devDependencies and recorded in the root
// lockfile, so resolving the bare specifier through this file's own module boundary is a
// declared dependency: a prune fails here instead of silently borrowing ESLint's transitive
// tree. The version implements draft-07. This artifact uses only keywords draft-07 also
// understands; lower the two draft-2020 spellings, then validate the real emitted result.
// Adding a second JSON-Schema library for one assertion is not justified.
function lowerDraft2020(schema: JsonSchema): Record<string, unknown> {
  const lowered = JSON.parse(
    JSON.stringify(schema).replaceAll('#/$defs/', '#/definitions/'),
  ) as Record<string, unknown>;
  lowered.definitions = lowered.$defs;
  delete lowered.$defs;
  delete lowered.$schema;
  return lowered;
}

const Ajv = createRequire(import.meta.url)('ajv') as AjvConstructor;

function validateAgainstPublishedSchema(schema: JsonSchema, value: unknown): boolean {
  const validate = new Ajv({ allErrors: true }).compile(lowerDraft2020(schema));
  return validate(value);
}

describe('standalone CLI schema artifacts', () => {
  it('publishes a self-contained scanner-cli-v1 Draft 2020-12 schema', async () => {
    const schema = await readSchema('scanner-cli-v1.schema.json');
    expect(schema.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
    expect(schema.$id).toBe('urn:n8n-secureflow:scanner-cli-v1');
    expect(schema.type).toBe('object');
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toEqual(['schemaVersion', 'results', 'summary']);
    expect(schema.$defs).toEqual(expect.objectContaining({ resultItem: expect.anything(), scanResult: expect.anything() }));
    expect(refs(schema).every((ref) => ref.startsWith('#/'))).toBe(true);
    expect(validateCliJsonDocument({ schemaVersion: 'scanner-cli-v1', results: [], summary: { total: 0, completed: 0, inputErrors: 0, internalErrors: 0, cancelled: 0, findings: 0 } })).toEqual({ ok: true });
  });

  it('accepts an actual parser-failure INDETERMINATE result in the published schema and runtime validator', async () => {
    const schema = await readSchema('scanner-cli-v1.schema.json');
    const outcome = scanJson(JSON.stringify({
      nodes: [
        {
          id: 'python', name: 'Broken Python', type: 'n8n-nodes-base.code', typeVersion: 2,
          parameters: { language: 'pythonNative', pythonCode: 'subprocess.run(["ls"])\ndef broken(:' },
        },
        {
          id: 'javascript', name: 'Broken JavaScript', type: 'n8n-nodes-base.code', typeVersion: 2,
          parameters: { language: 'javaScript', jsCode: 'const = ;' },
        },
      ],
      connections: {},
    }), { profile: 'beta-hardened', approvedDomains: [] });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result.analysisStatus).toBe('INDETERMINATE');
    expect(outcome.result.analysisDiagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'REQUIRED_STAGE_FAILURE', category: 'POLICY', location: { path: '/nodes/0' },
      }),
      expect.objectContaining({
        code: 'REQUIRED_STAGE_FAILURE', category: 'POLICY', location: { path: '/nodes/1' },
      }),
    ]));

    const document = {
      schemaVersion: 'scanner-cli-v1',
      results: [{ input: '/fixtures/parser-failure.json', ok: true, result: outcome.result }],
      summary: {
        total: 1, completed: 1, inputErrors: 0, internalErrors: 0, cancelled: 0,
        findings: outcome.result.findings.length,
      },
    };

    expect(validateCliJsonDocument(document)).toEqual({ ok: true });
    expect(validateAgainstPublishedSchema(schema, document)).toBe(true);

    const wrongCode = structuredClone(document);
    wrongCode.results[0].result.analysisDiagnostics = [
      { code: 'JAVASCRIPT_PARSE_FAILED', category: 'PARSER' },
    ];
    expect(validateCliJsonDocument(wrongCode).ok).toBe(false);
    expect(validateAgainstPublishedSchema(schema, wrongCode)).toBe(false);
  });

  it('publishes the narrow emitted-SARIF profile without claiming full SARIF conformance', async () => {
    const schema = await readSchema('emitted-sarif-2.1.0-profile.schema.json');
    expect(schema.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
    expect(schema.$id).toBe('urn:n8n-secureflow:emitted-sarif-2.1.0-profile');
    expect(schema.description).toEqual(expect.stringContaining('not a complete external SARIF'));
    expect(schema.properties?.runs).toMatchObject({ type: 'array', minItems: 1, maxItems: 1 });
    expect(schema.$defs).toEqual(expect.objectContaining({ run: expect.anything(), invocation: expect.anything() }));
    expect(refs(schema).every((ref) => ref.startsWith('#/'))).toBe(true);
    expect(validateSarifDocument({
      $schema: 'https://json.schemastore.org/sarif-2.1.0.json', version: '2.1.0',
      runs: [{ tool: { driver: { name: 'n8n-scan', version: '0.1.0', rules: [] } }, results: [], invocations: [{ executionSuccessful: true, toolExecutionNotifications: [] }] }],
    })).toEqual({ ok: true });
  });
});
