import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { PUBLIC_DATA_MODEL_SCHEMA_VERSION, type PublicDataProjection, type PublicReleaseMetadata } from '@hub/contracts/public-data-model';
import { makeEntry } from '../__fixtures__/make-entry.js';
import { SCAN_PROVENANCE_CASES, releaseForEntries } from '../__fixtures__/scan-provenance-cases.js';
import { buildPublicProjection } from './public-projection.js';
import { verifySqliteRelease, writeSqliteRelease } from './sqlite.js';
import { PUBLIC_FIELD_DEFINITIONS } from './public-data-dictionary.js';

const tempDirs: string[] = [];
const release: PublicReleaseMetadata = {
  releaseId: 'release-sqlite-test', schemaVersion: PUBLIC_DATA_MODEL_SCHEMA_VERSION,
  generatedAt: '2026-08-30T00:00:00.000Z', toolVersion: 'hub-pipeline@1.0.0', scannerVersion: 'scanner-v1',
  policyVersion: 'policy-v1', searchIndexVersion: 'search-v1', buildRevision: 'revision',
  manifestSha256: 'a'.repeat(64), corpusSha256: 'b'.repeat(64),
  counts: { workflows: 2, redistributable: 1, linkOnly: 1, excluded: 0, findings: 1 },
  facetCounts: { rights: { redistributable: 1, linkOnly: 1, excluded: 0 } },
};

function projection() {
  return buildPublicProjection([
    makeEntry({ id: 'official', source: { kind: 'n8n_official', repo: undefined, path: undefined, commit: undefined }, rights: { status: 'link_only', licence: null, licenceUrl: null }, structure: { integrations: ['slack'], trigger: 'Webhook' } }),
    makeEntry({ id: 'redis', title: 'Unicode café\nquoted "title"\t', description: 'Description\u0001\nwith controls', download: { pack: 0, line: 1, offset: 0, length: 10 }, security: { findings: [{ id: 'policy.secret', title: 'Secret', severity: 'HIGH', why: 'unsafe slack value', fix: 'replace it' }] } }),
  ], { release, bodySha256ByWorkflowId: { redis: 'c'.repeat(64) } });
}

function largeTextProjection() {
  const base = projection();
  const largeDescription = `${'record-'.repeat(32_768)}終端\n`;
  return {
    ...base,
    workflows: base.workflows.map((row) => row.workflowId === 'redis' ? { ...row, description: largeDescription } : row),
  };
}

function databasePath(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-sqlite-'));
  tempDirs.push(directory);
  return path.join(directory, 'release.sqlite');
}

/** 120 workflows x 840 join rows; array proxies make join-scan cost observable without production instrumentation. */
function perfProjection(): PublicDataProjection {
  const entries = Array.from({ length: 120 }, (_, index) => makeEntry({
    id: `perf-${index}`,
    tags: [`tag-${(index * 3) % 400}`, `tag-${(index * 3 + 1) % 400}`, `tag-${(index * 3 + 2) % 400}`],
    structure: {
      integrations: [
        `integration-${(index * 3) % 400}`,
        `integration-${(index * 3 + 1) % 400}`,
        `integration-${(index * 3 + 2) % 400}`,
      ],
      trigger: `trigger-${index % 120}`,
    },
  }));
  return buildPublicProjection(entries, { release: releaseForEntries(entries) });
}

function countJoinReads(data: PublicDataProjection): { projection: PublicDataProjection; reads: () => number } {
  let reads = 0;
  const counted = <T>(rows: readonly T[]): readonly T[] => new Proxy(rows as T[], {
    get(target, property, receiver) {
      if (typeof property === 'string' && /^\d+$/.test(property)) reads += 1;
      return Reflect.get(target, property, receiver);
    },
  });
  return {
    projection: {
      ...data,
      workflowTags: counted(data.workflowTags),
      workflowIntegrations: counted(data.workflowIntegrations),
      workflowTriggers: counted(data.workflowTriggers),
    },
    reads: () => reads,
  };
}

