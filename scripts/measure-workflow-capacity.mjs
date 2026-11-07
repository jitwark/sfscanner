#!/usr/bin/env node
// Evidence-only capacity audit. Writes JSONL to stdout and never refreshes a p95 or budget baseline.
// Each fixture runs in a fresh Node process with a bounded heap and deadline; one JSON record per
// fixture states count, status, diagnostic codes, stored-span usage, node count, and elapsed time.
// The command is a verification-wave step and is not run by the test suite.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { freemem } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SCHEMA = 'scanner-capacity-audit-v1';
const COUNTS = Object.freeze([2083, 2084, 5000, 5001]);
const CHILD_DEADLINE_MS = 120_000;
const MAX_BUFFER_BYTES = 8 * 1024 * 1024;
const CHILD_HEAP_MB = 512;
// The orchestrator needs 2 GiB of headroom beside the child's 512 MB heap.
const ORCHESTRATOR_FLOOR_BYTES = 2 * 1024 ** 3;
const MIN_FREE_MEMORY_BYTES = ORCHESTRATOR_FLOOR_BYTES + CHILD_HEAP_MB * 1024 ** 2;
const CHILD_STDERR_CAP = 2_000;
// Exact rows for the four-member fixture: 12 spans per node minus 4 for the chain. A drift in the
// parser's span accounting or in `maxStoredSourceSpans` must fail this audit, not pass unnoticed.
const SPAN_BUDGET = 25_000;
const EXPECTED = Object.freeze({
  2083: Object.freeze({ status: 'COMPLETE', examined: 24_992, omitted: 0 }),
  2084: Object.freeze({ status: 'DEGRADED', examined: 25_004, omitted: 4 }),
  5000: Object.freeze({ status: 'DEGRADED', examined: 59_996, omitted: 34_996 }),
});
const NODE_OPTIONS = [process.env.NODE_OPTIONS, `--max-old-space-size=${CHILD_HEAP_MB}`].filter(Boolean).join(' ');

// Four members per node: `parameters` is omitted, so the parser charges 12 spans per node. That
// shape is what makes 2,083 the last admitted stored-span count (24,992 spans) and 2,084 the first
// omission (25,004). A five-member node charges 13 spans and moves that boundary.
const CHILD_SOURCE = [
  "const { freemem } = await import('node:os');",
  "const { resolve } = await import('node:path');",
  "const { pathToFileURL } = await import('node:url');",
  "const root = process.argv[process.argv.length - 2];",
  "const count = Number(process.argv[process.argv.length - 1]);",
  "const { scanWorkflowV2 } = await import(pathToFileURL(resolve(root, 'packages/scanner-core/src/v2/index.ts')).href);",
  "const nodes = Array.from({ length: count }, (_, index) => ({ id: 'n' + index, name: 'N' + index, type: 'n8n-nodes-base.noOp', typeVersion: 1 }));",
  "const connections = Object.fromEntries(Array.from({ length: Math.max(0, count - 1) }, (_, index) => ['N' + index, { main: [[{ node: 'N' + (index + 1), type: 'main', index: 0 }]] }]));",
  "const bytes = new TextEncoder().encode(JSON.stringify({ nodes, connections }));",
  "const startedAt = performance.now();",
  "const result = scanWorkflowV2({ bytes, profile: { id: 'beta-default', version: '2.0.0' } });",
  "const scanMs = Math.round(performance.now() - startedAt);",
  "const usage = result.ok ? result.result.limits.usage : [];",
  "const spanUsage = usage.find(({ id }) => id === 'maxStoredSourceSpans') ?? null;",
  "const examinedNodes = usage.find(({ id }) => id === 'maxNodes')?.examined ?? null;",
  "process.stdout.write(JSON.stringify({",
  "  schemaVersion: 'scanner-capacity-child-v1',",
  "  count,",
  "  ok: result.ok,",
  "  status: result.ok ? result.result.analysis.status : null,",
  "  diagnostics: result.ok ? result.result.analysis.diagnostics.map(({ code }) => code).sort() : [],",
  "  spanUsage,",
  "  examinedNodes,",
  "  code: result.ok ? null : result.code,",
  "  cause: result.ok ? null : (result.cause ?? null),",
  "  scanMs,",
  "  freeMemoryBytes: freemem(),",
  "}) + '\\n');",
].join('\n');

