import { readFile } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_SCANNER_LIMITS_V2 } from '@hub/contracts';
import { buildBaselineV2Report, validateBaselineV2Report } from './measure-scanner-v2.mjs';

export const MAX_BOUND_LATENCY_MS = 5_000;
export const P95_RATCHET = 1.2;
export const MICRO_LATENCY_BASELINE_THRESHOLD_MS = 25;
export const MICRO_LATENCY_FLOOR_MS = 5;
export const MICRO_LATENCY_HARD_CEILING_MS = MICRO_LATENCY_BASELINE_THRESHOLD_MS;
export const CROSS_MACHINE_POLICY = Object.freeze({
  adrPath: 'docs/decisions/scanner-v2-performance-budget.md',
  adrJustification: 'Cross-machine CI is not comparable for p95; this named policy retains byte and max-bound checks.',
});
const ROOT = resolve(import.meta.dirname, '..');
const LIMITS = Object.freeze({ maxSerializedResultBytes: DEFAULT_SCANNER_LIMITS_V2.maxSerializedResultBytes, maxEvidenceBytes: DEFAULT_SCANNER_LIMITS_V2.maxEvidenceBytes, maxRedactedArtifactBytes: DEFAULT_SCANNER_LIMITS_V2.maxRedactedArtifactBytes });
const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const rootPath = (value) => value instanceof URL ? fileURLToPath(value) : value === undefined ? ROOT : resolve(String(value));

function adrException(options) {
  if (!isRecord(options) || typeof options.adrPath !== 'string' || options.adrPath.length === 0 || typeof options.adrJustification !== 'string' || options.adrJustification.trim().length === 0 || /[\u0000-\u001f\u007f]/.test(options.adrJustification)) return false;
  const adrPath = options.adrPath.replaceAll('\\', '/');
  if (adrPath.split('/').includes('..') || isAbsolute(adrPath)) return false;
  try {
    const root = rootPath(options.root); const path = resolve(root, adrPath); const withinRoot = relative(root, path);
    return withinRoot !== '' && !withinRoot.startsWith('..') && !isAbsolute(withinRoot) && existsSync(path) && statSync(path).isFile();
  } catch { return false; }
}
function schemaFailure(label, report) {
  const validation = validateBaselineV2Report(report);
  return validation.ok ? [] : [`${label} schema validation failed: ${validation.errors.join('; ')}`];
}
function caseMap(report) { return new Map(report.cases.map((item) => [item.key, item])); }
function measurementPolicyMatches(baseline, current) {
  return ['warmups', 'samples', 'batches', 'aggregation'].every((key) => baseline.measurement[key] === current.measurement[key]);
}
function checkCeilings(failures, item) {
  // The third row is bounded by `maxRedactedArtifactBytes` but measures the aliased serialized size:
  // redaction-v2 is unwired, so no redacted artifact exists to measure (task 5.2a).
  const checks = [['serialized', item.serializedBytes.max, LIMITS.maxSerializedResultBytes], ['evidence', item.evidenceBytes.max, LIMITS.maxEvidenceBytes], ['redacted artifact (aliases the serialized size; redaction-v2 is unwired)', item.redactedArtifactBytes.max, LIMITS.maxRedactedArtifactBytes]];
  for (const [name, actual, maximum] of checks) if (actual > maximum) failures.push(`${item.key} ${name} bytes ${actual} exceed ceiling ${maximum}`);
  if (item.fixtureClass === 'max-bound' && item.latencyMs.max > MAX_BOUND_LATENCY_MS) failures.push(`${item.key} max-bound latency ${item.latencyMs.max}ms exceeds 5,000ms`);
  if (item.fixtureClass === 'max-bound' && item.kind === 'valid' && item.outcome !== 'SUCCESS') failures.push(`${item.key} max-bound case did not return a successful closed scanner outcome`);
}
function checkRatchet(failures, baseline, current) {
  const baselineCases = caseMap(baseline);
  for (const item of current.cases) {
    const prior = baselineCases.get(item.key); if (!prior) continue;
    if (item.inputSha256 !== prior.inputSha256) continue;
    const { budgetMs, policy } = latencyBudgetForBaselineP95(prior.budgetBaselineP95Ms ?? prior.latencyMs.p95);
    if (policy === 'micro-floor' && item.latencyMs.p95 > MICRO_LATENCY_HARD_CEILING_MS) failures.push(`${item.key} latency p95 ${item.latencyMs.p95}ms exceeds hard micro-latency ceiling ${MICRO_LATENCY_HARD_CEILING_MS}ms p95`);
    if (item.latencyMs.p95 > budgetMs) failures.push(`${item.key} latency p95 ${item.latencyMs.p95}ms exceeds ${policy === 'micro-floor' ? 'micro floor' : `proportional ${P95_RATCHET * 100}%`} budget ${budgetMs}ms`);
  }
  if (current.cases.length !== baseline.cases.length) failures.push('current and baseline fixture case counts differ');
}
function checkFixtureIdentity(failures, baseline, current) {
  const baselineCases = caseMap(baseline);
  for (const item of current.cases) {
    const prior = baselineCases.get(item.key); if (!prior) continue;
    if (item.id !== prior.id
      || item.kind !== prior.kind
      || item.fixtureClass !== prior.fixtureClass
      || item.inputSha256 !== prior.inputSha256
      || item.profile?.id !== prior.profile?.id
      || item.profile?.version !== prior.profile?.version) {
      failures.push(`${item.key} fixture identity differs from the pinned baseline`);
    }
  }
}
export function latencyBudgetForBaselineP95(baselineP95) {
  const micro = baselineP95 < MICRO_LATENCY_BASELINE_THRESHOLD_MS;
  return {
    budgetMs: micro ? Math.max(baselineP95 * P95_RATCHET, baselineP95 + MICRO_LATENCY_FLOOR_MS) : baselineP95 * P95_RATCHET,
    policy: micro ? 'micro-floor' : 'proportional',
  };
}


