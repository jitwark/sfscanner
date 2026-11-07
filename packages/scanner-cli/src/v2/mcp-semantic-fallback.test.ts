import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { handleMcpRequest } from './mcp';

type McpScanResult = {
  isError?: boolean;
  structuredContent?: { exitCode?: number };
  content: Array<{ text: string }>;
};
type Envelope = {
  results: Array<{
    result: {
      engine: { version: string };
      profile: { id: string; version: string };
      analysis: { status: string; diagnostics: Array<{ code: string; location?: { pointer?: string } }> };
      assessment: { grade?: string } | null;
      findings: Array<{ ruleId: string }>;
    };
  }>;
};

async function withTempDirectory<T>(run: (directory: string) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), 'mcp-semantic-'));
  try { return await run(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}

const node = (id: string, parameters: unknown) =>
  `{"id":"${id}","name":"${id}","type":"n8n-nodes-base.discord","typeVersion":1,"parameters":${JSON.stringify(parameters)}}`;
const workflow = (...nodes: string[]) => `{"nodes":[${nodes.join(',')}],"connections":{}}`;
const start = `{"id":"Start","name":"Start","type":"n8n-nodes-base.manualTrigger","typeVersion":1,"parameters":{}}`;
const codesAt = (envelope: Envelope, pointer: string) =>
  envelope.results[0]!.result.analysis.diagnostics.filter(({ location }) => location?.pointer === pointer).map(({ code }) => code);

async function scanThroughMcp(directory: string, document: string): Promise<{ response: McpScanResult; envelope: Envelope; raw: string }> {
  await writeFile(join(directory, 'workflow.json'), document);
  const response = await handleMcpRequest({
    jsonrpc: '2.0',
    id: 90,
    method: 'tools/call',
    params: { name: 'n8n_scan', arguments: { inputs: ['./workflow.json'] } },
  }, { cwd: directory }) as { result: McpScanResult };
  const raw = response.result.content[0]!.text;
  return { response: response.result, envelope: JSON.parse(raw) as Envelope, raw };
}

describe('MCP semantic fallback candidate', () => {
  it('returns both coverage codes, DEGRADED, and the engine/profile identity', async () => {
    await withTempDirectory(async (directory) => {
      const { response, envelope } = await scanThroughMcp(directory, workflow(start, node('Unknown', {})));
      const item = envelope.results[0]!.result;

      expect(response.isError).toBe(false);
      expect(response.structuredContent?.exitCode).toBe(0);
      expect(item.engine.version).toBe('2.0.0');
      expect(item.profile).toMatchObject({ id: 'beta-default', version: '2.0.0' });
      expect(item.analysis.status).toBe('DEGRADED');
      expect(codesAt(envelope, '/nodes/1')).toEqual(['SEMANTIC_CATALOGUE_MISS', 'GENERIC_NODE_UNMODELED_CAPABILITY']);
      expect(item.assessment?.grade).toBeTruthy();
    });
  }, 20_000);

  it('retains the secret finding while keeping the raw secret out of the MCP payload', async () => {
    const secret = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
    await withTempDirectory(async (directory) => {
      const { response, envelope, raw } = await scanThroughMcp(directory, workflow(start, node('Unknown', { url: 'https://example.invalid/x', awsSecretAccessKey: secret })));
      const item = envelope.results[0]!.result;

      expect(response.isError).toBe(false);
      expect(response.structuredContent?.exitCode).toBe(1);
      expect(item.analysis.status).toBe('DEGRADED');
      expect(item.findings.map(({ ruleId }) => ruleId)).toContain('RAW_SECRET_INDICATOR');
      expect(raw).not.toContain(secret);
    });
  }, 20_000);

  it('leaves a genuinely unresolved node INDETERMINATE with no assessment', async () => {
    await withTempDirectory(async (directory) => {
      const { response, envelope } = await scanThroughMcp(directory, workflow(start, node('Broken', 'not-an-object')));
      const item = envelope.results[0]!.result;

      expect(response.isError).toBe(true);
      expect(response.structuredContent?.exitCode).toBe(3);
      expect(item.analysis.status).toBe('INDETERMINATE');
      expect(item.assessment).toBeNull();
      expect(item.analysis.diagnostics.map(({ code }) => code).sort()).toEqual(['MALFORMED_NODE_PARAMETERS', 'SEMANTIC_CATALOGUE_MISS']);
    });
  }, 20_000);
});
