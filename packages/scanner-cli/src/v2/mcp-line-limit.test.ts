import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import * as mcp from './mcp';

const MAX_LINE_BYTES = 1_048_576;

async function session(chunks: readonly (string | Buffer)[]): Promise<Record<string, unknown>[]> {
  const input = new PassThrough();
  const output = new PassThrough();
  const served = mcp.runMcpStdio(input, output);
  for (const chunk of chunks) input.write(chunk);
  input.end();
  await served;
  return String(output.read() ?? '').trim().split('\n').filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

const PARSE_ERROR = { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Invalid JSON.' } };

describe('MCP stdio byte bounds', () => {
  it('exports the documented one-mebibyte cap', () => {
    expect((mcp as Record<string, unknown>).MCP_MAX_LINE_BYTES).toBe(MAX_LINE_BYTES);
  });

  it('answers one parse error for a valid over-limit line and keeps serving', async () => {
    const huge = `{"jsonrpc":"2.0","id":1,"method":"tools/list","pad":"${'x'.repeat(MAX_LINE_BYTES)}"}`;
    const lines = await session([`${huge}\n`, '{"jsonrpc":"2.0","id":2,"method":"tools/list"}\n']);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toEqual(PARSE_ERROR);
    expect(lines[1]!.id).toBe(2);
  });

  it('emits one error per over-limit line and recovers after each newline', async () => {
    const huge = `{"jsonrpc":"2.0","id":1,"method":"tools/list","pad":"${'x'.repeat(MAX_LINE_BYTES)}"}`;
    const lines = await session([`${huge}\n${huge}\n`, '{"jsonrpc":"2.0","id":3,"method":"tools/list"}\n']);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toEqual(PARSE_ERROR);
    expect(lines[1]).toEqual(PARSE_ERROR);
    expect(lines[2]!.id).toBe(3);
  });

  it('counts bytes, not code units, for multibyte lines', async () => {
    const chars = Math.ceil(MAX_LINE_BYTES / 2) + 1;
    const huge = `{"jsonrpc":"2.0","id":4,"method":"tools/list","pad":"${'é'.repeat(chars)}"}`;
    expect(huge.length).toBeLessThan(MAX_LINE_BYTES);
    expect(Buffer.byteLength(huge, 'utf8')).toBeGreaterThan(MAX_LINE_BYTES);
    const lines = await session([`${huge}\n`, '{"jsonrpc":"2.0","id":5,"method":"tools/list"}\n']);
    expect(lines[0]).toEqual(PARSE_ERROR);
    expect(lines[1]!.id).toBe(5);
  });

  it('serves a final unterminated valid line at EOF', async () => {
    const lines = await session(['{"jsonrpc":"2.0","id":6,"method":"tools/list"}']);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.id).toBe(6);
  });

  it('serves CRLF frames', async () => {
    const lines = await session(['{"jsonrpc":"2.0","id":7,"method":"tools/list"}\r\n']);
    expect(lines[0]!.id).toBe(7);
  });

  it('reassembles a chunk-split line under the cap', async () => {
    const frame = '{"jsonrpc":"2.0","id":8,"method":"tools/list"}';
    const split = Math.floor(frame.length / 2);
    const lines = await session([frame.slice(0, split), `${frame.slice(split)}\n`]);
    expect(lines[0]!.id).toBe(8);
  });

  it('accepts JSON content of exactly the cap with LF or CRLF', async () => {
    const exactFrame = (id: number): string => {
      const prefix = `{"jsonrpc":"2.0","id":${id},"method":"tools/list","pad":"`;
      const suffix = '"}';
      const frame = `${prefix}${'x'.repeat(MAX_LINE_BYTES - Buffer.byteLength(prefix) - Buffer.byteLength(suffix))}${suffix}`;
      expect(Buffer.byteLength(frame, 'utf8')).toBe(MAX_LINE_BYTES);
      return frame;
    };
    const lf = await session([`${exactFrame(20)}\n`, '{"jsonrpc":"2.0","id":21,"method":"tools/list"}\n']);
    expect(lf.map((line) => line.id)).toEqual([20, 21]);
    expect(lf[0]!.error).toBeUndefined();
    const crlf = await session([`${exactFrame(22)}\r\n`, '{"jsonrpc":"2.0","id":23,"method":"tools/list"}\n']);
    expect(crlf.map((line) => line.id)).toEqual([22, 23]);
    expect(crlf[0]!.error).toBeUndefined();
  });

  it('reassembles a CRLF terminator split across chunks, including at the cap', async () => {
    const frame = '{"jsonrpc":"2.0","id":24,"method":"tools/list"}';
    const lines = await session([frame, '\r', '\n{"jsonrpc":"2.0","id":25,"method":"tools/list"}\n']);
    expect(lines.map((line) => line.id)).toEqual([24, 25]);
    const prefix = '{"jsonrpc":"2.0","id":26,"method":"tools/list","pad":"';
    const exact = `${prefix}${'x'.repeat(MAX_LINE_BYTES - Buffer.byteLength(prefix) - 2)}"}`;
    const split = await session([exact, '\r', '\n{"jsonrpc":"2.0","id":27,"method":"tools/list"}\n']);
    expect(split.map((line) => line.id)).toEqual([26, 27]);
  });

  it('emits one error for a final over-cap line without a newline', async () => {
    const huge = `{"jsonrpc":"2.0","id":28,"method":"tools/list","pad":"${'x'.repeat(MAX_LINE_BYTES)}"}`;
    expect(await session([huge])).toEqual([PARSE_ERROR]);
  });

  it('skips empty lines and still serves the next frame', async () => {
    const lines = await session(['\n\r\n   \n', '{"jsonrpc":"2.0","id":29,"method":"tools/list"}\n']);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.id).toBe(29);
  });

  it('swaps in a stderr-bound console object for the session and restores it after EOF', async () => {
    const original = console;
    const input = new PassThrough();
    const output = new PassThrough();
    const served = mcp.runMcpStdio(input, output);
    expect(console).not.toBe(original);
    input.end();
    await served;
    expect(console).toBe(original);
  });
});
