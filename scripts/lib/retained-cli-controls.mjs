import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { mcpSession, probeInstalledMcpEntry } from './packed-mcp-entry.mjs';

const CLEAN = { name: 'clean', nodes: [{ id: 's', name: 'Start', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: [0, 0], parameters: {} }], connections: {}, active: false, settings: {} };
const RISKY = { ...CLEAN, name: 'risky', nodes: [...CLEAN.nodes, { id: 'r', name: 'Run', type: 'n8n-nodes-base.executeCommand', typeVersion: 1, position: [240, 0], parameters: { command: 'printf hi' } }] };

export function retainedEnvelope(text) {
  const value = JSON.parse(text);
  const keys = ['schemaVersion', 'tool', 'artifacts', 'invocation', 'results', 'summary', 'exitReason'];
  if (value.schemaVersion !== 'n8n-scan-v2' || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(keys.sort()) || !Array.isArray(value.results)) throw new Error('Invalid retained CLI envelope');
  return value;
}

export function retainedNdjson(text) {
  const rows = text.trim().split('\n').map((line) => JSON.parse(line));
  if (JSON.stringify(rows.map((row) => row.type)) !== JSON.stringify(['header', 'result', 'result', 'summary']) || rows.some((row) => row.schemaVersion !== 'n8n-scan-v2-ndjson')) throw new Error('Invalid retained NDJSON records');
  return rows;
}

export function retainedMcpSession(messages, exitCode = 0) {
  return messages[0]?.result?.protocolVersion === '2025-06-18'
    && JSON.stringify(messages[1]?.result?.tools?.map((tool) => tool.name)) === JSON.stringify(['n8n_scan'])
    && messages[2]?.result?.isError === false && messages[2]?.result?.structuredContent?.exitCode === exitCode;
}

