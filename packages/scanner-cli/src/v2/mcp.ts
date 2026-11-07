#!/usr/bin/env node
import { Console } from 'node:console';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgumentsV2 } from './arguments.js';
import { runCliV2, type PublicRunResultV2 } from './cli-runner.js';
import { ADMITTED_PROFILE_V2, ADMITTED_PROFILE_SPECIFIERS_V2, isAdmittedProfileSpecifierV2 } from './contracts.js';

export const MCP_PROTOCOL_VERSION = '2025-06-18';
export const MCP_TOOL_NAME = 'n8n_scan';
export const MCP_MAX_LINE_BYTES = 1_048_576;

export type McpRequest = Readonly<{ jsonrpc: '2.0'; id?: string | number; method: string; params?: unknown }>;
export type McpResponse = Readonly<{ jsonrpc: '2.0'; id: string | number | null; result?: unknown; error?: Readonly<{ code: number; message: string }> }>;

type ToolCallArguments = Readonly<{ inputs: readonly string[]; format?: 'json' | 'ndjson' | 'sarif' | 'table'; failOn?: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' | 'INFO'; profile?: string; include?: readonly string[]; exclude?: readonly string[] }>;
type HandlerOptions = Readonly<{ cwd?: string }>;

const TOOL = Object.freeze({
  name: MCP_TOOL_NAME,
  description: 'Scan local n8n workflow JSON with the admitted deterministic offline v2 profile.',
  inputSchema: Object.freeze({
    type: 'object', additionalProperties: false, required: ['inputs'],
    properties: Object.freeze({
      inputs: Object.freeze({ type: 'array', minItems: 1, items: Object.freeze({ type: 'string', minLength: 1, pattern: '^(?!-$)' }) }),
      format: Object.freeze({ type: 'string', enum: Object.freeze(['json', 'ndjson', 'sarif', 'table']) }),
      failOn: Object.freeze({ type: 'string', enum: Object.freeze(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO']) }),
      profile: Object.freeze({ type: 'string', enum: ADMITTED_PROFILE_SPECIFIERS_V2 }),
      include: Object.freeze({ type: 'array', items: Object.freeze({ type: 'string', minLength: 1, pattern: '^(?!-)' }) }),
      exclude: Object.freeze({ type: 'array', items: Object.freeze({ type: 'string', minLength: 1, pattern: '^(?!-)' }) }),
    }),
  }),
});

function response(id: string | number | null, result: unknown): McpResponse { return Object.freeze({ jsonrpc: '2.0', id, result }); }
function error(id: string | number | null, code: number, message: string): McpResponse { return Object.freeze({ jsonrpc: '2.0', id, error: Object.freeze({ code, message }) }); }
function isRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }

const FORMATS_V2 = ['json', 'ndjson', 'sarif', 'table'] as const;
const FAIL_ON_V2 = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO'] as const;

function isNonEmptyStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string' && entry.length > 0);
}

// include/exclude are emitted as option values before `--`, so a leading dash would let
// one array entry become the next CLI option. Such values must be written `./-name`.
function isAdmittedOptionValueArray(value: unknown): value is string[] {
  return isNonEmptyStringArray(value) && value.every((entry) => !entry.startsWith('-'));
}

const ALLOWED_ARGUMENTS: Record<string, true> = Object.freeze({ inputs: true, format: true, failOn: true, profile: true, include: true, exclude: true });

function toolArguments(params: unknown): ToolCallArguments | null {
  if (!isRecord(params) || params.name !== MCP_TOOL_NAME || !isRecord(params.arguments)) return null;
  const values = params.arguments;
  if (Object.keys(values).some((key) => ALLOWED_ARGUMENTS[key] !== true)) return null;
  // The advertised schema is the runtime contract: strings stay strings (no coercion),
  // enums are checked exactly, and `inputs` cannot be empty. "-" is refused here, before
  // runMcpScan can reach the v2 input reader and wait for EOF.
  if (!isNonEmptyStringArray(values.inputs) || values.inputs.length === 0 || values.inputs.includes('-')) return null;
  if (values.format !== undefined && !(typeof values.format === 'string' && (FORMATS_V2 as readonly string[]).includes(values.format))) return null;
  if (values.failOn !== undefined && !(typeof values.failOn === 'string' && (FAIL_ON_V2 as readonly string[]).includes(values.failOn))) return null;
  if (values.profile !== undefined && !isAdmittedProfileSpecifierV2(values.profile)) return null;
  if (values.include !== undefined && !isAdmittedOptionValueArray(values.include)) return null;
  if (values.exclude !== undefined && !isAdmittedOptionValueArray(values.exclude)) return null;
  return values as ToolCallArguments;
}

export async function runMcpScan(argumentsValue: ToolCallArguments, options: HandlerOptions = {}): Promise<PublicRunResultV2> {
  const argv = ['--schema', 'v2', 'scan'];
  if (argumentsValue.format) argv.push('--format', argumentsValue.format);
  if (argumentsValue.failOn) argv.push('--fail-on', argumentsValue.failOn);
  // `--profile` admits the canonical id, exactly as the config loader stores it, so an
  // `id@version` pin reaches the engine as the one admitted profile rather than as an
  // alias the argv layer does not know.
  if (argumentsValue.profile) argv.push('--profile', ADMITTED_PROFILE_V2.id);
  for (const input of argumentsValue.include ?? []) argv.push('--include', input);
  for (const input of argumentsValue.exclude ?? []) argv.push('--exclude', input);
  // Client values are file paths, never options: the native `--` terminator keeps every
  // client string out of parseArgumentsV2's option branch while its local-path validation
  // still applies. A leading-dash filename remains usable as `./-name.json`.
  argv.push('--', ...argumentsValue.inputs);
  const parsed = parseArgumentsV2(argv);
  if (!parsed.ok || parsed.command.kind !== 'scan') return Object.freeze({ exitCode: 2, stdout: '', stderr: 'MCP scan arguments are invalid.\n' });
  return runCliV2(parsed.command, { cwd: options.cwd });
}

export async function handleMcpRequest(request: unknown, options: HandlerOptions = {}): Promise<McpResponse | null> {
  // Envelope validation precedes the notification check: an invalid no-id message is not a
  // valid notification and must not be silenced.
  if (!isRecord(request) || request.jsonrpc !== '2.0' || typeof request.method !== 'string') return error(null, -32600, 'Invalid JSON-RPC request.');
  // MCP 2025-06-18 RequestId is `string | number` (an integer is recommended), deliberately
  // narrower than general JSON-RPC 2.0's `string | number | null`. A present null is therefore
  // an invalid request, not a notification.
  if (!Object.prototype.hasOwnProperty.call(request, 'id')) return null;
  const id = request.id;
  if (typeof id !== 'string' && (typeof id !== 'number' || !Number.isFinite(id))) return error(null, -32600, 'Invalid JSON-RPC request.');
  if (request.method === 'ping') return response(id, {});
  if (request.method === 'initialize') return response(id, { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: { name: 'n8n-secureflow-scanner', version: '0.1.0' } });
  if (request.method === 'tools/list') return response(id, { tools: [TOOL] });
  if (request.method !== 'tools/call') return error(id, -32601, 'Method not found.');
  const argumentsValue = safeToolArguments(request.params);
  if (argumentsValue === null) return error(id, -32602, 'Invalid n8n_scan arguments.');
  try {
    const result = await runMcpScan(argumentsValue, options);
    const text = result.stdout || result.stderr || JSON.stringify(result.document ?? {});
    return response(id, { content: [{ type: 'text', text }], isError: result.exitCode >= 2, structuredContent: { exitCode: result.exitCode } });
  } catch {
    return error(id, -32603, 'MCP scan failed.');
  }
}

/** A validation throw is a client error, never a transport exit. */
function safeToolArguments(params: unknown): ToolCallArguments | null {
  try { return toolArguments(params); } catch { return null; }
}

function divertConsoleToStderr(): () => void {
  const original = console;
  // One Console bound to stderr owns every method (dir/table/assert/count/group/trace
  // included), instead of patching only the methods that route through `log`.
  globalThis.console = new Console({ stdout: process.stderr, stderr: process.stderr });
  return () => { globalThis.console = original; };
}

type LineEvent = Readonly<{ kind: 'line'; text: string }> | Readonly<{ kind: 'overflow' }>;

/** Linear byte reader: an over-limit line is discarded until newline, never retained. */
async function* boundedLines(input: NodeJS.ReadableStream, maxBytes: number): AsyncGenerator<LineEvent> {
  let chunks: Buffer[] = [];
  let length = 0;
  let overflow = false;
  // A trailing CR is deferred: only the next byte decides whether it is the first
  // byte of a CRLF delimiter (not content) or JSON content (counted).
  let pendingCR = false;
  const append = (bytes: Buffer): void => {
    if (bytes.length === 0 || overflow) return;
    if (length + bytes.length > maxBytes) {
      overflow = true;
      chunks = [];
      length = 0;
      return;
    }
    chunks.push(bytes);
    length += bytes.length;
  };
  const take = (): LineEvent | undefined => {
    const wasOverflow = overflow;
    const text = wasOverflow || chunks.length === 0 ? undefined : Buffer.concat(chunks, length).toString('utf8');
    chunks = [];
    length = 0;
    overflow = false;
    pendingCR = false;
    if (wasOverflow) return { kind: 'overflow' };
    return text === undefined ? undefined : { kind: 'line', text };
  };
  for await (const raw of input as AsyncIterable<Buffer | string>) {
    const chunk = typeof raw === 'string' ? Buffer.from(raw, 'utf8') : raw;
    let start = 0;
    for (let index = 0; index < chunk.length; index += 1) {
      if (chunk[index] !== 0x0a) continue;
      if (pendingCR) {
        // The previous chunk ended in CR; a direct LF completes CRLF, otherwise the
        // CR was content before this segment.
        if (index > start) append(Buffer.from('\r'));
        pendingCR = false;
      }
      const end = index > start && chunk[index - 1] === 0x0d ? index - 1 : index;
      append(chunk.subarray(start, end));
      const event = take();
      if (event) yield event;
      start = index + 1;
    }
    if (start < chunk.length) {
      const tail = chunk.subarray(start);
      if (pendingCR) {
        append(Buffer.from('\r'));
        pendingCR = false;
      }
      if (tail[tail.length - 1] === 0x0d) {
        append(tail.subarray(0, tail.length - 1));
        pendingCR = true;
      } else append(tail);
    }
  }
  if (pendingCR) append(Buffer.from('\r'));
  const event = take();
  if (event) yield event;
}

// The transport reads lines and writes framed responses; it never needs the
// descriptor-bearing `process.stdin`/`process.stdout` types it inherits from
// the defaults, so declare the streams it actually accepts. A caller with a
// `PassThrough` — the in-process transport test — is then type-correct.
export async function runMcpStdio(input: NodeJS.ReadableStream = process.stdin, output: NodeJS.WritableStream = process.stdout): Promise<void> {
  const restoreConsole = divertConsoleToStderr();
  try {
    for await (const event of boundedLines(input, MCP_MAX_LINE_BYTES)) {
      if (event.kind === 'overflow') {
        output.write(`${JSON.stringify(error(null, -32700, 'Invalid JSON.'))}\n`);
        continue;
      }
      if (event.text.trim().length === 0) continue;
      let request: unknown;
      try { request = JSON.parse(event.text); } catch { output.write(`${JSON.stringify(error(null, -32700, 'Invalid JSON.'))}\n`); continue; }
      const result = await handleMcpRequest(request);
      if (result !== null) output.write(`${JSON.stringify(result)}\n`);
    }
  } finally {
    restoreConsole();
  }
}

// The shipped command is `node_modules/.bin/sfscanner-mcp -> ../sfscanner/dist/mcp.js` on
// POSIX and a `.cmd` shim on Windows. Node sets `process.argv[1]` to the resolved (not
// realpath'd) argument, so a filename suffix cannot recognise the symlink. Compare the
// real path of both sides instead. Only the argv candidate is allowed to fail resolution:
// a missing/nonexistent argv[1] means "not the entry", and an imported module keeps
// exporting the handler without starting the transport.
function isMainEntry(): boolean {
  const candidate = process.argv[1];
  if (!candidate) return false;
  let resolved: string;
  try { resolved = realpathSync(candidate); } catch { return false; }
  return resolved === realpathSync(fileURLToPath(import.meta.url));
}

if (isMainEntry()) await runMcpStdio();
