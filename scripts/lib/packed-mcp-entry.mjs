/**
 * Packed MCP entry probes. The published `sfscanner-mcp` bin resolves to `dist/mcp.js`
 * through an npm POSIX symlink; Node sets `process.argv[1]` to the symlink path, so the
 * server must recognise its own module, not a filename suffix. These probes run the
 * installed artifact under both names and require real JSON-RPC responses.
 */
import { copyFileSync } from 'node:fs';
import path from 'node:path';

export const MCP_PROTOCOL_VERSION = '2025-06-18';

const HANDSHAKE = Object.freeze([
  '{"jsonrpc":"2.0","id":"entry-i","method":"initialize"}',
  '{"jsonrpc":"2.0","id":"entry-t","method":"tools/list"}',
  '{"jsonrpc":"2.0","id":"entry-c","method":"tools/call","params":{"name":"n8n_scan","arguments":{"inputs":["clean.json"]}}}',
]);

function served(messages, tool) {
  return messages[0]?.result?.protocolVersion === MCP_PROTOCOL_VERSION
    && messages[1]?.result?.tools?.some((entry) => entry.name === tool) === true
    && messages[2]?.result?.isError === false
    && messages[2]?.result?.structuredContent?.exitCode === 0;
}

export function mcpSession(run, consumer, command, args = [], lines = HANDSHAKE) {
  const result = run(command, args, { cwd: consumer, input: `${lines.join('\n')}\n` });
  return result.stdout.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

export function probeInstalledMcpEntry({ run, consumer, installed, tool }) {
  // Not named `*.js` ending in `mcp.js`: the old suffix guard would match, making the
  // probe vacuous. `.js` keeps the copy ESM under the installed package's type module.
  const variant = path.join(installed, 'dist', 'sfscanner-mcp-main.js');
  copyFileSync(path.join(installed, 'dist', 'mcp.js'), variant);
  const byName = served(mcpSession(run, consumer, process.execPath, [variant]), tool);
  const bin = path.join(consumer, 'node_modules', '.bin', 'sfscanner-mcp');
  const byBin = process.platform === 'win32' ? undefined : served(mcpSession(run, consumer, bin), tool);
  const detail = `name-variant=${byName ? 'served' : 'no-response'} (installed dist/sfscanner-mcp-main.js); `
    + `installed-bin=${byBin === undefined ? 'not-exercised' : byBin ? 'served' : 'no-response'}; platform=${process.platform}; `
    + `posix-symlink-proof=${process.platform === 'win32' ? 'not-exercised-here (.cmd shim passes dist/mcp.js)' : byBin ? 'verified' : 'failed'}`;
  return { status: byName && byBin !== false ? 'pass' : 'fail', detail };
}
