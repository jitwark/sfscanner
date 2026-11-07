import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const TEST_ONLY_SEAL_SCHEMA = 'scanner-test-seal-v1';
const ALLOWED_DESCRIPTOR_KEYS = ['schemaVersion', 'mode', 'createdAt', 'artifacts'];
const ALLOWED_ARTIFACT_KEYS = ['path', 'byteLength', 'sha256'];
const SHA256_HEX = /^[0-9a-f]{64}$/u;
const MAX_ARTIFACT_COUNT = 100;
const MAX_PATH_LENGTH = 1024;

function sha256Bytes(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function checkContainedPath(candidateDir, relPath) {
  if (typeof relPath !== 'string' || relPath.length === 0 || relPath.length > MAX_PATH_LENGTH) {
    return { ok: false, reason: 'ARTIFACT_PATH_INVALID' };
  }
  if (relPath.includes('\\') || relPath.includes(':') || relPath.startsWith('/')) {
    return { ok: false, reason: 'ARTIFACT_PATH_INVALID' };
  }
  const segments = relPath.split('/');
  if (segments.some((seg) => seg === '..' || seg === '.' || seg === '')) {
    return { ok: false, reason: 'ARTIFACT_PATH_TRAVERSAL' };
  }
  const resolved = path.resolve(candidateDir, relPath);
  const relative = path.relative(candidateDir, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    return { ok: false, reason: 'ARTIFACT_PATH_TRAVERSAL' };
  }
  return { ok: true, resolved };
}

export function computeArtifactEntry(filePath, relativePath) {
  const bytes = fs.readFileSync(filePath);
  return {
    path: relativePath.replace(/\\/g, '/'),
    byteLength: bytes.length,
    sha256: sha256Bytes(bytes),
  };
}

export function createTestOnlySeal(candidateDir, files) {
  if (!Array.isArray(files) || files.length === 0 || files.length > MAX_ARTIFACT_COUNT) {
    throw new TypeError('files must be a non-empty array within artifact limits');
  }
  const seenPaths = new Set();
  const entries = files.map((rel) => {
    const pathCheck = checkContainedPath(candidateDir, rel);
    if (!pathCheck.ok) throw new Error(`Invalid candidate path: ${rel} (${pathCheck.reason})`);
    if (seenPaths.has(rel)) throw new Error(`Duplicate artifact path: ${rel}`);
    seenPaths.add(rel);
    const candidateReal = fs.realpathSync(candidateDir);
    const fileReal = fs.realpathSync(pathCheck.resolved);
    const realRel = path.relative(candidateReal, fileReal);
    if (realRel.startsWith('..') || path.isAbsolute(realRel)) {
      throw new Error(`Artifact symlink escapes candidate directory: ${rel}`);
    }
    return computeArtifactEntry(pathCheck.resolved, rel);
  });
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const descriptor = {
    schemaVersion: TEST_ONLY_SEAL_SCHEMA,
    mode: 'TEST_ONLY',
    createdAt: '2026-10-26T00:00:00.000Z',
    artifacts: entries,
  };
  const canonicalJsonText = JSON.stringify(descriptor, null, 2);
  return {
    descriptor,
    canonicalJsonText,
    sealSha256: sha256Bytes(Buffer.from(canonicalJsonText, 'utf8')),
  };
}

const EXECUTABLE_EXTS = new Set(['.js', '.mjs', '.cjs', '.node', '.exe', '.cmd', '.bat', '.sh']);

function findCandidateFiles(dir) {
  const results = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...findCandidateFiles(full));
    } else if (entry.isFile()) {
      results.push(full);
    }
  }
  return results;
}

