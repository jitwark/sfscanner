/**
 * The immutable-release primitives shared by the release writer and the rollback
 * drill. A release section is a directory plus a record of every file in it
 * (`path`, `byteSize`, `sha256`) and a bundle hash over those records, so a release
 * can be re-verified from the bytes on disk alone. Both commands use this module
 * rather than their own copy: a writer and a verifier that disagree about what a
 * release is are the defect this layer exists to prevent.
 */
import { createHash } from 'node:crypto';
import { lstat, open, readFile, readdir, rename, unlink } from 'node:fs/promises';
import path from 'node:path';

export const SECTION_HASH_SUFFIX = 'Sha256';
export const comparePaths = (left, right) => (left < right ? -1 : left > right ? 1 : 0);
export const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
export const fail = (message) => { throw new Error(message); };
export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

export const inside = (parent, child) => {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
};

export async function regularFile(file, label) {
  const info = await lstat(file).catch(() => null);
  if (!info) fail(`${label} is missing`);
  if (!info.isFile()) fail(`${label} is not a regular file`);
  return readFile(file);
}

export async function directory(directoryPath, label) {
  const info = await lstat(directoryPath).catch(() => null);
  if (!info) fail(`${label} is missing`);
  if (!info.isDirectory()) fail(`${label} is not a directory`);
}

export async function jsonFile(file, label, withBytes = false) {
  const bytes = await regularFile(file, label);
  let value;
  try {
    value = JSON.parse(bytes.toString('utf8'));
  } catch {
    fail(`${label} is not valid JSON`);
  }
  return withBytes ? { value, bytes } : value;
}

export function validateId(value, label = 'release ID') {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._+-]*$/u.test(value)) fail(`${label} is invalid`);
  return value;
}

/** A section is the keys of a release record that carry artifact records, not identity prose. */
export function isArtifactSection(value, artifactSchema) {
  return record(value) && value.schemaVersion === artifactSchema && typeof value.sha256 === 'string' && Array.isArray(value.artifacts);
}

export function validateArtifactList(section, name, artifactSchema) {
  if (!record(section) || section.schemaVersion !== artifactSchema || !/^[a-f0-9]{64}$/u.test(section.sha256) || !Array.isArray(section.artifacts)) {
    fail(`${name} has an invalid or mixed schema`);
  }
  const seen = new Set();
  const artifacts = section.artifacts.map((artifact) => {
    if (!record(artifact) || typeof artifact.path !== 'string' || !artifact.path || artifact.path.includes('\\') ||
      path.posix.normalize(artifact.path) !== artifact.path || artifact.path === '.' || artifact.path === '..' ||
      artifact.path.startsWith('/') || artifact.path.startsWith('../') ||
      !Number.isSafeInteger(artifact.byteSize) || artifact.byteSize < 0 || !/^[a-f0-9]{64}$/u.test(artifact.sha256)) {
      fail(`${name} has an invalid artifact record`);
    }
    if (seen.has(artifact.path)) fail(`${name} has a duplicate artifact path`);
    seen.add(artifact.path);
    return artifact;
  });
  const sorted = [...artifacts].sort((left, right) => comparePaths(left.path, right.path));
  if (artifacts.some((artifact, index) => artifact.path !== sorted[index].path)) fail(`${name} artifact list is not canonical`);
  return artifacts;
}

export async function filesIn(directoryPath, relative = '') {
  const entries = await readdir(directoryPath, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const child = path.join(directoryPath, entry.name);
    const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.name.includes('\\')) fail(`backslash in discovered release name: ${childRelative}`);
    if (entry.isSymbolicLink()) fail(`symlink is not allowed in release artifacts: ${childRelative}`);
    if (entry.isDirectory()) files.push(...await filesIn(child, childRelative));
    else if (entry.isFile()) files.push({ path: childRelative, file: child });
    else fail(`unsupported filesystem entry in release artifacts: ${childRelative}`);
  }
  return files.sort((left, right) => comparePaths(left.path, right.path));
}

/**
 * Builds the section record a staged directory will be published as. Files are hashed one
 * at a time: a release section is hundreds of megabytes, so holding the whole tree in
 * memory would make the writer fail on exactly the releases it exists to protect.
 *
 * `transform` is how the verifier re-derives a section whose published form is not its
 * source form — the staged site rewrites `robots.txt` and every HTML `<head>`. The writer
 * stages through the transform and the verifier describes the source through the *same*
 * one, so the two cannot disagree about what the published bytes are.
 */
export async function describeSection(directoryPath, artifactSchema, transform = (relative, bytes) => bytes) {
  const files = await filesIn(directoryPath);
  const digest = createHash('sha256');
  const artifacts = [];
  for (const file of files) {
    const bytes = transform(file.path, await readFile(file.file));
    digest.update(file.path); digest.update('\0'); digest.update(bytes); digest.update('\0');
    artifacts.push({ path: file.path, byteSize: bytes.length, sha256: sha256(bytes) });
  }
  return Object.freeze({ schemaVersion: artifactSchema, sha256: digest.digest('hex'), artifacts: Object.freeze(artifacts) });
}

/** Re-hashes a published section from disk, a file at a time, and refuses any difference. */
export async function verifySection(releaseRoot, name, section, artifactSchema) {
  const sectionRoot = path.join(releaseRoot, name);
  await directory(sectionRoot, `${name} artifact directory`);
  const actual = await filesIn(sectionRoot);
  const expected = validateArtifactList(section, name, artifactSchema);
  if (actual.length !== expected.length || actual.some((item, index) => item.path !== expected[index].path)) {
    fail(`${name} artifacts do not exactly match the recorded release`);
  }
  const digest = createHash('sha256');
  for (const [index, item] of actual.entries()) {
    const bytes = await readFile(item.file);
    const artifact = expected[index];
    if (bytes.length !== artifact.byteSize || sha256(bytes) !== artifact.sha256) {
      fail(`corrupt release: ${name}/${item.path} hash or byte size mismatch`);
    }
    digest.update(item.path); digest.update('\0'); digest.update(bytes); digest.update('\0');
  }
  if (digest.digest('hex') !== section.sha256) fail(`corrupt release: ${name} package hash mismatch`);
  return section.sha256;
}

/** The sections a release record declares, in canonical order. */
export function declaredSections(releaseValue, artifactSchema) {
  return Object.entries(releaseValue)
    .filter(([, value]) => isArtifactSection(value, artifactSchema))
    .map(([name]) => name)
    .sort(comparePaths);
}

/**
 * Writes a single mutable file — the active-release pointer or the ledger — through an
 * exclusive sibling and an atomic replace, so a reader never observes a half-written
 * authority and an interrupted write leaves the previous value in place.
 */
export async function replacePointer(pointerPath, value, replace = rename) {
  let temporary;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const candidate = `${pointerPath}.tmp-${process.pid}-${attempt}`;
    try {
      const handle = await open(candidate, 'wx', 0o600);
      try { await handle.writeFile(value, 'utf8'); await handle.sync(); } finally { await handle.close(); }
      temporary = candidate;
      break;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }
  }
  if (!temporary) fail('unable to create an exclusive pointer staging file');
  try { await replace(temporary, pointerPath); } catch (error) {
    await unlink(temporary).catch(() => {});
    throw new Error(`atomic fixture pointer replacement failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}
