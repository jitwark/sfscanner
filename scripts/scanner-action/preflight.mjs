import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseStrictJson, sha256Bytes, validateReleasePolicy, validateReleaseReceipt } from './release-contract.mjs';

const MAX_JSON_BYTES = 256 * 1024;

function readJson(filePath, label) {
  try {
    const bytes = fs.readFileSync(filePath);
    if (bytes.length === 0 || bytes.length > MAX_JSON_BYTES) return { ok: false, code: `${label}_SIZE_INVALID` };
    return { ok: true, bytes, value: parseStrictJson(bytes.toString('utf8')) };
  } catch (error) {
    if (error?.code === 'ENOENT') return { ok: false, code: `${label}_MISSING` };
    if (error?.code === 'DUPLICATE_JSON_KEY') return { ok: false, code: `${label}_DUPLICATE_KEY` };
    return { ok: false, code: `${label}_UNREADABLE` };
  }
}

export function validateActionPreflight({ policy, receipt, receiptSha256, actionRepository }) {
  const checkedPolicy = validateReleasePolicy(policy);
  if (!checkedPolicy.ok) return checkedPolicy;
  if (checkedPolicy.policy.status !== 'ACCEPTED') return Object.freeze({ ok: false, code: 'FINAL_RELEASE_RECEIPT_NOT_CONFIGURED' });
  const checkedReceipt = validateReleaseReceipt(receipt);
  if (!checkedReceipt.ok) return checkedReceipt;
  if (receiptSha256 !== checkedPolicy.policy.releaseReceiptSha256) return Object.freeze({ ok: false, code: 'RELEASE_RECEIPT_DIGEST_MISMATCH' });
  if (actionRepository !== checkedPolicy.policy.actionRepository) return Object.freeze({ ok: false, code: 'ACTION_REPOSITORY_MISMATCH' });
  if (checkedReceipt.receipt.scannerRepository !== checkedPolicy.policy.scannerRepository) return Object.freeze({ ok: false, code: 'SCANNER_REPOSITORY_MISMATCH' });
  return Object.freeze({
    ok: true,
    status: 'PASS',
    releaseId: checkedReceipt.receipt.releaseId,
    receiptSha256,
    scannerRepository: checkedReceipt.receipt.scannerRepository,
    scannerRef: checkedReceipt.receipt.scannerRef,
    sourceTreeSha256: checkedReceipt.receipt.sourceTreeSha256,
    lockfileSha256: checkedReceipt.receipt.lockfileSha256,
    packageVersion: checkedReceipt.receipt.package.version,
    packageTarballSha256: checkedReceipt.receipt.package.tarballSha256,
    artifactSetSha256: checkedReceipt.receipt.artifactSetSha256,
    artifacts: checkedReceipt.receipt.artifacts,
  });
}

export function runPreflight({ policyPath, receiptPath, actionRepository }) {
  const policyFile = readJson(policyPath, 'RELEASE_POLICY');
  if (!policyFile.ok) return Object.freeze({ ok: false, code: policyFile.code });
  const policyCheck = validateReleasePolicy(policyFile.value);
  if (!policyCheck.ok) return policyCheck;
  if (policyCheck.policy.status !== 'ACCEPTED') return Object.freeze({ ok: false, code: 'FINAL_RELEASE_RECEIPT_NOT_CONFIGURED' });
  const receiptFile = readJson(receiptPath, 'RELEASE_RECEIPT');
  if (!receiptFile.ok) return Object.freeze({ ok: false, code: receiptFile.code });
  return validateActionPreflight({
    policy: policyFile.value,
    receipt: receiptFile.value,
    receiptSha256: sha256Bytes(receiptFile.bytes),
    actionRepository,
  });
}

/** Production phases derive authority from their own installed Action, never step outputs. */
export function loadBundledRelease() {
  const directory = path.dirname(fileURLToPath(import.meta.url));
  const receiptPath = path.join(directory, 'release-receipt.json');
  const result = runPreflight({
    policyPath: path.join(directory, 'release-policy.json'),
    receiptPath,
    actionRepository: 'jitwark/sfscanner',
  });
  return result.ok ? Object.freeze({ ...result, receiptPath }) : result;
}

function appendOutputs(result) {
  const outputPath = process.env.GITHUB_OUTPUT;
  if (!outputPath) return;
  const values = {
    'release-id': result.releaseId,
    'receipt-sha256': result.receiptSha256,
    'scanner-repository': result.scannerRepository,
    'scanner-ref': result.scannerRef,
    'source-tree-sha256': result.sourceTreeSha256,
    'lockfile-sha256': result.lockfileSha256,
    'package-version': result.packageVersion,
    'package-tarball-sha256': result.packageTarballSha256,
    'artifact-set-sha256': result.artifactSetSha256,
  };
  fs.appendFileSync(outputPath, Object.entries(values).map(([key, value]) => `${key}=${value}\n`).join(''), 'utf8');
}

function parseArgs(argv) {
  const values = {};
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!['--policy', '--receipt', '--action-repository'].includes(key) || value === undefined || seen.has(key)) throw new Error('EXPECTED_PREFLIGHT_ARGUMENTS');
    seen.add(key);
    values[key.slice(2)] = value;
  }
  for (const key of ['policy', 'receipt', 'action-repository']) if (!values[key]) throw new Error('EXPECTED_PREFLIGHT_ARGUMENTS');
  return values;
}

const invoked = process.argv[1] ? path.resolve(process.argv[1]) : '';
const isDirect = invoked !== '' && (process.platform === 'win32' ? invoked.toLowerCase() === fileURLToPath(import.meta.url).toLowerCase() : invoked === fileURLToPath(import.meta.url));
if (isDirect) {
  let code = 2;
  try {
    const args = parseArgs(process.argv.slice(2));
    const result = runPreflight({
      policyPath: path.resolve(args.policy),
      receiptPath: path.resolve(args.receipt),
      actionRepository: args['action-repository'],
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (result.ok) {
      appendOutputs(result);
      code = 0;
    } else {
      code = 1;
    }
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ ok: false, code: error.message })}\n`);
  }
  process.exitCode = code;
}