afterEach(() => {
  for (const directory of tempDirs.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe('SQLite public release writer', () => {
  it('writes normalized relations with integrity, FTS, and parity checks', () => {
    const database = databasePath();
    const info = writeSqliteRelease(projection(), database);
    expect(info.logicalSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(verifySqliteRelease(projection(), database)).toBe(true);
    const db = new DatabaseSync(database);
    try {
      expect(db.prepare('PRAGMA foreign_keys').get()).toMatchObject({ foreign_keys: 1 });
      expect(db.prepare('PRAGMA user_version').get()).toMatchObject({ user_version: 2 });
      expect(db.prepare('SELECT count(*) AS count FROM workflows').get()).toMatchObject({ count: 2 });
      expect(db.prepare('SELECT body_path FROM workflows WHERE workflow_id = ?').get('official')).toMatchObject({ body_path: null });
      expect(db.prepare('SELECT title, description FROM workflows WHERE workflow_id = ?').get('redis')).toMatchObject({ title: 'Unicode café\nquoted "title"\t', description: 'Description\u0001\nwith controls' });
      expect(db.prepare('SELECT repository_url, licence, licence_url FROM sources WHERE source_id = (SELECT source_id FROM workflows WHERE workflow_id = ?)').get('official')).toMatchObject({ repository_url: null, licence: null, licence_url: null });
      expect(db.prepare('SELECT workflow_id FROM workflow_search WHERE workflow_search MATCH ?').all('slack')).toEqual(expect.arrayContaining([expect.objectContaining({ workflow_id: 'official' })]));
      expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => (row as { name: string }).name)).toEqual(expect.arrayContaining(['releases', 'workflows', 'findings', 'workflow_search']));
      expect(db.prepare('SELECT count(*) AS count FROM data_dictionary').get()).toMatchObject({ count: PUBLIC_FIELD_DEFINITIONS.length });
      expect(db.prepare('SELECT privacy_rule FROM data_dictionary WHERE relation_name = ? AND field_name = ?').get('workflows', 'body')).toMatchObject({ privacy_rule: 'never inline workflow JSON' });
    } finally {
      db.close();
    }
  });

  it('names every artifacts column as the published dictionary documents it', () => {
    const database = databasePath();
    writeSqliteRelease(projection(), database);
    const db = new DatabaseSync(database);
    try {
      const columns = (db.prepare('PRAGMA table_info(artifacts)').all() as { name: string }[])
        .map((row) => row.name)
        .sort();
      const documented = PUBLIC_FIELD_DEFINITIONS
        .filter((entry) => entry.relation === 'artifacts')
        .map((entry) => entry.field.replace(/[A-Z]/gu, (letter) => `_${letter.toLowerCase()}`))
        .sort();
      expect(columns).toEqual(documented);
      expect(columns).not.toContain('relation_name');
    } finally {
      db.close();
    }
  });

  it('rejects a release with an unexpected SQLite schema version', () => {
    const database = databasePath();
    const data = projection();
    writeSqliteRelease(data, database);
    const db = new DatabaseSync(database);
    try {
      db.exec('PRAGMA user_version = 999');
    } finally {
      db.close();
    }
    expect(() => verifySqliteRelease(data, database)).toThrow(/schema version mismatch/i);
  });

  it('rebuilds with the same logical identity and rejects row drift', () => {
    const first = databasePath();
    const second = databasePath();
    const firstInfo = writeSqliteRelease(projection(), first);
    const secondInfo = writeSqliteRelease(projection(), second);
    expect(firstInfo.logicalSha256).toBe(secondInfo.logicalSha256);
    expect(crypto.createHash('sha256').update(fs.readFileSync(first)).digest('hex')).toMatch(/^[0-9a-f]{64}$/);
    const db = new DatabaseSync(first);
    try {
      db.exec("DELETE FROM findings WHERE workflow_id = 'redis'; DELETE FROM workflow_integrations WHERE workflow_id = 'redis'; DELETE FROM workflow_tags WHERE workflow_id = 'redis'; DELETE FROM workflow_triggers WHERE workflow_id = 'redis'; DELETE FROM requirements WHERE workflow_id = 'redis'; DELETE FROM workflow_search WHERE workflow_id = 'redis'; DELETE FROM workflows WHERE workflow_id = 'redis'");
    } finally {
      db.close();
    }
    expect(() => verifySqliteRelease(projection(), first)).toThrow(/parity|foreign|integrity/i);
  });

  it('rejects missing derived FTS rows during read-back', () => {
    const database = databasePath();
    const data = projection();
    writeSqliteRelease(data, database);
    const db = new DatabaseSync(database);
    try {
      db.prepare('DELETE FROM workflow_search WHERE workflow_id = ?').run('redis');
    } finally {
      db.close();
    }
    expect(() => verifySqliteRelease(data, database)).toThrow(/FTS.*parity/i);
  });

  it('rejects valid non-key logical content drift', () => {
    const database = databasePath();
    const data = projection();
    writeSqliteRelease(data, database);
    const db = new DatabaseSync(database);
    try {
      db.prepare('UPDATE workflows SET title = ? WHERE workflow_id = ?').run('Mutated title', 'redis');
    } finally {
      db.close();
    }
    expect(() => verifySqliteRelease(data, database)).toThrow(/logical content mismatch/i);
  });

  it('preserves a materially large text field and serves read-only analyst queries', () => {
    const database = databasePath();
    const data = largeTextProjection();
    const info = writeSqliteRelease(data, database);
    const db = new DatabaseSync(database, { readOnly: true });
    try {
      const row = db.prepare('SELECT workflow_id, length(description) AS description_length FROM workflows WHERE workflow_id = ?').get('redis') as { workflow_id: string; description_length: number };
      expect(row).toMatchObject({ workflow_id: 'redis', description_length: data.workflows.find((value) => value.workflowId === 'redis')!.description!.length });
      expect(db.prepare('SELECT release_id, schema_version FROM releases').all()).toEqual([{ release_id: release.releaseId, schema_version: release.schemaVersion }]);
      expect(() => db.prepare('INSERT INTO workflows VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run('write', 'blocked', null, 'source', 'missing', 'link_only', null, null, null, 'unknown', null, 'unknown', null, 'unknown', 'unknown', 0, 0, 'unknown')).toThrow();
    } finally {
      db.close();
    }
    expect(info.logicalSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(verifySqliteRelease(data, database)).toBe(true);
  });

  it('reads named-value relations back in label order, matching the projection — not in hashed-id order', () => {
    // Regression: with only one row per named relation (this file's other
    // fixtures), any read-back order trivially "matches". The real corpus
    // has hundreds of integrations/tags, and `namedRows` (public-projection.ts)
    // sorts them by label, while stableId hashes the label into an
    // effectively random id — so an id-ordered read-back disagrees with the
    // projection's own label-ordered array almost every time at scale.
    const database = databasePath();
    const metadata = {
      ...release,
      counts: { ...release.counts, workflows: 1, redistributable: 0, linkOnly: 1, findings: 0 },
      facetCounts: { rights: { redistributable: 0, linkOnly: 1, excluded: 0 } },
    };
    const data = buildPublicProjection([
      makeEntry({
        id: 'multi', rights: { status: 'link_only', licence: null, licenceUrl: null },
        structure: { integrations: ['zeta-integration', 'alpha-integration'], trigger: 'Webhook' },
        tags: ['zeta-tag', 'alpha-tag'],
      }),
    ], { release: metadata });
    expect(data.integrations.map((row) => row.label)).toEqual(['alpha-integration', 'zeta-integration']);
    expect(data.tags.map((row) => row.label)).toEqual(['alpha-tag', 'zeta-tag']);
    const info = writeSqliteRelease(data, database);
    expect(info.logicalSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(verifySqliteRelease(data, database)).toBe(true);
  });

  it('stores each row own scan evidence in its own columns and reads the nulls back explicitly', () => {
    const current = SCAN_PROVENANCE_CASES.find((scanCase) => scanCase.entry.id === 'current')!;
    const refused = SCAN_PROVENANCE_CASES.find((scanCase) => scanCase.entry.id === 'refused-current')!;
    const unscanned = SCAN_PROVENANCE_CASES.find((scanCase) => scanCase.entry.id === 'never-scanned')!;
    const entries = [current.entry, refused.entry, unscanned.entry];
    const data = buildPublicProjection(entries, {
      release: releaseForEntries(entries),
      admittedIdentity: current.admittedIdentity,
      bodySha256ByWorkflowId: current.bodySha256ByWorkflowId,
      scanReceiptsByWorkflowId: { ...current.scanReceiptsByWorkflowId, ...refused.scanReceiptsByWorkflowId },
    });
    const database = databasePath();
    writeSqliteRelease(data, database);
    const db = new DatabaseSync(database);
    try {
      // The v2 physical layout, pinned: a column cannot be renamed or dropped without this failing.
      expect((db.prepare('PRAGMA table_info(workflows)').all() as { name: string }[]).map((row) => row.name)).toEqual([
        'workflow_id', 'title', 'description', 'description_authority', 'source_id', 'rights_status',
        'body_kind', 'body_path', 'body_sha256', 'grade_status', 'grade', 'score_status', 'score',
        'completeness', 'complexity', 'node_count', 'connection_count', 'readiness_status',
        'scan_scanner_version', 'scan_analysis_status', 'scan_freshness', 'scan_body_sha256',
      ]);
      expect(db.prepare('SELECT scan_scanner_version, scan_analysis_status, scan_freshness, scan_body_sha256 FROM workflows WHERE workflow_id = ?').get('current'))
        .toEqual({ scan_scanner_version: '2.0.0', scan_analysis_status: 'COMPLETE', scan_freshness: 'CURRENT', scan_body_sha256: 'e'.repeat(64) });
      expect(db.prepare('SELECT scan_scanner_version, scan_analysis_status, scan_freshness, scan_body_sha256 FROM workflows WHERE workflow_id = ?').get('never-scanned'))
        .toEqual({ scan_scanner_version: null, scan_analysis_status: null, scan_freshness: 'UNSCANNED', scan_body_sha256: null });
      // An unknown grade is the fact's own `unknown` status with a null value, never a grade text.
      expect(db.prepare('SELECT grade_status, grade FROM workflows WHERE workflow_id = ?').get('never-scanned'))
        .toEqual({ grade_status: 'unknown', grade: null });
    } finally {
      db.close();
    }
    expect(verifySqliteRelease(data, database)).toBe(true);
  });

  it('reads the stored data dictionary back under its logical names and rejects tampering', () => {
    const database = databasePath();
    const data = projection();
    writeSqliteRelease(data, database);
    const db = new DatabaseSync(database);
    try {
      db.prepare("UPDATE data_dictionary SET privacy_rule = 'rewritten' WHERE relation_name = ? AND field_name = ?").run('workflows', 'scanEvidence.scanFreshness');
    } finally {
      db.close();
    }
    expect(() => verifySqliteRelease(data, database)).toThrow(/data dictionary read-back mismatch/i);
  });

  it('builds the join index in one pass instead of scanning joins per workflow', () => {
    const measured = countJoinReads(perfProjection());
    const database = databasePath();
    writeSqliteRelease(measured.projection, database);

    // 120 workflows x 840 join rows is 100,800 reads under the pre-change .filter
    // loop; one pass over the joins plus the insert loops stays far below this.
    expect(measured.reads()).toBeLessThan(10_000);

    const db = new DatabaseSync(database);
    try {
      expect(db.prepare('SELECT count(*) AS count FROM workflow_search').get()).toEqual({ count: 120 });
      expect(db.prepare('SELECT count(*) AS count FROM workflow_tags').get()).toEqual({ count: 360 });
      expect(db.prepare('SELECT count(*) AS count FROM workflow_integrations').get()).toEqual({ count: 360 });
      // FTS5 tokenizes `perf-119` into `perf`/`119`; a phrase query is the
      // consumer-visible lookup for the hyphenated id.
      expect(db.prepare('SELECT workflow_id FROM workflow_search WHERE workflow_search MATCH ?').all('"perf 119"'))
        .toEqual([{ workflow_id: 'perf-119' }]);
    } finally {
      db.close();
    }
  });

  it('pins the exact FTS cells and logical hash captured before the index change', () => {
    const baseline = JSON.parse(fs.readFileSync(new URL('../__fixtures__/sqlite-fts-baseline.json', import.meta.url), 'utf8')) as {
      logicalSha256: string;
      workflowSearch: Array<{ workflow_id: string; tags: string; integrations: string; triggers: string }>;
    };
    const data = perfProjection();
    const database = databasePath();
    const info = writeSqliteRelease(data, database);
    const db = new DatabaseSync(database);
    try {
      // Compare the exact strings, including canonical join order. The logical
      // hash excludes workflow_search, so sorting labels or asserting only
      // membership would miss the bytes this change could alter.
      const rows = db.prepare(`SELECT workflow_id, tags, integrations, triggers FROM workflow_search
        ORDER BY workflow_id`).all();
      expect(rows).toHaveLength(120);
      expect(rows).toEqual(baseline.workflowSearch);
      expect(info.logicalSha256).toBe(baseline.logicalSha256);
    } finally {
      db.close();
    }
  });
});
