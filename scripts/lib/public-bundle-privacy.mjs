/**
 * Sweep the exact bundle a release would promote: every string leaf of every
 * declared relation, reported as field paths and counts.
 *
 * This gate reads the promoted directory rather than pipeline intermediates.
 * It never prints a matched value: a gate that logs the addresses it found has
 * published them into retained CI output.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { MATCHERS, sweepCorpusPrivacy } from './corpus-privacy.mjs';

/**
 * Mirrors contracts/public-data-model.ts. The colocated test imports both
 * contract lists and fails on drift, so this plain-Node gate cannot silently
 * leave a relation unswept.
 */
export const PUBLIC_RELATION_NAMES = Object.freeze([
  'releases', 'workflows', 'sources', 'findings', 'integrations', 'tags', 'triggers',
  'workflowIntegrations', 'workflowTags', 'workflowTriggers', 'credentials', 'domains',
  'communityNodes', 'requirements', 'exclusions', 'artifacts',
]);
export const PUBLIC_RELATION_NAMES_V4 = Object.freeze([
  ...PUBLIC_RELATION_NAMES, 'preflightCoverage', 'preflightEvidence',
]);

const V3 = 'public-data-model-v3';
const V4 = 'public-data-model-v4';
const SCHEMA_RELATIONS = new Map([
  [V3, PUBLIC_RELATION_NAMES],
  [V4, PUBLIC_RELATION_NAMES_V4],
]);
const HASH = /^[0-9a-f]{64}$/;

function readJson(filePath, label) {
  if (!fs.existsSync(filePath)) throw new Error(`public bundle privacy: missing ${filePath}`);
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new Error(`public bundle privacy: malformed ${label} ${filePath}`, { cause: error });
  }
}

function expectedRelations(schemaVersion) {
  const relations = SCHEMA_RELATIONS.get(schemaVersion);
  if (!relations) throw new Error(`public bundle privacy: unsupported schema version ${String(schemaVersion)}`);
  return relations;
}

function requireFileMetadata(file, relation) {
  if (typeof file?.sha256 !== 'string' || !HASH.test(file.sha256)) {
    throw new Error(`public bundle privacy: ${relation} sha256 must be lowercase SHA-256`);
  }
  for (const field of ['byteSize', 'rowCount']) {
    if (!Number.isSafeInteger(file[field]) || file[field] < 0) {
      throw new Error(`public bundle privacy: ${relation} ${field} must be a non-negative integer`);
    }
  }
}

/**
 * Both manifests and the release row declare the same schema and identity.
 * The file list is closed, ordered, unique, and uses exact bare shard names.
 */
function readBundleManifest(bundleDir) {
  const rootPath = path.join(bundleDir, 'public-release.json');
  const ndjsonPath = path.join(bundleDir, 'ndjson', 'public-release.json');
  const root = readJson(rootPath, 'root manifest');
  const ndjson = readJson(ndjsonPath, 'manifest');
  if (!root || typeof root !== 'object' || Array.isArray(root)) {
    throw new Error('public bundle privacy: root manifest must be an object');
  }
  if (!root.schemaVersion) throw new Error('public bundle privacy: unsupported schema version missing');
  const relations = expectedRelations(root.schemaVersion);
  if (ndjson?.schemaVersion !== root.schemaVersion) {
    throw new Error(
      `public bundle privacy: mixed schema versions root=${String(root.schemaVersion)} ndjson=${String(ndjson?.schemaVersion)}`,
    );
  }
  if (typeof root.releaseId !== 'string' || root.releaseId === '') {
    throw new Error('public bundle privacy: root manifest releaseId must be a non-empty string');
  }
  if (ndjson.releaseId !== root.releaseId) {
    throw new Error(`public bundle privacy: release id mismatch root=${root.releaseId} ndjson=${String(ndjson.releaseId)}`);
  }
  if (!Array.isArray(ndjson.files)) throw new Error('public bundle privacy: manifest must declare a files array');
  if (ndjson.files.length !== relations.length) {
    throw new Error(`public bundle privacy: manifest must declare exactly ${relations.length} relations`);
  }
  const ndjsonDir = path.resolve(bundleDir, 'ndjson');
  const seen = new Set();
  for (const [index, file] of ndjson.files.entries()) {
    const relation = file?.relation;
    if (typeof relation !== 'string' || !relations.includes(relation)) {
      throw new Error(`public bundle privacy: unknown relation ${String(relation)}`);
    }
    if (seen.has(relation)) throw new Error(`public bundle privacy: duplicate relation ${relation}`);
    seen.add(relation);
    if (typeof file.path !== 'string') {
      throw new Error(`public bundle privacy: manifest path for ${relation} must be ${relation}.ndjson inside ndjson/`);
    }
    const resolved = path.resolve(ndjsonDir, file.path);
    if (path.dirname(resolved) !== ndjsonDir) {
      throw new Error(`public bundle privacy: ${relation} path is outside ndjson/`);
    }
    if (file.path !== `${relation}.ndjson`) {
      throw new Error(`public bundle privacy: manifest path for ${relation} must be ${relation}.ndjson inside ndjson/`);
    }
    if (relation !== relations[index]) {
      throw new Error(`public bundle privacy: relation order mismatch at ${relations[index]}`);
    }
    requireFileMetadata(file, relation);
  }
  if (!root.relations || typeof root.relations !== 'object' || Array.isArray(root.relations)) {
    throw new Error('public bundle privacy: root manifest has no relations map');
  }
  if (JSON.stringify(Object.keys(root.relations)) !== JSON.stringify([...relations])) {
    throw new Error('public bundle privacy: root manifest relation set or order mismatch');
  }
  for (const file of ndjson.files) {
    if (root.relations[file.relation] !== file.rowCount) {
      throw new Error(`public bundle privacy: root relation row count mismatch for ${file.relation}`);
    }
  }
  if (root.formats?.ndjson?.files !== relations.length) {
    throw new Error(`public bundle privacy: root manifest ndjson file count must be ${relations.length}`);
  }
  return { schemaVersion: root.schemaVersion, releaseId: root.releaseId, files: ndjson.files };
}

