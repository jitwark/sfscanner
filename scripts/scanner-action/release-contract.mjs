import { createHash } from 'node:crypto';

export const ACTION_REPOSITORY = 'jitwark/sfscanner';
export const ACTION_PATH = '.github/actions/scan';
export const ACTION_POLICY_SCHEMA = 'secureflow-action-release-policy-v1';
export const ACTION_RECEIPT_SCHEMA = 'secureflow-action-release-receipt-v1';
export const ACTION_ARTIFACT_ROOT = 'packages/scanner-cli/dist/';
export const ACTION_TRUST_FILES = Object.freeze([
  'scripts/scanner-action/release-policy.json',
  'scripts/scanner-action/release-receipt.json',
]);
export const REQUIRED_ARTIFACTS = Object.freeze([
  'packages/scanner-cli/dist/index.js',
  'packages/scanner-cli/dist/main.js',
  'packages/scanner-cli/dist/scan-worker.js',
]);

const HASH = /^[0-9a-f]{64}$/u;
const COMMIT = /^[0-9a-f]{40}$/u;
const RELEASE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const SEMVER = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;
const MAX_ARTIFACTS = 512;

const POLICY_KEYS = ['schemaVersion', 'status', 'actionRepository', 'actionPath', 'scannerRepository', 'releaseReceiptSha256'];
const RECEIPT_KEYS = ['schemaVersion', 'status', 'releaseId', 'scannerRepository', 'scannerRef', 'sourceTreeSha256', 'lockfileSha256', 'package', 'artifacts', 'artifactSetSha256'];
const PACKAGE_KEYS = ['name', 'version', 'tarballSha256'];
const ARTIFACT_KEYS = ['path', 'byteLength', 'sha256'];

function strictJsonError(code) {
  const error = new SyntaxError(code);
  error.code = code;
  return error;
}

/** Rejects duplicate object keys before JSON.parse's last-key-wins behaviour can erase them. */
export function parseStrictJson(text) {
  if (typeof text !== 'string') throw strictJsonError('INVALID_JSON');
  let index = 0;

  const whitespace = () => {
    while (index < text.length && /[\u0009\u000a\u000d\u0020]/u.test(text[index])) index += 1;
  };
  const fail = (code = 'INVALID_JSON') => { throw strictJsonError(code); };
  const parseString = () => {
    if (text[index] !== '"') fail();
    const start = index;
    index += 1;
    while (index < text.length) {
      const character = text[index];
      if (character === '"') {
        index += 1;
        try { return JSON.parse(text.slice(start, index)); } catch { fail(); }
      }
      if (character === '\\') index += 2;
      else {
        if (character.charCodeAt(0) < 0x20) fail();
        index += 1;
      }
    }
    fail();
  };
  const parseValue = () => {
    whitespace();
    const character = text[index];
    if (character === '{') {
      index += 1;
      whitespace();
      const keys = new Set();
      if (text[index] === '}') { index += 1; return; }
      while (index < text.length) {
        const key = parseString();
        if (keys.has(key)) fail('DUPLICATE_JSON_KEY');
        keys.add(key);
        whitespace();
        if (text[index] !== ':') fail();
        index += 1;
        parseValue();
        whitespace();
        if (text[index] === '}') { index += 1; return; }
        if (text[index] !== ',') fail();
        index += 1;
        whitespace();
      }
      fail();
    }
    if (character === '[') {
      index += 1;
      whitespace();
      if (text[index] === ']') { index += 1; return; }
      while (index < text.length) {
        parseValue();
        whitespace();
        if (text[index] === ']') { index += 1; return; }
        if (text[index] !== ',') fail();
        index += 1;
      }
      fail();
    }
    if (character === '"') { parseString(); return; }
    if (text.startsWith('true', index)) { index += 4; return; }
    if (text.startsWith('false', index)) { index += 5; return; }
    if (text.startsWith('null', index)) { index += 4; return; }
    const number = text.slice(index).match(/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/u);
    if (number === null) fail();
    index += number[0].length;
  };

  parseValue();
  whitespace();
  if (index !== text.length) fail();
  return JSON.parse(text);
}

