import { copyFile, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { handleMcpRequest } from './mcp';

const cleanWorkflow = fileURLToPath(new URL('./__fixtures__/clean-workflow.json', import.meta.url));

async function withTempDirectory<T>(run: (directory: string) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), 'mcp-boundary-'));
  try { return await run(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}

/**
 * MCP 2025-06-18 uses RequestId = string | number (integer recommended), deliberately
 * narrower than general JSON-RPC 2.0, which also permits null. A present null id is
 * therefore an invalid request, while an absent id is a notification and is silent.
 */
describe('MCP JSON-RPC envelope', () => {
  it('never answers a valid notification, whatever the method', async () => {
    for (const method of [
      'notifications/initialized',
      'notifications/cancelled',
      'notifications/progress',
      'ping',
      'tools/list',
      'initialize',
      'tools/nope',
    ]) {
      expect(await handleMcpRequest({ jsonrpc: '2.0', method })).toBeNull();
    }
  });

  it('does not silence an invalid no-id envelope', async () => {
    const invalid = [
      null,
      [],
      42,
      {},
      { jsonrpc: '1.0', method: 'tools/list' },
      { jsonrpc: '2.0' },
      { jsonrpc: '2.0', method: 5 },
    ];
    for (const request of invalid) {
      expect(await handleMcpRequest(request)).toEqual({
        jsonrpc: '2.0',
        id: null,
        error: { code: -32600, message: 'Invalid JSON-RPC request.' },
      });
    }
  });

  it('rejects a present null, object, boolean, NaN, or infinite id', async () => {
    for (const id of [null, { bad: 'id' }, true, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(await handleMcpRequest({ jsonrpc: '2.0', id, method: 'tools/list' })).toEqual({
        jsonrpc: '2.0',
        id: null,
        error: { code: -32600, message: 'Invalid JSON-RPC request.' },
      });
    }
  });

  it('accepts string and finite numeric ids, including zero and empty string', async () => {
    for (const id of ['a', '', 0, 7]) {
      const response = await handleMcpRequest({ jsonrpc: '2.0', id, method: 'tools/list' });
      expect(response?.id).toBe(id);
      expect(response?.result).toBeDefined();
    }
  });

  it('answers an unknown method with an id as -32601', async () => {
    expect(await handleMcpRequest({ jsonrpc: '2.0', id: 9, method: 'tools/nope' })).toEqual({
      jsonrpc: '2.0',
      id: 9,
      error: { code: -32601, message: 'Method not found.' },
    });
  });

  it('rejects unadmitted n8n_scan arguments with -32602 and keeps serving', async () => {
    // Each vector previously crossed the boundary: empty inputs reached the CLI,
    // arrays were stringified and failed later, an own toString escaped the handler.
    const vectors: unknown[] = [
      { inputs: [] },
      { inputs: ['-'] },
      { inputs: [cleanWorkflow], format: { toString: 'x' } },
      { inputs: [cleanWorkflow], format: ['sarif'] },
      { inputs: [cleanWorkflow], failOn: ['HIGH'] },
      { inputs: [cleanWorkflow], failOn: 'high' },
      { inputs: [cleanWorkflow], include: [1] },
      { inputs: [cleanWorkflow], include: ['**/*.json', '--fail-on', 'CRITICAL'] },
      { inputs: [cleanWorkflow], exclude: ['**/*.json', '--format', 'sarif'] },
      { inputs: [cleanWorkflow], output: 'injected.json' },
    ];
    for (const [index, args] of vectors.entries()) {
      expect(await handleMcpRequest({
        jsonrpc: '2.0', id: index + 20, method: 'tools/call', params: { name: 'n8n_scan', arguments: args },
      })).toEqual({
        jsonrpc: '2.0',
        id: index + 20,
        error: { code: -32602, message: 'Invalid n8n_scan arguments.' },
      });
    }
    expect((await handleMcpRequest({ jsonrpc: '2.0', id: 40, method: 'tools/list' }))?.result).toBeDefined();
  });

  it('scans the documented ./-name input escape', async () => {
    await withTempDirectory(async (directory) => {
      await copyFile(cleanWorkflow, join(directory, '-name.json'));
      const response = await handleMcpRequest({
        jsonrpc: '2.0', id: 60, method: 'tools/call',
        params: { name: 'n8n_scan', arguments: { inputs: ['./-name.json'] } },
      }, { cwd: directory });
      const result = response?.result as { isError?: boolean; structuredContent?: { exitCode?: number }; content: Array<{ text: string }> };
      expect(result.isError).toBe(false);
      expect(result.structuredContent?.exitCode).toBe(0);
      const document = JSON.parse(result.content[0]!.text) as { results: Array<{ input: string }> };
      expect(document.results.map((item) => item.input)).toEqual(['-name.json']);
    });
  });

  it('selects a dash-leading file through a non-dash-leading include glob', async () => {
    await withTempDirectory(async (directory) => {
      await copyFile(cleanWorkflow, join(directory, '-name.json'));
      await copyFile(cleanWorkflow, join(directory, 'clean.json'));
      // `.` (a directory input) is admitted by the path packet (C-04); until it lands the
      // file is named directly and the glob still has to select it by its normalized label.
      const response = await handleMcpRequest({
        jsonrpc: '2.0', id: 61, method: 'tools/call',
        params: { name: 'n8n_scan', arguments: { inputs: ['./-name.json', 'clean.json'], include: ['**/-name.json'] } },
      }, { cwd: directory });
      const result = response?.result as { isError?: boolean; structuredContent?: { exitCode?: number }; content: Array<{ text: string }> };
      expect(result.isError).toBe(false);
      expect(result.structuredContent?.exitCode).toBe(0);
      const document = JSON.parse(result.content[0]!.text) as { results: Array<{ input: string }> };
      expect(document.results.map((item) => item.input)).toEqual(['-name.json']);
    });
  });

  it('keeps whitespace and CRLF webhook authentication findings through n8n_scan', async () => {
    await withTempDirectory(async (directory) => {
      await writeFile(join(directory, 'webhook-auth.json'), JSON.stringify({
        nodes: [' basicAuth ', 'basicAuth '].map((authentication, index) => ({ id: `w${index}`, name: `Webhook ${index}`, type: 'n8n-nodes-base.webhook', typeVersion: 2, parameters: { authentication } })),
        connections: {},
      }));
      const response = await handleMcpRequest({
        jsonrpc: '2.0', id: 63, method: 'tools/call',
        params: { name: 'n8n_scan', arguments: { inputs: ['webhook-auth.json'], failOn: 'CRITICAL' } },
      }, { cwd: directory });
      const result = response?.result as { isError?: boolean; structuredContent?: { exitCode?: number }; content: Array<{ text: string }> };
      expect(result.isError).toBe(false);
      expect(result.structuredContent?.exitCode).toBe(0);
      const document = JSON.parse(result.content[0]!.text) as { results: Array<{ result?: { analysis: { status: string }; findings: Array<{ ruleId: string }> } }> };
      expect(document.results[0]?.result?.analysis.status).toBe('COMPLETE');
      expect(document.results[0]?.result?.findings.map(({ ruleId }) => ruleId)).toEqual(['WEBHOOK_EXPOSURE', 'WEBHOOK_EXPOSURE']);
    });
  });

  it('advertises the runtime dash policy on the n8n_scan schema', async () => {
    const result = (await handleMcpRequest({ jsonrpc: '2.0', id: 62, method: 'tools/list' }))?.result as {
      tools: Array<{ inputSchema: { properties: {
        inputs: { items: { pattern?: string } };
        include: { items: { pattern?: string } };
        exclude: { items: { pattern?: string } };
      } } }>;
    };
    const properties = result.tools[0]!.inputSchema.properties;
    expect(properties.inputs.items.pattern).toBe('^(?!-$)');
    expect(properties.include.items.pattern).toBe('^(?!-)');
    expect(properties.exclude.items.pattern).toBe('^(?!-)');
  });

  it('treats option-like inputs as file paths and never overwrites an existing file', async () => {
    await withTempDirectory(async (directory) => {
      await copyFile(cleanWorkflow, join(directory, 'clean.json'));
      const canary = '{"sentinel":"original"}';
      await writeFile(join(directory, 'existing.json'), canary);

      const outputInjection = await handleMcpRequest({
        jsonrpc: '2.0', id: 50, method: 'tools/call',
        params: { name: 'n8n_scan', arguments: { inputs: ['--output', 'existing.json', 'clean.json'] } },
      }, { cwd: directory });
      expect(outputInjection?.result).toMatchObject({ isError: true });
      expect(await readFile(join(directory, 'existing.json'), 'utf8')).toBe(canary);
      expect((await readdir(directory)).sort()).toEqual(['clean.json', 'existing.json']);

      const formatInjection = await handleMcpRequest({
        jsonrpc: '2.0', id: 51, method: 'tools/call',
        params: { name: 'n8n_scan', arguments: { inputs: ['--format', 'sarif', 'clean.json'] } },
      }, { cwd: directory });
      expect(formatInjection?.result).toMatchObject({ isError: true });
      expect(JSON.stringify(formatInjection)).not.toContain('2.1.0');

      const includeInjection = await handleMcpRequest({
        jsonrpc: '2.0', id: 53, method: 'tools/call',
        params: {
          name: 'n8n_scan',
          arguments: { inputs: ['clean.json'], include: ['**/*.json', '--output', 'injected.json'] },
        },
      }, { cwd: directory });
      expect(includeInjection).toEqual({
        jsonrpc: '2.0', id: 53, error: { code: -32602, message: 'Invalid n8n_scan arguments.' },
      });
      expect((await readdir(directory)).sort()).toEqual(['clean.json', 'existing.json']);
      expect((await handleMcpRequest({ jsonrpc: '2.0', id: 52, method: 'tools/list' }))?.result).toBeDefined();
    });
  });
});
