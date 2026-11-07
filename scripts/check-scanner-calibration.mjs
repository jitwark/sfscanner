import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { calibrationCases } from '../pipeline/calibration/calibration-cases.ts';
import { runCalibration } from '../pipeline/calibration/calibration-runner.ts';

const EXPECTED_CASE_COUNT = 27;
const EXPECTED_SPLITS = { development: 14, holdout: 13 };
const REQUIRED_ADVERSARIAL_CASE_IDS = [
  'adversarial-cyclic-graph',
  'adversarial-deep-connections',
  'adversarial-wide-graph',
  'adversarial-wide-parameters',
  'adversarial-huge-parameter-value',
  'adversarial-oversized-workflow',
  'adversarial-unicode-controls',
  'adversarial-malformed-unicode',
  'adversarial-repeated-javascript-findings',
  'adversarial-repeated-python-findings',
  'adversarial-unsupported-language',
  'adversarial-malformed-javascript',
];
const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

export function validateCalibrationReport(report) {
  const errors = [];
  if (!isRecord(report) || report.caseCount !== EXPECTED_CASE_COUNT) {
    errors.push(`calibration case count must be ${EXPECTED_CASE_COUNT}`);
  }
  const splits = isRecord(report?.splitCounts) ? report.splitCounts : {};
  if (splits.development !== EXPECTED_SPLITS.development || splits.holdout !== EXPECTED_SPLITS.holdout) {
    errors.push(`calibration split counts must be development=${EXPECTED_SPLITS.development} and holdout=${EXPECTED_SPLITS.holdout}`);
  }
  const cases = Array.isArray(report?.cases) ? report.cases : [];
  const caseIds = new Set();
  for (const item of cases) {
    if (!isRecord(item) || typeof item.caseId !== 'string') {
      errors.push('calibration case result is malformed');
    } else if (!Array.isArray(item.identityMismatches) || item.identityMismatches.length > 0) {
      errors.push(`${item.caseId} has identity mismatches`);
    } else if (caseIds.has(item.caseId)) {
      errors.push(`${item.caseId} is duplicated`);
    }
    if (isRecord(item) && typeof item.caseId === 'string') caseIds.add(item.caseId);
  }
  if (cases.length !== EXPECTED_CASE_COUNT) errors.push('calibration case results are incomplete');
  for (const caseId of REQUIRED_ADVERSARIAL_CASE_IDS) {
    if (!caseIds.has(caseId)) errors.push(`required adversarial case is missing: ${caseId}`);
  }
  return { ok: errors.length === 0, errors };
}

export function runCalibrationGate() {
  const report = runCalibration(calibrationCases);
  return { report, validation: validateCalibrationReport(report) };
}

export function main(io = { stdout: process.stdout, stderr: process.stderr }) {
  try {
    const { report, validation } = runCalibrationGate();
    if (!validation.ok) {
      for (const error of validation.errors) io.stderr.write(`Scanner calibration gate failed: ${error}\n`);
      return 1;
    }
    io.stdout.write(`Scanner calibration passed: ${report.caseCount} synthetic cases; ${report.falseNegativeProbeIds.length} declared false-negative probes.\n`);
    return 0;
  } catch (error) {
    io.stderr.write(`Scanner calibration gate failed: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  process.exitCode = main();
}
