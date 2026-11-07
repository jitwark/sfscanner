import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PUBLIC_DATA_MODEL_SCHEMA_VERSION, type PublicReleaseMetadata } from '@hub/contracts/public-data-model';
import { makeEntry } from '../__fixtures__/make-entry.js';
import { buildPublicProjection } from './public-projection.js';
import { writePublicRelease } from './public-release.js';

const roots: string[] = [];
const release: PublicReleaseMetadata = {
  releaseId: 'release-reproducibility-fixture', schemaVersion: PUBLIC_DATA_MODEL_SCHEMA_VERSION,
  generatedAt: '2026-08-31T00:00:00.000Z', toolVersion: 'hub-pipeline@fixture', scannerVersion: 'scanner-fixture',
  policyVersion: 'policy-fixture', searchIndexVersion: 'search-fixture', buildRevision: 'revision-fixture',
  manifestSha256: 'a'.repeat(64), corpusSha256: 'b'.repeat(64),
  counts: { workflows: 2, redistributable: 1, linkOnly: 1, excluded: 0, findings: 1 },
  facetCounts: { rights: { redistributable: 1, linkOnly: 1, excluded: 0 } },
};

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(`${root}.previous`, { recursive: true, force: true });
  }
});

function files(root: string): string[] {
  const result: string[] = [];
  const visit = (directory: string, prefix = '') => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      const relative = path.join(prefix, entry.name);
      if (entry.isDirectory()) visit(path.join(directory, entry.name), relative);
      else result.push(relative.replaceAll('\\', '/'));
    }
  };
  visit(root);
  return result;
}

function fixtureEntries() {
  return [
    makeEntry({ id: 'beta', title: 'Beta', rights: { status: 'link_only', licence: null, licenceUrl: null } }),
    makeEntry({ id: 'alpha', title: 'Alpha', download: { pack: 0, line: 2, offset: 0, length: 10 }, security: { findings: [{ id: 'policy', title: 'Finding', severity: 'HIGH', why: 'Why', fix: 'Fix' }] } }),
  ];
}

describe('public release reproducibility', () => {
  it('writes byte-identical files from equivalent input order', () => {
    const first = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-release-repro-a-'));
    const second = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-release-repro-b-'));
    roots.push(first, second);
    const entries = fixtureEntries();
    const firstProjection = buildPublicProjection(entries, { release, bodySha256ByWorkflowId: { alpha: 'c'.repeat(64) } });
    const secondProjection = buildPublicProjection([...entries].reverse(), { release, bodySha256ByWorkflowId: { alpha: 'c'.repeat(64) } });
    const firstBundle = writePublicRelease(firstProjection, first);
    const secondBundle = writePublicRelease(secondProjection, second);

    expect(secondBundle).toEqual(firstBundle);
    expect(files(second)).toEqual(files(first));
    for (const file of files(first)) expect(fs.readFileSync(path.join(second, file))).toEqual(fs.readFileSync(path.join(first, file)));
  });
});
