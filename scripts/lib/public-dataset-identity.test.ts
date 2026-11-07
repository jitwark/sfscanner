/**
 * The dataset id has to answer two questions, and this file asks both of them.
 *
 * Distinctness: two byte states of the dataset cannot share an id — the defect
 * `outputs/public-dataset` and `outputs/public-dataset.previous` shipped with,
 * both declaring `release-2026-09-04` over different SQLite and Excel bytes.
 *
 * Reproducibility: unchanged inputs derive the same id, and a bundle's id is
 * re-derivable from the bundle alone rather than only from the corpus and the
 * clock that produced it.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PUBLIC_DATA_MODEL_SCHEMA_VERSION, type PublicReleaseMetadata } from '../../contracts/public-data-model.js';
import { makeEntry } from '../../pipeline/__fixtures__/make-entry.js';
import { buildPublicProjection } from '../../pipeline/export/public-projection.js';
import { writePublicRelease } from '../../pipeline/export/public-release.js';
import { DatasetIdentityError, projectionSections, sealedDatasetId, verifyDatasetReleaseId } from './public-dataset-identity.js';

const PENDING = 'release-pending';
const BODY_HASH = 'c'.repeat(64);
const dirs: string[] = [];

afterEach(() => {
  for (const directory of dirs.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
    fs.rmSync(`${directory}.previous`, { recursive: true, force: true });
  }
});

function metadata(overrides: Partial<PublicReleaseMetadata> = {}): PublicReleaseMetadata {
  return {
    releaseId: PENDING,
    schemaVersion: PUBLIC_DATA_MODEL_SCHEMA_VERSION,
    generatedAt: '2026-09-04T00:00:00.000Z',
    toolVersion: 'hub-pipeline@1.0.0',
    scannerVersion: 'scanner-v1',
    policyVersion: 'policy-v1',
    searchIndexVersion: 'search-v1',
    buildRevision: '1'.repeat(40),
    manifestSha256: 'a'.repeat(64),
    corpusSha256: 'b'.repeat(64),
    counts: { workflows: 2, redistributable: 1, linkOnly: 1, excluded: 0, findings: 1 },
    facetCounts: { rights: { redistributable: 1, linkOnly: 1, excluded: 0 } },
    ...overrides,
  };
}

type SampleOptions = { title?: string; bodySha256?: string };

function sampleProjection(release: PublicReleaseMetadata = metadata(), options: SampleOptions = {}) {
  const entries = [
    makeEntry({
      id: 'alpha',
      title: options.title ?? 'Alpha workflow',
      tags: ['a-tag'],
      structure: { integrations: ['webhook'], trigger: 'Manual' },
      download: { pack: 0, line: 4, offset: 20, length: 80 },
      security: { findings: [{ id: 'policy.secret', title: 'Secret', severity: 'HIGH', why: 'why', fix: 'fix' }] },
    }),
    makeEntry({
      id: 'official',
      source: { kind: 'n8n_official', repo: undefined, path: undefined, commit: undefined },
      rights: { status: 'link_only', licence: null, licenceUrl: null },
    }),
  ];
  return buildPublicProjection(entries, {
    release,
    bodySha256ByWorkflowId: { alpha: options.bodySha256 ?? BODY_HASH },
  });
}

/** The exporter's flow in miniature: build around a pending id, measure the content, seal the id it implies. */
function derivedId(options: SampleOptions = {}, overrides: Partial<PublicReleaseMetadata> = {}): string {
  const pending = metadata(overrides);
  return sealedDatasetId(pending, projectionSections(sampleProjection(pending, options)));
}

/** A real writer bundle, so every row-auth case below is a real file, not a mock. */
function writtenBundle(): { directory: string; releaseId: string } {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-dataset-identity-row-'));
  dirs.push(directory);
  const releaseId = derivedId();
  writePublicRelease(sampleProjection(metadata({ releaseId })), directory);
  return { directory, releaseId };
}

/**
 * Rewrite the shipped `releases` row. That relation is outside the content
 * digest, so the derived id cannot move: each case isolates the row itself.
 */
function rewriteReleaseRow(directory: string, update: (row: Record<string, unknown>) => Record<string, unknown>): void {
  const file = path.join(directory, 'ndjson', 'releases.ndjson');
  const row = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
  fs.writeFileSync(file, `${JSON.stringify(update(row))}\n`);
}

function expectDatasetIdentityError(run: () => unknown, code: 'LEGACY_V1' | 'INVALID_BUNDLE'): DatasetIdentityError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(DatasetIdentityError);
    expect((error as DatasetIdentityError).code).toBe(code);
    return error as DatasetIdentityError;
  }
  throw new Error(`expected ${code}`);
}

