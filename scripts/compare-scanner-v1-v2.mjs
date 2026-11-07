import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';

const { register } = await import('tsx/esm/api');
register();
const [{ parseWorkflowJson }, { scanWorkflowWithCore }, v2, registry] = await Promise.all([
  import('../packages/scanner-core/src/workflow.ts'),
  import('../pipeline/scan/scanner-core-adapter.ts'),
  import('../packages/scanner-core/src/v2/index.ts'),
  import('../packages/scanner-core/src/v2/admitted-registry.ts'),
]);

const fixtureDirectory = resolve(process.argv[2] ?? 'D:/projects/secureflow-scanner-backups/scanner-comparison-fixtures-2026-09-11');
const outputPath = resolve(process.argv[3] ?? 'D:/projects/secureflow-scanner-backups/scanner-v1-v2-comparison-2026-09-11.json');
const forbidden = /SAFE_VALUE|UNTRUSTED_VALUE|password|secret|token|Bearer/i;

function timed(run) {
  const started = performance.now();
  try {
    const value = run();
    return { value, elapsedMs: Number((performance.now() - started).toFixed(3)), crash: false };
  } catch (error) {
    return {
      value: undefined,
      elapsedMs: Number((performance.now() - started).toFixed(3)),
      crash: true,
      errorClass: error instanceof Error ? error.constructor.name : 'UnknownError',
    };
  }
}

function scanV1(text) {
  const parsed = parseWorkflowJson(text);
  if (!parsed.ok) return { status: 'INDETERMINATE', code: parsed.code, findings: [] };
  const result = scanWorkflowWithCore(parsed.workflow, { policyProfile: 'beta-hardened' });
  return {
    status: result.analysisStatus,
    findings: result.findings.map(({ policyId, severity }) => ({ policyId, severity })),
  };
}

function scanV2(text) {
  const result = v2.scanWorkflowV2({
    bytes: new TextEncoder().encode(text),
    profile: { id: registry.ADMITTED_PROFILE_ID, version: registry.ADMITTED_PROFILE_VERSION },
  });
  if (!result.ok) return { status: 'FAILURE', code: result.code, findings: [], diagnostics: [] };
  return {
    status: result.result.analysis.status,
    findings: result.result.findings.map(({ ruleId, severity, applicability, traceRefs }) => ({
      ruleId,
      severity,
      applicability,
      traceCount: traceRefs.length,
    })),
    diagnostics: result.result.analysis.diagnostics.map(({ code }) => code),
    grade: result.result.assessment?.grade ?? null,
  };
}

const rows = [];
for (const fileName of (await readdir(fixtureDirectory)).filter((name) => name.endsWith('.json')).sort()) {
  const text = await readFile(join(fixtureDirectory, fileName), 'utf8');
  const v1 = timed(() => scanV1(text));
  const v2Result = timed(() => scanV2(text));
  const serialized = JSON.stringify({ v1: v1.value, v2: v2Result.value });
  if (forbidden.test(serialized)) throw new Error(`sanitization failed for ${fileName}`);
  rows.push({
    id: fileName.replace(/\.json$/u, ''),
    v1: v1.value,
    v2: v2Result.value,
    elapsedMs: { v1: v1.elapsedMs, v2: v2Result.elapsedMs },
    crashes: { v1: v1.crash, v2: v2Result.crash },
    errorClasses: { v1: v1.errorClass ?? null, v2: v2Result.errorClass ?? null },
  });
}
if (rows.length !== 5 || rows.some(({ crashes }) => crashes.v1 || crashes.v2)) {
  throw new Error('comparison did not produce five crash-free fixture rows');
}
await writeFile(
  outputPath,
  `${JSON.stringify({ schemaVersion: 'scanner-v1-v2-comparison-v1', fixtureCount: rows.length, rows }, null, 2)}\n`,
  'utf8',
);
process.stdout.write(`${JSON.stringify({ outputPath, fixtureCount: rows.length, rows })}\n`);