export function compareScannerV2Budget(baseline, current, options = {}) {
  const failures = [...schemaFailure('baseline', baseline), ...schemaFailure('current', current)];
  if (failures.length) return { ok: false, comparable: false, p95Comparable: false, waived: false, failures };
  const policyMatch = measurementPolicyMatches(baseline, current);
  if (!policyMatch) failures.push('measurement policy mismatch; baseline and current must use the same samples, warmups, batches, and aggregation');
  const baselineCases = caseMap(baseline); const currentCases = caseMap(current);
  for (const key of baselineCases.keys()) if (!currentCases.has(key)) failures.push(`current report is missing fixture ${key}`);
  for (const item of current.cases) if (!baselineCases.has(item.key)) failures.push(`current report has unapproved fixture ${item.key}`);
  checkFixtureIdentity(failures, baseline, current);
  for (const item of current.cases) checkCeilings(failures, item);
  const comparable = baseline.environment.digest === current.environment.digest;
  // The named cross-machine policy makes the p95 dimension incomparable regardless of the digest:
  // the digest records node/platform/arch/CPU but no load, thermal or co-tenancy state, so a
  // matching digest cannot establish a quiet host. Byte ceilings and max-bound deadlines below
  // stay enforced either way; see the F-018 owner amendment (2026-09-27) in the referenced ADR.
  const crossMachinePolicy = adrException(options);
  const p95Comparable = comparable && !crossMachinePolicy;
  const waived = !comparable && policyMatch && crossMachinePolicy;
  if (!comparable && !waived) failures.push('environment digest mismatch; comparison is not comparable without an existing ADR and justification');
  if (p95Comparable && policyMatch) checkRatchet(failures, baseline, current);
  return { ok: failures.length === 0, comparable, p95Comparable, waived, failures };
}
function parseArgs(args) {
  const options = { baselinePath: resolve(ROOT, 'docs/scanner/baseline-v2.json'), currentPath: undefined, adrPath: undefined, adrJustification: undefined };
  const valueFor = (index, flag) => {
    const value = args[index + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`missing value for ${flag}`);
    return value;
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--baseline') options.baselinePath = resolve(valueFor(index++, arg));
    else if (arg === '--current') options.currentPath = resolve(valueFor(index++, arg));
    else if (arg === '--adr') options.adrPath = valueFor(index++, arg);
    else if (arg === '--reason') options.adrJustification = valueFor(index++, arg);
    else throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}
async function main() {
  const options = parseArgs(process.argv.slice(2)); const baseline = JSON.parse(await readFile(options.baselinePath, 'utf8')); const current = options.currentPath ? JSON.parse(await readFile(options.currentPath, 'utf8')) : await buildBaselineV2Report();
  const result = compareScannerV2Budget(baseline, current, { ...options, root: ROOT });
  const policyEngaged = result.waived || (result.comparable && !result.p95Comparable);
  const policyNote = policyEngaged ? ' (cross-machine ADR policy: the p95 latency dimension was NOT compared; byte ceilings and max-bound deadlines were enforced)' : '';
  if (!result.ok) { console.error(`Scanner v2 performance budget failed${result.comparable === false ? ' (not comparable or resource regression)' : ''}${policyNote}`); for (const failure of result.failures) console.error(`- ${failure}`); process.exitCode = 1; return; }
  console.log(`Scanner v2 performance budget passed${policyNote}.`);
}
const invoked = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (invoked) { try { await main(); } catch (cause) { console.error(`Scanner v2 budget comparison failed: ${cause instanceof Error ? cause.message : String(cause)}`); process.exitCode = 1; } }