describe('dataset release identity', () => {
  it('derives the id from content, not from the id the content was built around', () => {
    const sections = projectionSections(sampleProjection());

    expect(sealedDatasetId(metadata(), sections)).toBe(sealedDatasetId(metadata({ releaseId: 'release-2026-09-04' }), sections));
  });

  it('uses the outer release scheme, so the two ids cannot drift apart', () => {
    expect(derivedId()).toMatch(/^release-2026-09-04-[0-9a-f]{12}$/u);
  });

  it('gives different ids to two different byte states of one corpus generation', () => {
    const current = derivedId();
    const edited = derivedId({ title: 'Alpha workflow (edited upstream)' });
    const rebuilt = derivedId({ bodySha256: 'd'.repeat(64) });

    expect(edited).not.toBe(current);
    expect(rebuilt).not.toBe(current);
    expect(edited).not.toBe(rebuilt);
  });

  it('gives different ids to the same rows under a different declared identity', () => {
    const current = derivedId();

    expect(derivedId({}, { buildRevision: '2'.repeat(40) })).not.toBe(current);
    expect(derivedId({}, { corpusSha256: 'e'.repeat(64) })).not.toBe(current);
    expect(derivedId({}, { scannerVersion: 'scanner-v2' })).not.toBe(current);
  });

  it('re-derives a shipped bundle id from the bundle alone, and refuses one whose bytes moved', () => {
    const current = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-dataset-identity-')); dirs.push(current);
    const previous = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-dataset-identity-')); dirs.push(previous);
    const previousTitle = 'Alpha workflow (previous generation)';
    const currentId = derivedId();
    const previousId = derivedId({ title: previousTitle });

    writePublicRelease(sampleProjection(metadata({ releaseId: currentId })), current);
    writePublicRelease(sampleProjection(metadata({ releaseId: previousId }), { title: previousTitle }), previous);

    expect(currentId).not.toBe(previousId);
    expect(verifyDatasetReleaseId(current)).toMatchObject({ releaseId: currentId, derived: currentId, matches: true });
    expect(verifyDatasetReleaseId(previous)).toMatchObject({ releaseId: previousId, derived: previousId, matches: true });

    fs.appendFileSync(path.join(current, 'ndjson', 'workflows.ndjson'), '\n');

    const tampered = verifyDatasetReleaseId(current);
    expect(tampered.derived).not.toBe(currentId);
    expect(tampered.matches).toBe(false);
  });
});

describe('dataset identity version boundary', () => {
  it('reports a legacy v1 bundle as LEGACY_V1 with re-export guidance', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-dataset-identity-v1-'));
    dirs.push(directory);
    fs.mkdirSync(path.join(directory, 'ndjson'));
    fs.writeFileSync(path.join(directory, 'ndjson', 'releases.ndjson'), `${JSON.stringify({
      releaseId: 'release-2026-09-25-a3bd8e3ccb91',
      schemaVersion: 'public-data-model-v1',
    })}\n`);

    try {
      verifyDatasetReleaseId(directory);
      throw new Error('expected LEGACY_V1');
    } catch (error) {
      expect(error).toBeInstanceOf(DatasetIdentityError);
      expect((error as DatasetIdentityError).code).toBe('LEGACY_V1');
      expect((error as Error).message).toMatch(/re-export/i);
    }
  });

  it('reports a malformed v2 bundle as INVALID_BUNDLE, not as legacy', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-dataset-identity-v2-'));
    dirs.push(directory);
    fs.mkdirSync(path.join(directory, 'ndjson'));
    fs.writeFileSync(path.join(directory, 'ndjson', 'releases.ndjson'), `${JSON.stringify({
      releaseId: 'release-2026-09-25-a3bd8e3ccb91',
      schemaVersion: 'public-data-model-v2',
    })}\n`);

    try {
      verifyDatasetReleaseId(directory);
      throw new Error('expected INVALID_BUNDLE');
    } catch (error) {
      expect(error).toBeInstanceOf(DatasetIdentityError);
      expect((error as DatasetIdentityError).code).toBe('INVALID_BUNDLE');
      expect((error as Error).message).toMatch(/does not ship one valid release metadata row/);
    }
  });
});

describe('dataset identity row authentication', () => {
  it('rejects a releases row without a release id', () => {
    const { directory } = writtenBundle();
    rewriteReleaseRow(directory, (row) => Object.fromEntries(Object.entries(row).filter(([key]) => key !== 'releaseId')));

    const error = expectDatasetIdentityError(() => verifyDatasetReleaseId(directory), 'INVALID_BUNDLE');

    expect(error.message).toMatch(/does not ship one valid release metadata row/);
  });

  it('rejects a releases row id that disagrees with the root manifest id', () => {
    const { directory } = writtenBundle();
    const otherId = `release-2026-09-04-${'f'.repeat(12)}`;
    rewriteReleaseRow(directory, (row) => ({ ...row, releaseId: otherId }));

    const error = expectDatasetIdentityError(() => verifyDatasetReleaseId(directory), 'INVALID_BUNDLE');

    expect(error.message).toContain(otherId);
    expect(error.message).toMatch(/public-release\.json/);
  });

  it('rejects null counts as INVALID_BUNDLE, not a TypeError', () => {
    const { directory } = writtenBundle();
    rewriteReleaseRow(directory, (row) => ({ ...row, counts: null }));

    expectDatasetIdentityError(() => verifyDatasetReleaseId(directory), 'INVALID_BUNDLE');
  });

  it('rejects null rights facet counts as INVALID_BUNDLE, not a TypeError', () => {
    const { directory } = writtenBundle();
    rewriteReleaseRow(directory, (row) => ({ ...row, facetCounts: { rights: null } }));

    expectDatasetIdentityError(() => verifyDatasetReleaseId(directory), 'INVALID_BUNDLE');
  });

  it('rejects a missing or blank root manifest release id as INVALID_BUNDLE', () => {
    for (const update of [
      (manifest: Record<string, unknown>) => Object.fromEntries(Object.entries(manifest).filter(([key]) => key !== 'releaseId')),
      (manifest: Record<string, unknown>) => ({ ...manifest, releaseId: '' }),
    ]) {
      const { directory } = writtenBundle();
      const manifestPath = path.join(directory, 'public-release.json');
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
      fs.writeFileSync(manifestPath, JSON.stringify(update(manifest)));

      const error = expectDatasetIdentityError(() => verifyDatasetReleaseId(directory), 'INVALID_BUNDLE');

      expect(error.message).toMatch(/declares no release id/);
    }
  });
});