function preflight() {
  const required = [
    'packages/scanner-core/src/v2/index.ts',
    'packages/scanner-core/src/v2/scan-workflow.ts',
    'contracts/scanner-limits-v2.ts',
    'node_modules/tsx/dist/cli.mjs',
  ];
  for (const file of required) {
    if (!existsSync(resolve(ROOT, file))) throw new Error(`source preflight failed: ${file} is missing`);
  }
  const free = freemem();
  if (free < MIN_FREE_MEMORY_BYTES) {
    throw new Error(`source preflight failed: ${free} bytes free, need ${MIN_FREE_MEMORY_BYTES}`);
  }
}

function run(count) {
  const argv = [process.execPath, '--import', 'tsx', '--input-type=module', '-e', CHILD_SOURCE, ROOT, String(count)];
  const startedAt = Date.now();
  const child = spawnSync(argv[0], argv.slice(1), {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: CHILD_DEADLINE_MS,
    maxBuffer: MAX_BUFFER_BYTES,
    env: { ...process.env, NODE_OPTIONS },
  });
  const wallMs = Date.now() - startedAt;
  const timedOut = child.error?.code === 'ETIMEDOUT';
  const line = (child.stdout ?? '').trim().split('\n').filter(Boolean).at(-1);
  let childResult;
  try {
    childResult = line === undefined ? null : JSON.parse(line);
  } catch {
    childResult = null;
  }
  return {
    schemaVersion: SCHEMA,
    argv,
    count,
    exit: child.status,
    wallMs,
    timedOut,
    ...(childResult ?? {}),
    childStderr: (child.stderr ?? '').trim().slice(0, CHILD_STDERR_CAP),
  };
}

export function violation(record) {
  if (record.timedOut) return 'child exceeded the deadline';
  if (record.exit !== 0) return `child exited ${record.exit}`;
  if (record.count === 5001) {
    return record.ok === false && record.code === 'WORKFLOW_TOO_COMPLEX' && record.cause === 'NODE_LIMIT'
      ? null : '5,001 nodes must fail WORKFLOW_TOO_COMPLEX/NODE_LIMIT';
  }
  if (record.ok !== true) return 'admitted count did not scan';
  if (record.examinedNodes !== record.count) return `examined node count ${record.examinedNodes} !== ${record.count}`;
  const expected = EXPECTED[record.count];
  if (expected === undefined) return 'unexpected fixture count';
  if (record.status !== expected.status) return `${record.count} must be ${expected.status}, observed ${record.status}`;
  const span = record.spanUsage;
  if (span === null || typeof span !== 'object') return `${record.count} has no stored-span usage row`;
  if (span.maximum !== SPAN_BUDGET) return `stored-span maximum ${span.maximum} !== ${SPAN_BUDGET}`;
  if (span.examined !== expected.examined) return `stored-span examined ${span.examined} !== ${expected.examined}`;
  if (span.omitted !== expected.omitted) return `stored-span omitted ${span.omitted} !== ${expected.omitted}`;
  if (span.exhausted !== (expected.omitted > 0)) return `stored-span exhausted ${span.exhausted} is inconsistent with ${expected.omitted} omitted`;
  const optional = Array.isArray(record.diagnostics) && record.diagnostics.includes('OPTIONAL_LIMIT_EXCEEDED');
  if (optional !== (expected.omitted > 0)) {
    return `OPTIONAL_LIMIT_EXCEEDED present=${optional} is inconsistent with ${expected.omitted} omitted`;
  }
  return null;
}

function main() {
  preflight();
  let failed = false;
  for (const count of COUNTS) {
    const record = run(count);
    const problem = violation(record);
    if (problem !== null) failed = true;
    process.stdout.write(JSON.stringify({ ...record, assertion: problem === null ? 'PASS' : 'FAIL', assertionMessage: problem }) + '\n');
  }
  if (failed) process.exitCode = 1;
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.url === pathToFileURL(invokedPath).href) main();
