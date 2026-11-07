import fs from 'node:fs';
import path from 'node:path';
import type { CorpusAnalytics } from '@hub/contracts';

/** The only artifact shape this build understands. Bumped with the contract. */
export const ANALYTICS_SCHEMA_VERSION = 4;

/**
 * Pure so it can be tested without touching the filesystem.
 *
 * The first version of its test wrote a fixture to `public/data/analytics.json`
 * and restored it afterwards. That directory is a *generated* one this module
 * searches first, vitest runs with the workspace root as cwd, and the restore
 * only ran when a backup existed — so on a tree without one it left a schema-1
 * file behind that shadowed the real artifact and broke five unrelated tests.
 * A unit test that mutates a shared generated path is not a unit test.
 */
export function assertAnalyticsSchema(parsed: CorpusAnalytics, source: string): void {
  if (parsed.schemaVersion !== ANALYTICS_SCHEMA_VERSION) {
    throw new Error(
      `${source}: analytics schemaVersion ${parsed.schemaVersion}, this build reads ` +
        `${ANALYTICS_SCHEMA_VERSION}. Re-derive it with scripts/derive-analytics.ts.`,
    );
  }
  const partial = (field: string) =>
    new Error(
      `${source}: schemaVersion ${ANALYTICS_SCHEMA_VERSION} artifact is missing ${field}. ` +
        'A partial sync is not a valid artifact; re-derive it with scripts/derive-analytics.ts.',
    );
  for (const field of ['v2Evidence', 'nodeCoverage', 'scanCoverage'] as const) {
    const value = parsed[field];
    if (typeof value !== 'object' || value === null) throw partial(field);
  }
  // Checked before any component formats a count: a schema-4 artifact rebuilt by
  // an older generator has no noResult state, and reading it would silently fold
  // engine refusals into "current" or print `undefined`.
  const integers: [string, unknown][] = [
    ['scanCoverage.noResult', (parsed.scanCoverage as { noResult?: unknown }).noResult],
    ['v2Evidence.states.noResult', (parsed.v2Evidence as { states?: { noResult?: unknown } }).states?.noResult],
    ['v2Evidence.states.current', (parsed.v2Evidence as { states?: { current?: unknown } }).states?.current],
    ['v2Evidence.states.historical', (parsed.v2Evidence as { states?: { historical?: unknown } }).states?.historical],
    ['v2Evidence.states.unscanned', (parsed.v2Evidence as { states?: { unscanned?: unknown } }).states?.unscanned],
    ['v2Evidence.states.sourceUnavailable', (parsed.v2Evidence as { states?: { sourceUnavailable?: unknown } }).states?.sourceUnavailable],
    ['v2Evidence.current.complete', (parsed.v2Evidence as { current?: { complete?: unknown } }).current?.complete],
    ['v2Evidence.current.degraded', (parsed.v2Evidence as { current?: { degraded?: unknown } }).current?.degraded],
    ['v2Evidence.current.indeterminate', (parsed.v2Evidence as { current?: { indeterminate?: unknown } }).current?.indeterminate],
  ];
  for (const [field, value] of integers) {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw partial(field);
  }
}

/**
 * A half-written or partially synced artifact is the failure this reader exists
 * to surface, so the error has to name the file the operator must fix — a bare
 * `SyntaxError` from one of four candidate paths names nothing.
 */
function readJson(file: string): unknown {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    throw new Error(`${file}: could not be read (${error instanceof Error ? error.message : 'unknown error'})`);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${file}: invalid JSON (${error instanceof Error ? error.message : 'unknown error'})`);
  }
}

/**
 * Server-only reader for `analytics.json`, mirroring `manifest-node.ts`.
 *
 * The page used to reach this artifact with a static `import` of
 * `../../../data/analytics.json`, which makes the bundler resolve a generated
 * directory at build time: that route failed *typecheck and build* with
 * module-not-found where every sibling route fails at runtime with a findable
 * error instead. Same candidate walk as its siblings, same failure mode.
 *
 * The version check is what makes `schemaVersion` mean something. Schema 1
 * called this field `indexable`; reading such an artifact — a stale local copy,
 * an older release asset, a half-finished sync — would yield
 * `searchable: undefined` and put a broken count in the site header, on the home
 * page and on the analytics page, silently. Refusing to load is the same choice
 * the fingerprint secret makes: fail rather than emit something wrong.
 *
 * Schema 3 narrowed `scanCoverage` to explicit row states and replaced
 * `findings.cleanWorkflows` with `cleanScanned`/`noFindingsRecorded`. A schema-2
 * artifact read by this build would report every row as scanned and a clean rate
 * drawn from the whole catalogue, so it is refused for the same reason.
 *
 * Schema 4 adds the admitted v2 identity (`v2Evidence`) and node-semantics
 * coverage (`nodeCoverage`). Neither can be derived from a schema-3 artifact: its
 * coverage numbers came from a version-string stamp and its node list was a top-20
 * slice. Reading one here would render v2 provenance the release never had, so it
 * is refused rather than presented with blanks.
 */
export function readAnalyticsSync(): CorpusAnalytics {
  const cwd = process.cwd();
  const candidates = [
    path.join(cwd, 'public', 'data', 'analytics.json'),
    path.join(cwd, 'app', 'public', 'data', 'analytics.json'),
    path.join(cwd, 'data', 'analytics.json'),
    path.join(cwd, '..', 'data', 'analytics.json'),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      const parsed = readJson(candidate) as CorpusAnalytics;
      assertAnalyticsSchema(parsed, candidate);
      return parsed;
    }
  }

  throw new Error(`analytics.json not found in candidate paths: ${candidates.join(', ')}`);
}

/**
 * The release snapshot an analytics artifact belongs to, read from the sibling
 * `manifest.json`.
 *
 * `analytics.json` deliberately carries no release id — the id is sealed after
 * analytics is derived — so the page states provenance from the corpus manifest
 * instead of inventing an identity. Read raw rather than through `parseManifest`
 * because the shared contract type drops `metadata`, and `corpusSha256` is the
 * one value the reader needs; the two required fields are validated here rather
 * than trusted by shape.
 */
export type ReleaseSnapshot = { generatedAt: string; corpusSha256: string };

export function readReleaseSnapshotSync(): ReleaseSnapshot {
  const cwd = process.cwd();
  const candidates = [
    path.join(cwd, 'public', 'data', 'manifest.json'),
    path.join(cwd, 'app', 'public', 'data', 'manifest.json'),
    path.join(cwd, 'data', 'manifest.json'),
    path.join(cwd, '..', 'data', 'manifest.json'),
  ];

  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) continue;
    const parsed = readJson(candidate) as {
      generatedAt?: unknown;
      metadata?: { corpusSha256?: unknown };
    };
    const generatedAt = parsed.generatedAt;
    const corpusSha256 = parsed.metadata?.corpusSha256;
    if (typeof generatedAt !== 'string' || !Number.isFinite(Date.parse(generatedAt))) {
      throw new Error(`${candidate}: manifest generatedAt is missing or not an ISO timestamp`);
    }
    if (typeof corpusSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(corpusSha256)) {
      throw new Error(`${candidate}: manifest metadata.corpusSha256 is missing or not a lowercase SHA-256`);
    }
    return { generatedAt, corpusSha256 };
  }

  throw new Error(`manifest.json not found in candidate paths: ${candidates.join(', ')}`);
}