export function runRetainedCliControls({ run, consumer, installed }) {
  const checks = [];
  const check = (id, pass) => { checks.push({ id, status: pass ? 'pass' : 'fail' }); };
  const guardedRun = run;
  const cli = (inputs, args = [], options = {}) => guardedRun(process.execPath, [path.join(installed, 'dist', 'main.js'), '--schema', 'v2', 'scan', ...inputs, ...args], { cwd: consumer, ...options });
  const json = (result) => retainedEnvelope(result.stdout);
  writeFileSync(path.join(consumer, 'clean.json'), JSON.stringify(CLEAN));
  writeFileSync(path.join(consumer, 'risky.json'), JSON.stringify(RISKY));
  const clean = cli(['clean.json']); const risky = cli(['risky.json']);
  check('clean-json', clean.status === 0 && json(clean).exitReason === 'UNDER_THRESHOLD' && json(clean).results[0]?.ok === true
    && JSON.stringify(Object.keys(json(clean).results[0]).sort()) === JSON.stringify(['input', 'ok', 'result']));
  check('risky-json', risky.status === 1 && json(risky).exitReason === 'FINDING_THRESHOLD' && json(risky).results[0]?.ok === true && json(risky).results[0].result.findings.length > 0);
  const stdin = cli(['-'], [], { input: JSON.stringify(CLEAN) });
  check('stdin', stdin.status === 0 && json(stdin).results[0]?.ok === true && json(stdin).results[0].input === '-');
  const ndjson = cli(['clean.json', 'risky.json'], ['--format', 'ndjson']);
  const lines = retainedNdjson(ndjson.stdout);
  check('ndjson', ndjson.status === 1 && lines[1].item.input === 'clean.json' && lines[2].item.input === 'risky.json' && lines[3].exitReason === 'FINDING_THRESHOLD');
  const table = cli(['clean.json'], ['--format', 'table']);
  check('table', table.status === 0 && table.stdout.includes('Input') && !table.stdout.trimStart().startsWith('{'));
  const sarif = cli(['risky.json'], ['--format', 'sarif']);
  const sarifValue = JSON.parse(sarif.stdout);
  check('sarif', sarif.status === 1 && sarifValue.version === '2.1.0' && sarifValue.runs[0]?.results?.length > 0);
  const readiness = cli(['clean.json'], ['--include-readiness', '--n8n-version', '2.45.6']);
  const readyEnvelope = JSON.parse(readiness.stdout); const ready = readyEnvelope.results?.[0]?.readiness;
  check('readiness-opt-in', readiness.status === 0 && ready?.schemaVersion === 'n8n-preflight-readiness-v1' && ready.completeness !== null && ready.target?.declaredVersion === '2.45.6');
  check('sarif-readiness-refused', cli(['clean.json'], ['--format', 'sarif', '--include-readiness']).status === 2);
  const written = cli(['clean.json'], ['--output', 'report.json']);
  check('atomic-output', written.status === 0 && written.stdout === '' && retainedEnvelope(readFileSync(path.join(consumer, 'report.json'), 'utf8')).results[0]?.ok === true
    && !readdirSync(consumer).some((name) => name.startsWith('.report.json.tmp-')));
  const before = readFileSync(path.join(consumer, 'clean.json'), 'utf8');
  check('collision-refused', cli(['clean.json'], ['--output', 'clean.json']).status === 2 && readFileSync(path.join(consumer, 'clean.json'), 'utf8') === before);
  check('absolute-output-refused', cli(['clean.json'], ['--output', path.join(consumer, 'absolute-report.json')]).status === 2);
  const stdoutOutput = cli(['clean.json'], ['--output', '-']); check('stdout-output', stdoutOutput.status === 0 && json(stdoutOutput).results[0]?.ok === true);
  writeFileSync(path.join(consumer, 'malformed.json'), '{'); const malformed = cli(['malformed.json']);
  check('malformed-input', malformed.status === 3 && json(malformed).results[0]?.ok === false);
  check('second-stdin-refused', cli(['-', '-'], [], { input: JSON.stringify(CLEAN) }).status === 2);
  const guarded = guardedRun(process.execPath, [path.join(installed, 'dist', 'main.js'), '--schema', 'v2', 'scan', 'risky.json'], { cwd: consumer });
  check('offline-scan', guarded.status === 1 && !guarded.stderr.includes('RETAINED_OFFLINE_VIOLATION'));
  const protocol = mcpSession(guardedRun, consumer, process.execPath, [path.join(installed, 'dist', 'mcp.js')]);
  check('mcp-protocol', retainedMcpSession(protocol));
  const riskyMcp = mcpSession(guardedRun, consumer, process.execPath, [path.join(installed, 'dist', 'mcp.js')], [
    '{"jsonrpc":"2.0","id":"entry-i","method":"initialize"}',
    '{"jsonrpc":"2.0","id":"entry-t","method":"tools/list"}',
    '{"jsonrpc":"2.0","id":"entry-c","method":"tools/call","params":{"name":"n8n_scan","arguments":{"inputs":["risky.json"]}}}',
  ]);
  check('mcp-risky-offline', retainedMcpSession(riskyMcp, 1));
  const entry = probeInstalledMcpEntry({ run: guardedRun, consumer, installed, tool: 'n8n_scan' });
  checks.push({ id: 'mcp-installed-entry', ...entry });
  if (process.platform === 'win32') {
    const shim = run('cmd.exe', ['/d', '/c', path.join(consumer, 'node_modules', '.bin', 'sfscanner.cmd'), '--help'], { cwd: consumer });
    check('windows-cli-shim', shim.status === 0 && shim.stdout.length > 0);
    const windowsRun = (command, args, options) => guardedRun(command, args, { ...options, windowsVerbatimArguments: true });
    const messages = mcpSession(windowsRun, consumer, 'cmd.exe', ['/d', '/s', '/c', '""' + path.join(consumer, 'node_modules', '.bin', 'sfscanner-mcp.cmd') + '""']);
    check('windows-mcp-shim', retainedMcpSession(messages));
  }
  return checks;
}
