import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { CorpusAnalytics } from '@hub/contracts';
import { ANALYTICS_SCHEMA_VERSION, assertAnalyticsSchema, readAnalyticsSync, readReleaseSnapshotSync } from './analytics-node';

const analytics = (schemaVersion: number) =>
  ({
    schemaVersion,
    total: 3,
    searchable: 2,
    scanCoverage: { noResult: 0 },
    v2Evidence: {
      states: { current: 0, noResult: 0, historical: 0, unscanned: 0, sourceUnavailable: 0 },
      current: { complete: 0, degraded: 0, indeterminate: 0 },
    },
    nodeCoverage: {},
  } as unknown as CorpusAnalytics);

describe('readReleaseSnapshotSync', () => {
  const originalCwd = process.cwd();
  const roots: string[] = [];

  afterEach(() => {
    process.chdir(originalCwd);
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });

  function treeWith(manifest: unknown): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'release-snapshot-'));
    roots.push(root);
    fs.mkdirSync(path.join(root, 'data'), { recursive: true });
    fs.writeFileSync(path.join(root, 'data', 'manifest.json'), JSON.stringify(manifest));
    process.chdir(root);
    return root;
  }

  it('returns the corpus snapshot and digest the analytics belong to', () => {
    const sha = 'a'.repeat(64);
    treeWith({ generatedAt: '2026-10-20T00:00:00.000Z', metadata: { corpusSha256: sha } });

    expect(readReleaseSnapshotSync()).toEqual({ generatedAt: '2026-10-20T00:00:00.000Z', corpusSha256: sha });
  });

  it('refuses a manifest without a corpus digest rather than rendering half an identity', () => {
    treeWith({ generatedAt: '2026-10-20T00:00:00.000Z', metadata: {} });

    expect(() => readReleaseSnapshotSync()).toThrow(/corpusSha256/);
  });
});

describe('assertAnalyticsSchema', () => {
  /**
   * The rename from `indexable` to `searchable` bumped `schemaVersion`, and a
   * version nobody reads is decorative. Without this guard a schema-1 artifact —
   * a stale local copy, an older release asset, a half-finished sync — yields
   * `searchable: undefined`, and the site header, home page and analytics page
   * render a broken count instead of failing. Same principle as the fingerprint
   * secret: refuse rather than emit something wrong.
   */
  it('refuses an artifact from the previous schema instead of rendering undefined', () => {
    expect(() => assertAnalyticsSchema(analytics(1), 'data/analytics.json')).toThrow(/schemaVersion 1/);
  });

  /**
   * Schema 3 carried coverage counts derived from a version-string stamp and a
   * top-20 node list. Reading it as schema 4 would render v2 provenance and node
   * coverage that artifact never had, so the older shape is refused too.
   */
  it('refuses the previous schema, not only the oldest one', () => {
    expect(() => assertAnalyticsSchema(analytics(3), 'data/analytics.json')).toThrow(/schemaVersion 3/);
  });

  it('names the file and the fix, because the reader has to act on it', () => {
    expect(() => assertAnalyticsSchema(analytics(99), 'some/path.json')).toThrow(
      /some\/path\.json.*derive-analytics/s,
    );
  });

  it('accepts the current schema', () => {
    expect(() => assertAnalyticsSchema(analytics(ANALYTICS_SCHEMA_VERSION), 'ok.json')).not.toThrow();
  });
});

describe('readAnalyticsSync', () => {
  const originalCwd = process.cwd();
  const roots: string[] = [];

  afterEach(() => {
    process.chdir(originalCwd);
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });

  function treeWithAnalytics(raw: string): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'analytics-reader-'));
    roots.push(root);
    fs.mkdirSync(path.join(root, 'data'), { recursive: true });
    fs.writeFileSync(path.join(root, 'data', 'analytics.json'), raw);
    process.chdir(root);
    return root;
  }

  /**
   * The reader's user-visible promise is "an old artifact fails at build time".
   * Testing only the pure guard would stay green if the reader stopped calling it.
   */
  it('refuses a schema-3 artifact it finds on disk, naming the file', () => {
    treeWithAnalytics(JSON.stringify({ schemaVersion: 3, total: 1 }));

    expect(() => readAnalyticsSync()).toThrow(/data[\\/]analytics\.json.*schemaVersion 3/s);
  });

  it('names the candidate path when the artifact is not valid JSON', () => {
    treeWithAnalytics('{"schemaVersion": 4,');

    expect(() => readAnalyticsSync()).toThrow(/data[\\/]analytics\.json.*invalid JSON/s);
  });

  it('refuses a schema-4 artifact missing the v2 blocks instead of rendering holes', () => {
    treeWithAnalytics(JSON.stringify({ schemaVersion: 4, total: 1 }));

    expect(() => readAnalyticsSync()).toThrow(/missing v2Evidence/);
  });

  it('refuses a partial schema-4 artifact whose v2 blocks predate the noResult state', () => {
    treeWithAnalytics(
      JSON.stringify({
        schemaVersion: 4,
        total: 1,
        scanCoverage: { noResult: 0 },
        v2Evidence: {
          states: { current: 1, historical: 0, unscanned: 0, sourceUnavailable: 0 },
          current: { complete: 1, degraded: 0, indeterminate: 0 },
        },
        nodeCoverage: {},
      }),
    );

    expect(() => readAnalyticsSync()).toThrow(/missing v2Evidence\.states\.noResult/);
  });
});