export function sha256Bytes(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function artifactSetSha256(artifacts) {
  return sha256Bytes(Buffer.from(canonicalJson(artifacts), 'utf8'));
}

function failure(code, field, detail) {
  return Object.freeze({ ok: false, code, ...(field === undefined ? {} : { field }), ...(detail === undefined ? {} : { detail }) });
}

function exactRecord(value, keys) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function safeArtifactPath(path) {
  return typeof path === 'string' && path.startsWith(ACTION_ARTIFACT_ROOT) && path.length <= 512
    && !path.includes('\\') && !path.includes(':') && !path.includes('//') && !/[\u0000-\u001f\u007f]/u.test(path)
    && path.split('/').every((part) => part !== '' && part !== '.' && part !== '..');
}

function validateArtifacts(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_ARTIFACTS) return failure('ARTIFACT_SET_INVALID', 'artifacts');
  const rows = [];
  const seen = new Set();
  for (const row of value) {
    if (!exactRecord(row, ARTIFACT_KEYS) || !safeArtifactPath(row.path)) return failure('ARTIFACT_ENTRY_INVALID', 'artifacts');
    if (seen.has(row.path)) return failure('ARTIFACT_PATH_DUPLICATE', 'artifacts', row.path);
    if (!Number.isSafeInteger(row.byteLength) || row.byteLength < 0) return failure('ARTIFACT_LENGTH_INVALID', 'artifacts', row.path);
    if (typeof row.sha256 !== 'string' || !HASH.test(row.sha256)) return failure('ARTIFACT_DIGEST_INVALID', 'artifacts', row.path);
    if (rows.length > 0 && rows.at(-1).path >= row.path) return failure('ARTIFACT_ORDER_INVALID', 'artifacts', row.path);
    seen.add(row.path);
    rows.push(Object.freeze({ path: row.path, byteLength: row.byteLength, sha256: row.sha256 }));
  }
  for (const required of REQUIRED_ARTIFACTS) {
    if (!seen.has(required)) return failure('REQUIRED_ARTIFACT_MISSING', 'artifacts', required);
  }
  return Object.freeze({ ok: true, artifacts: Object.freeze(rows) });
}

export function validateReleasePolicy(input) {
  try {
    if (!exactRecord(input, POLICY_KEYS)) return failure('RELEASE_POLICY_SCHEMA_INVALID');
    if (input.schemaVersion !== ACTION_POLICY_SCHEMA) return failure('RELEASE_POLICY_SCHEMA_INVALID');
    if (input.actionRepository !== ACTION_REPOSITORY) return failure('ACTION_REPOSITORY_NOT_FIXED');
    if (input.actionPath !== ACTION_PATH) return failure('ACTION_PATH_NOT_FIXED');
    if (input.scannerRepository !== ACTION_REPOSITORY) return failure('SCANNER_REPOSITORY_NOT_FIXED');
    if (input.status !== 'PENDING_FINAL_CANDIDATE' && input.status !== 'ACCEPTED') return failure('RELEASE_POLICY_STATUS_INVALID');
    if (input.status === 'PENDING_FINAL_CANDIDATE') {
      if (input.releaseReceiptSha256 !== null) return failure('RELEASE_POLICY_PENDING_FIELDS_INVALID');
    } else if (typeof input.releaseReceiptSha256 !== 'string' || !HASH.test(input.releaseReceiptSha256)) {
      return failure('RELEASE_POLICY_ACCEPTED_FIELDS_INVALID');
    }
    return Object.freeze({ ok: true, policy: Object.freeze({ ...input }) });
  } catch {
    return failure('RELEASE_POLICY_SCHEMA_INVALID');
  }
}

export function validateReleaseReceipt(input) {
  try {
    if (!exactRecord(input, RECEIPT_KEYS) || input.schemaVersion !== ACTION_RECEIPT_SCHEMA) return failure('RELEASE_RECEIPT_SCHEMA_INVALID');
    if (input.status !== 'ACCEPTED') return failure('RELEASE_RECEIPT_NOT_ACCEPTED');
    if (typeof input.releaseId !== 'string' || !RELEASE_ID.test(input.releaseId)) return failure('RELEASE_ID_INVALID');
    if (input.scannerRepository !== ACTION_REPOSITORY) return failure('SCANNER_REPOSITORY_NOT_FIXED');
    if (typeof input.scannerRef !== 'string' || !COMMIT.test(input.scannerRef)) return failure('SCANNER_REF_INVALID');
    if (typeof input.sourceTreeSha256 !== 'string' || !HASH.test(input.sourceTreeSha256)) return failure('SOURCE_TREE_DIGEST_INVALID');
    if (typeof input.lockfileSha256 !== 'string' || !HASH.test(input.lockfileSha256)) return failure('LOCKFILE_DIGEST_INVALID');
    if (!exactRecord(input.package, PACKAGE_KEYS) || input.package.name !== 'sfscanner'
      || typeof input.package.version !== 'string' || !SEMVER.test(input.package.version)
      || typeof input.package.tarballSha256 !== 'string' || !HASH.test(input.package.tarballSha256)) {
      return failure('PACKAGE_IDENTITY_INVALID');
    }
    const artifacts = validateArtifacts(input.artifacts);
    if (!artifacts.ok) return artifacts;
    const digest = artifactSetSha256(artifacts.artifacts);
    if (input.artifactSetSha256 !== digest) return failure('ARTIFACT_SET_DIGEST_MISMATCH');
    return Object.freeze({
      ok: true,
      receipt: Object.freeze({
        ...input,
        package: Object.freeze({ ...input.package }),
        artifacts: artifacts.artifacts,
        artifactSetSha256: digest,
      }),
    });
  } catch {
    return failure('RELEASE_RECEIPT_SCHEMA_INVALID');
  }
}
