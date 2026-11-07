import path from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ADMITTED_PROFILE_SPECIFIERS_V2, ADMITTED_PROFILE_V2 } from './contracts';
import { loadExplicitConfig } from './config';
import { MCP_TOOL_NAME, handleMcpRequest, runMcpStdio, type McpResponse } from './mcp';

/**
 * The MCP tool and the config loader are two doors into one engine, and a profile that
 * one door admits while the other refuses is the defect this row exists for. Both must
 * read `ADMITTED_PROFILE_SPECIFIERS_V2` and both must canonicalize to the admitted id, so
 * these cases run the same specifiers through both surfaces and compare the verdicts.
 */
const fixtureDirectory = fileURLToPath(new URL('./__fixtures__', import.meta.url));
const INPUT = 'clean-workflow.json';
const UNADMITTED_PROFILES = ['beta-hardened', `${ADMITTED_PROFILE_V2.id}@9.9.9`, `${ADMITTED_PROFILE_V2.id}@${ADMITTED_PROFILE_V2.version}.1`, 'Beta-Default'];

async function scanUnderMcpProfile(profile: string): Promise<McpResponse | null> {
  return handleMcpRequest(
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: MCP_TOOL_NAME, arguments: { inputs: [INPUT], profile } } },
    { cwd: fixtureDirectory },
  );
}

describe('MCP and CLI-config profile admission', () => {
  it('advertises the shared registry itself in the MCP tool schema', async () => {
    const listed = await handleMcpRequest({ jsonrpc: '2.0', id: 'list', method: 'tools/list' });
    const tools = (listed?.result as { tools: readonly { name: string; inputSchema: { properties: { profile: { enum: readonly string[] } } } }[] } | undefined)?.tools;
    expect(tools?.map((tool) => tool.name)).toEqual([MCP_TOOL_NAME]);
    expect(tools?.[0]?.inputSchema.properties.profile.enum).toEqual([...ADMITTED_PROFILE_SPECIFIERS_V2]);
    expect(ADMITTED_PROFILE_SPECIFIERS_V2).toContain(ADMITTED_PROFILE_V2.id);
  });

  it('runs every admitted specifier past the config loader and the MCP tool alike', async () => {
    const canonical = await scanUnderMcpProfile(ADMITTED_PROFILE_V2.id);
    expect(canonical?.error).toBeUndefined();
    expect((canonical?.result as { isError?: boolean } | undefined)?.isError).toBe(false);

    for (const specifier of ADMITTED_PROFILE_SPECIFIERS_V2) {
      const configured = loadExplicitConfig({ schemaVersion: 'n8n-scan-config-v2', profile: specifier });
      expect(configured.ok).toBe(true);
      if (!configured.ok) continue;
      expect(configured.config.profile).toBe(ADMITTED_PROFILE_V2.id);
      // An `id@version` pin is the same admission, not a second one: the scan is identical.
      expect(await scanUnderMcpProfile(specifier)).toEqual(canonical);
    }
  });

  it('refuses the same unadmitted specifiers on both surfaces', async () => {
    for (const specifier of UNADMITTED_PROFILES) {
      const configured = loadExplicitConfig({ schemaVersion: 'n8n-scan-config-v2', profile: specifier });
      expect(configured.ok).toBe(false);
      if (configured.ok) continue;
      expect(configured.errors).toContain('profile is not admitted');

      const mcp = await scanUnderMcpProfile(specifier);
      expect(mcp?.result).toBeUndefined();
      expect(mcp?.error).toEqual({ code: -32602, message: 'Invalid n8n_scan arguments.' });
    }
  });
});

/**
 * The stdio transport is the door a real MCP client speaks through, and its failure shape is
 * what a client's error handling is written against, so each rejection is pinned line by line:
 * an unparsable line, a wrong protocol version, an unknown method, an unknown tool, and a
 * message large enough to be a memory problem if the reader were unbounded.
 */
describe('MCP stdio transport', () => {
  const session = async (lines: readonly string[]): Promise<readonly McpResponse[]> => {
    const input = new PassThrough();
    const output = new PassThrough();
    const served = runMcpStdio(input, output);
    input.end(lines.join('\n'));
    await served;
    // `PassThrough.read()` is `any` in the Node typings, so the buffer is
    // stringified into a declared `string` before splitting; every line a
    // parsed response comes from is therefore a real `string`.
    const written = String(output.read() ?? '');
    return written.trim().split('\n').filter(Boolean).map((line: string): McpResponse => JSON.parse(line) as McpResponse);
  };

  it('answers every malformed, wrong-version, unknown, and oversized line deterministically', async () => {
    const oversized = `{"jsonrpc":"2.0","id":5,"method":"tools/call","params":${'x'.repeat(1_000_000)}}`;
    const served = await session([
      '{ not json',
      '{"jsonrpc":"1.0","id":2,"method":"tools/list"}',
      '{"jsonrpc":"2.0","id":3,"method":"tools/nope"}',
      `{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"n8n_wipe","arguments":{"inputs":["${INPUT}"]}}}`,
      oversized,
      '{"jsonrpc":"2.0","id":6,"method":"initialize"}',
    ]);
    expect(served).toEqual([
      { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Invalid JSON.' } },
      { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid JSON-RPC request.' } },
      { jsonrpc: '2.0', id: 3, error: { code: -32601, message: 'Method not found.' } },
      { jsonrpc: '2.0', id: 4, error: { code: -32602, message: 'Invalid n8n_scan arguments.' } },
      { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Invalid JSON.' } },
      { jsonrpc: '2.0', id: 6, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'n8n-secureflow-scanner', version: '0.1.0' } } },
    ]);
  });

  it('runs the one tool over the transport against the packaged fixture', async () => {
    // The argv is a JSON string, so the fixture path is embedded with forward slashes: a Windows
    // backslash is an escape character to the reader on the other end of the transport.
    const relative = path.relative(process.cwd(), fixtureDirectory).replaceAll('\\', '/');
    const [served] = await session([`{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"${MCP_TOOL_NAME}","arguments":{"inputs":["${relative}/${INPUT}"]}}}`]);
    expect(served).toMatchObject({ id: 1, result: { isError: false, structuredContent: { exitCode: 0 }, content: [{ type: 'text' }] } });
  });
});