/** Every string reachable from one row, keyed by dotted/indexed field path. */
function textFields(value, prefix, out) {
  if (typeof value === 'string') { out.push([prefix, value]); return out; }
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) textFields(item, `${prefix}[${index}]`, out);
    return out;
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) textFields(item, prefix === '' ? key : `${prefix}.${key}`, out);
  }
  return out;
}

/**
 * Every declared shard must match its own manifest metadata before its rows
 * can be swept. Empty relations are empty files; non-empty shards require a
 * final newline and contain no blank rows.
 */
function readRows(bundleDir, file) {
  const filePath = path.join(bundleDir, 'ndjson', file.path);
  if (!fs.existsSync(filePath)) throw new Error(`public bundle privacy: missing ${file.relation}.ndjson`);
  const bytes = fs.readFileSync(filePath);
  if (bytes.byteLength !== file.byteSize) {
    throw new Error(`public bundle privacy: ${file.relation} byte size mismatch (${bytes.byteLength} != ${file.byteSize})`);
  }
  const digest = crypto.createHash('sha256').update(bytes).digest('hex');
  if (digest !== file.sha256) throw new Error(`public bundle privacy: ${file.relation} SHA-256 checksum mismatch`);
  const contents = bytes.toString('utf8');
  if (contents === '') {
    if (file.rowCount !== 0) throw new Error(`public bundle privacy: ${file.relation} row count mismatch`);
    return [];
  }
  if (!contents.endsWith('\n')) throw new Error(`public bundle privacy: ${file.relation}.ndjson is missing its final newline`);
  const lines = contents.slice(0, -1).split('\n');
  if (lines.some((line) => line === '')) throw new Error(`public bundle privacy: ${file.relation}.ndjson contains a blank line`);
  if (lines.length !== file.rowCount) throw new Error(`public bundle privacy: ${file.relation} row count mismatch`);
  return lines.map((line, index) => {
    try {
      const value = JSON.parse(line);
      if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error(`public bundle privacy: ${file.relation} row ${index + 1} is not an object`);
      }
      return value;
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('public bundle privacy:')) throw error;
      throw new Error(`public bundle privacy: malformed JSON row ${index + 1} in ${file.relation}.ndjson`, { cause: error });
    }
  });
}

/** Every string leaf of every row of every declared relation. */
export function* bundleDocuments(bundleDir) {
  const manifest = readBundleManifest(bundleDir);
  for (const file of manifest.files) {
    const rows = readRows(bundleDir, file);
    if (file.relation === 'releases' && (
      rows.length !== 1 ||
      rows[0]?.schemaVersion !== manifest.schemaVersion ||
      rows[0]?.releaseId !== manifest.releaseId
    )) {
      throw new Error(`public bundle privacy: release row schema or identity mismatch for ${manifest.releaseId}`);
    }
    for (const [index, row] of rows.entries()) {
      for (const [fieldPath, text] of textFields(row, '', [])) {
        yield { id: `${file.relation}:${index}:${fieldPath}`, text };
      }
    }
  }
}

export function sweepBundle(bundleDir) {
  return sweepCorpusPrivacy(bundleDocuments(bundleDir));
}
/**
 * Field paths and affected-field counts per matcher; never a matched value.
 * @param {{ totals: Record<string, number>, entriesAffected: Record<string, string[]>, scanned: number }} result
 * @returns {Record<string, [string, number][]>}
 */
export function summaryFieldPaths(result) {
  const summary = {};
  for (const [matcher, ids] of Object.entries(result.entriesAffected)) {
    const counts = new Map();
    for (const id of ids) {
      const fieldPath = id.split(':').slice(2).join(':');
      counts.set(fieldPath, (counts.get(fieldPath) ?? 0) + 1);
    }
    summary[matcher] = [...counts.entries()].sort(([left], [right]) => (left < right ? -1 : 1));
  }
  return summary;
}

/**
 * The committed baseline is totals only. A malformed or incomplete baseline is
 * a boundary failure, never "no limit": an absent total would otherwise read
 * as an absent ceiling and let every regression through as a pass.
 * @param {unknown} baseline
 */
export function baselineTotals(baseline) {
  const totals = baseline?.totals;
  if (totals === null || typeof totals !== 'object' || Array.isArray(totals)) {
    throw new Error('public bundle privacy: baseline has no totals object');
  }
  const validated = {};
  for (const matcher of MATCHERS) {
    const value = totals[matcher.name];
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`public bundle privacy: baseline has no valid total for ${matcher.name}`);
    }
    validated[matcher.name] = value;
  }
  return validated;
}

/** Matchers whose count is now above their baseline total, as printable lines. */
export function regressions(result, totals) {
  return MATCHERS
    .filter((matcher) => result.totals[matcher.name] > totals[matcher.name])
    .map((matcher) => `${matcher.name}: ${result.totals[matcher.name]} occurrences, baseline ${totals[matcher.name]}`);
}