export function verifyTestOnlyConformance({
  sealPath,
  candidateDir,
  expectedSealSha256,
  requiredArtifacts = null,
  isProduction = false,
}) {
  if (isProduction) {
    return { ok: false, reason: 'TEST_ONLY_SEAL_NOT_PERMITTED_IN_PRODUCTION' };
  }
  if (!expectedSealSha256 || typeof expectedSealSha256 !== 'string' || !SHA256_HEX.test(expectedSealSha256)) {
    return { ok: false, reason: 'SEAL_DIGEST_REQUIRED' };
  }
  if (!fs.existsSync(sealPath)) {
    return { ok: false, reason: 'SEAL_MISSING' };
  }
  let parsed;
  try {
    const raw = fs.readFileSync(sealPath, 'utf8');
    const actualDigest = sha256Bytes(Buffer.from(raw, 'utf8'));
    if (actualDigest !== expectedSealSha256) {
      return { ok: false, reason: 'SEAL_DIGEST_MISMATCH' };
    }
    parsed = JSON.parse(raw);
  } catch (err) {
    return { ok: false, reason: 'SEAL_MALFORMED', error: err.message };
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, reason: 'SEAL_SCHEMA_MISMATCH' };
  }
  const topKeys = Object.keys(parsed);
  if (topKeys.some((k) => !ALLOWED_DESCRIPTOR_KEYS.includes(k))) {
    return { ok: false, reason: 'SEAL_SCHEMA_EXTRA_PROPERTIES' };
  }
  if (parsed.schemaVersion !== TEST_ONLY_SEAL_SCHEMA || parsed.mode !== 'TEST_ONLY') {
    return { ok: false, reason: 'SEAL_SCHEMA_MISMATCH' };
  }
  if (!Array.isArray(parsed.artifacts) || parsed.artifacts.length === 0) {
    return { ok: false, reason: 'SEAL_EMPTY_ARTIFACTS' };
  }
  if (parsed.artifacts.length > MAX_ARTIFACT_COUNT) {
    return { ok: false, reason: 'SEAL_ARTIFACTS_OVERSIZED' };
  }

  const candidateReal = fs.existsSync(candidateDir) ? fs.realpathSync(candidateDir) : null;
  if (!candidateReal) {
    return { ok: false, reason: 'CANDIDATE_DIR_MISSING' };
  }

  const seenArtifactPaths = new Set();
  const checkedArtifacts = [];
  for (const artifact of parsed.artifacts) {
    if (artifact === null || typeof artifact !== 'object' || Array.isArray(artifact)) {
      return { ok: false, reason: 'ARTIFACT_ENTRY_MALFORMED' };
    }
    const artifactKeys = Object.keys(artifact);
    if (artifactKeys.some((k) => !ALLOWED_ARTIFACT_KEYS.includes(k))) {
      return { ok: false, reason: 'ARTIFACT_ENTRY_EXTRA_PROPERTIES' };
    }
    const pathCheck = checkContainedPath(candidateDir, artifact.path);
    if (!pathCheck.ok) {
      return { ok: false, reason: pathCheck.reason, file: artifact.path };
    }
    if (seenArtifactPaths.has(artifact.path)) {
      return { ok: false, reason: 'ARTIFACT_DUPLICATE_ENTRY', file: artifact.path };
    }
    seenArtifactPaths.add(artifact.path);

    if (typeof artifact.byteLength !== 'number' || !Number.isSafeInteger(artifact.byteLength) || artifact.byteLength < 0) {
      return { ok: false, reason: 'ARTIFACT_BYTE_LENGTH_INVALID', file: artifact.path };
    }
    if (typeof artifact.sha256 !== 'string' || !SHA256_HEX.test(artifact.sha256)) {
      return { ok: false, reason: 'ARTIFACT_SHA256_INVALID', file: artifact.path };
    }
    checkedArtifacts.push({ artifact, fullPath: pathCheck.resolved });
  }
  if (Array.isArray(requiredArtifacts)) {
    const declaredPaths = new Set(parsed.artifacts.map((a) => (a && typeof a === 'object' ? a.path : null)));
    for (const req of requiredArtifacts) {
      if (!declaredPaths.has(req)) {
        return { ok: false, reason: 'REQUIRED_ARTIFACT_MISSING', file: req };
      }
    }
  }

  const declaredSet = new Set(checkedArtifacts.map(({ artifact }) => artifact.path));
  const candidateFiles = findCandidateFiles(candidateDir);
  for (const filePath of candidateFiles) {
    const rel = path.relative(candidateDir, filePath).replace(/\\/g, '/');
    const ext = path.extname(rel).toLowerCase();
    if (EXECUTABLE_EXTS.has(ext) && !declaredSet.has(rel)) {
      return { ok: false, reason: 'UNEXPECTED_EXECUTABLE_ASSET', file: rel };
    }
  }


  for (const { artifact, fullPath } of checkedArtifacts) {
    if (!fs.existsSync(fullPath)) {
      return { ok: false, reason: 'ARTIFACT_MISSING', file: artifact.path };
    }

    try {
      const fileReal = fs.realpathSync(fullPath);
      const realRel = path.relative(candidateReal, fileReal);
      if (realRel.startsWith('..') || path.isAbsolute(realRel)) {
        return { ok: false, reason: 'ARTIFACT_SYMLINK_ESCAPE', file: artifact.path };
      }
    } catch {
      return { ok: false, reason: 'ARTIFACT_ACCESS_FAILED', file: artifact.path };
    }

    const bytes = fs.readFileSync(fullPath);
    if (bytes.length !== artifact.byteLength) {
      return { ok: false, reason: 'ARTIFACT_SIZE_MISMATCH', file: artifact.path };
    }
    const actualDigest = sha256Bytes(bytes);
    if (actualDigest !== artifact.sha256) {
      return { ok: false, reason: 'ARTIFACT_DIGEST_MISMATCH', file: artifact.path };
    }
  }

  return { ok: true, status: 'CONFORMANT_TEST_ONLY', artifactCount: parsed.artifacts.length };
}
