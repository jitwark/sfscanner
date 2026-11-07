import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Entry } from '@hub/contracts';
import { makeChart, makeEntry } from '../__fixtures__/make-entry.js';
import { buildOfficialBodyMap, serializeOfficialBodyMap } from '../official-map/body-map.js';
import { unscannedReadiness } from './regenerate-entry.js';
import { runRegeneration } from './run-regeneration.js';

const ROOT = path.join(process.cwd(), 'pipeline', '.work', 'hub-corpus-residual-test');
const GENERATED_AT = '2026-09-25T00:00:00.000Z';
/** The pre-regeneration build stamp the committed corpus carries on body-less verdicts. */
const LEGACY_STAMP = 'c998701';

/** Valid JSON, but `connections` is an array, so `parseWorkflowJson` returns MALFORMED_WORKFLOW. */
const MALFORMED_BODY = '{"nodes":[{"name":"Start","type":"n8n-nodes-base.manualTrigger"}],"connections":[]}';
const VALID_BODY = JSON.stringify({
  name: 'Fixture',
  nodes: [{ id: '1', name: 'Start', type: 'n8n-nodes-base.manualTrigger' }],
  connections: {},
});
/** One redistributable sanitized body, packed as the packager writes it: JSON + one LF. */
const PACK_RECORD = JSON.stringify({
  id: 'pack-body-1',
  name: 'Redistributable fixture',
  nodes: [{ id: '1', name: 'Start', type: 'n8n-nodes-base.manualTrigger' }],
  connections: {},
});

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

/** One rights-evidence journal row, as `rightsStage` writes it for a granted claim. */
function rightsEvidenceRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'redistributable-fixture',
    status: 'redistributable',
    disposition: 'publish',
    reason: 'repository licence: MIT',
    evidence: {
      sourceCommit: 'a'.repeat(40),
      bodyHash: 'b'.repeat(64),
      workflowPath: 'workflows/fixture.json',
      rootLicence: [{ filename: 'LICENSE', sha256: 'c'.repeat(64) }],
      nestedLicence: [],
      siblingLicence: [],
      licenceBasis: 'same-commit-file',
      expectedLicence: 'MIT',
      expectedLicenceMatch: 'match',
    },
    ...overrides,
  };
}

/**
 * A three-entry corpus that exercises both ledger paths: two official entries
 * with a retained body (one of which the parser refuses) and one
 * redistributable entry whose body is a committed pack record.
 *
 * `evidence` names the rights-evidence journal the run reads: the one row the
 * granted claim needs, the same row with a metadata-only basis, or no file at
 * all.
 */
function writeFixtureCorpus(
  evidence: 'sufficient' | 'metadata-only' | 'absent' = 'sufficient',
): { dataDir: string; bodiesDir: string; bodiesDirAlt: string; mapPath: string } {
  fs.rmSync(ROOT, { recursive: true, force: true });
  const dataDir = path.join(ROOT, 'data');
  const bodiesDir = path.join(ROOT, 'bodies');
  const bodiesDirAlt = path.join(ROOT, 'bodies-2');

  const officialUnparseable = makeEntry({
    id: 'unparseable-fixture',
    slug: 'unparseable-fixture',
    title: 'Unparseable fixture',
    source: { kind: 'n8n_official', templateId: 9001, permalink: 'https://n8n.io/workflows/9001' },
    rights: { status: 'link_only' },
    dedup: { canonical: false },
  });
  const officialParseable = makeEntry({
    id: 'parseable-fixture',
    slug: 'parseable-fixture',
    title: 'Parseable fixture',
    source: { kind: 'n8n_official', templateId: 9002, permalink: 'https://n8n.io/workflows/9002' },
    rights: { status: 'link_only' },
    dedup: { canonical: false },
  });
  const redistributable = makeEntry({
    id: 'redistributable-fixture',
    slug: 'redistributable-fixture',
    title: 'Redistributable fixture',
    source: { kind: 'github' },
    rights: { status: 'redistributable' },
    security: { scannerVersion: LEGACY_STAMP },
    dedup: { canonical: false },
  }) as Entry;
  // Every committed entry carries a readiness report; the redistributable slice
  // keeps it through vocabulary normalisation.
  redistributable.readiness = { ...unscannedReadiness(), analysis: 'derived' };
  redistributable.download = {
    pack: 0,
    line: 0,
    offset: 0,
    length: Buffer.byteLength(`${PACK_RECORD}\n`, 'utf8'),
    sha256: crypto.createHash('sha256').update(PACK_RECORD, 'utf8').digest('hex'),
  };

  const entries = [officialUnparseable, officialParseable, redistributable];
  writeJson(path.join(dataDir, 'catalogue-0.json'), entries);
  fs.mkdirSync(path.join(dataDir, 'charts'), { recursive: true });
  fs.writeFileSync(
    path.join(dataDir, 'charts', 'chart-0.jsonl'),
    `${entries.map(() => JSON.stringify(makeChart())).join('\n')}\n`,
    'utf8',
  );
  fs.mkdirSync(path.join(dataDir, 'packs'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'packs', 'pack-0.jsonl'), `${PACK_RECORD}\n`, 'utf8');
  for (const sidecar of ['advisories-v2.json', 'advisory-quarantine-v1.json', 'calibration-v2-manifest.json']) {
    writeJson(path.join(dataDir, 'scanner', sidecar), {});
  }

  if (evidence !== 'absent') {
    const row =
      evidence === 'sufficient'
        ? rightsEvidenceRow()
        : rightsEvidenceRow({ evidence: { licenceBasis: 'metadata-only', rootLicence: [] } });
    fs.writeFileSync(path.join(dataDir, 'rights-evidence.jsonl'), `${JSON.stringify(row)}\n`, 'utf8');
  }

  // Two source folders on purpose: the run resolves each body in the folder the
  // map recorded for that row, not in one folder for the whole run.
  fs.mkdirSync(bodiesDir, { recursive: true });
  fs.mkdirSync(bodiesDirAlt, { recursive: true });
  fs.writeFileSync(path.join(bodiesDir, 'official__9001_unparseable-fixture.json'), MALFORMED_BODY, 'utf8');
  fs.writeFileSync(path.join(bodiesDirAlt, 'official__9002_parseable-fixture.json'), VALID_BODY, 'utf8');

  const mapPath = path.join(ROOT, 'official-body-map.json');
  fs.writeFileSync(
    mapPath,
    serializeOfficialBodyMap(
      buildOfficialBodyMap([entries], [
        { dir: bodiesDir, provenance: 'regeneration-fixture' },
        { dir: bodiesDirAlt, provenance: 'regeneration-fixture-2' },
      ]),
    ),
    'utf8',
  );
  return { dataDir, bodiesDir, bodiesDirAlt, mapPath };
}

afterEach(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
});

describe('runRegeneration ledgers', () => {
  it('ledgers an unparseable fixture individually instead of burying it in a total', async () => {
    const { dataDir, bodiesDir, bodiesDirAlt, mapPath } = writeFixtureCorpus();

    const report = await runRegeneration({
      dataDir,
      outputDir: path.join(ROOT, 'out', 'data'),
      bodySources: [bodiesDir, bodiesDirAlt],
      mapPath,
      generatedAt: GENERATED_AT,
      legacyScannerStamps: [LEGACY_STAMP],
    });

    expect(report.counts.reDerived).toBe(2);
    expect(report.unparseable).toEqual([
      {
        entryId: 'unparseable-fixture',
        templateId: 9001,
        slug: 'unparseable-fixture',
        reason: 'MALFORMED_WORKFLOW',
        analysisStatus: 'INDETERMINATE',
        grade: 'UNKNOWN',
        findings: 0,
        scannerVersion: 'scanner-beta-1',
        profile: 'beta-default',
      },
    ]);
  });

  it('records no unparseable fixture when every retained body parses', async () => {
    const { dataDir, bodiesDir, bodiesDirAlt, mapPath } = writeFixtureCorpus();
    fs.writeFileSync(path.join(bodiesDir, 'official__9001_unparseable-fixture.json'), VALID_BODY, 'utf8');

    const report = await runRegeneration({
      dataDir,
      outputDir: path.join(ROOT, 'out', 'data'),
      bodySources: [bodiesDir, bodiesDirAlt],
      mapPath,
      generatedAt: GENERATED_AT,
      legacyScannerStamps: [LEGACY_STAMP],
    });

    expect(report.unparseable).toEqual([]);
  });

  it('reconciles the redistributable body inventory to the entries that carry a body', async () => {
    const { dataDir, bodiesDir, bodiesDirAlt, mapPath } = writeFixtureCorpus();

    const report = await runRegeneration({
      dataDir,
      outputDir: path.join(ROOT, 'out', 'data'),
      bodySources: [bodiesDir, bodiesDirAlt],
      mapPath,
      generatedAt: GENERATED_AT,
      legacyScannerStamps: [LEGACY_STAMP],
    });

    expect(report.counts.redistributableLabelsOnly).toBe(1);
    expect(report.redistributableBodies.count).toBe(1);
    expect(report.redistributableBodies.rows).toEqual([
      {
        path: 'packs/pack-0.jsonl',
        line: 0,
        bytes: Buffer.byteLength(PACK_RECORD, 'utf8'),
        sha256: crypto.createHash('sha256').update(PACK_RECORD, 'utf8').digest('hex'),
      },
    ]);
  });

  // The two fixture bodies live in two folders, so `reDerived` being 2 is the
  // observable proof that each row is read from the folder the map recorded for
  // it rather than from one folder for the whole run.
  it('reads each retained body from the source folder its map row records', async () => {
    const { dataDir, bodiesDir, bodiesDirAlt, mapPath } = writeFixtureCorpus();

    const report = await runRegeneration({
      dataDir,
      outputDir: path.join(ROOT, 'out', 'data'),
      bodySources: [bodiesDir, bodiesDirAlt],
      mapPath,
      generatedAt: GENERATED_AT,
      legacyScannerStamps: [LEGACY_STAMP],
    });

    expect(report.counts.reDerived).toBe(2);
    expect(report.counts.officialWithoutBody).toBe(0);
  });

  it('refuses a run whose declared folders are not the folders the map bound', async () => {
    const { dataDir, bodiesDir, mapPath } = writeFixtureCorpus();

    await expect(
      runRegeneration({
        dataDir,
        outputDir: path.join(ROOT, 'out', 'data'),
        bodySources: [bodiesDir],
        mapPath,
        generatedAt: GENERATED_AT,
        legacyScannerStamps: [LEGACY_STAMP],
      }),
    ).rejects.toThrow(/this run declared/);
  });
});

describe('runRegeneration redistribution claims', () => {
  const options = (dataDir: string, bodiesDir: string, bodiesDirAlt: string, mapPath: string) => ({
    dataDir,
    outputDir: path.join(ROOT, 'out', 'data'),
    bodySources: [bodiesDir, bodiesDirAlt],
    mapPath,
    generatedAt: GENERATED_AT,
    legacyScannerStamps: [LEGACY_STAMP],
  });

  it('refuses to republish a redistribution claim with no recorded evidence', async () => {
    const { dataDir, bodiesDir, bodiesDirAlt, mapPath } = writeFixtureCorpus('absent');

    await expect(runRegeneration(options(dataDir, bodiesDir, bodiesDirAlt, mapPath))).rejects.toThrow(
      /No rights-evidence journal was supplied to this run/,
    );
    // Fail closed means nothing was written, not a corpus with the claim dropped.
    expect(fs.existsSync(path.join(ROOT, 'out'))).toBe(false);
  });

  it('refuses a claim whose journal row records a metadata-only basis', async () => {
    const { dataDir, bodiesDir, bodiesDirAlt, mapPath } = writeFixtureCorpus('metadata-only');

    await expect(runRegeneration(options(dataDir, bodiesDir, bodiesDirAlt, mapPath))).rejects.toThrow(
      /licenceBasis "metadata-only", not "same-commit-file"/,
    );
    expect(fs.existsSync(path.join(ROOT, 'out'))).toBe(false);
  });

  it('refuses a named journal that is not there, rather than reading an empty one', async () => {
    const { dataDir, bodiesDir, bodiesDirAlt, mapPath } = writeFixtureCorpus();

    await expect(
      runRegeneration({ ...options(dataDir, bodiesDir, bodiesDirAlt, mapPath), rightsEvidencePath: path.join(ROOT, 'missing.jsonl') }),
    ).rejects.toThrow(/Rights-evidence journal not found/);
  });

  it('republishes a claim the recorded evidence supports and reports the count', async () => {
    const { dataDir, bodiesDir, bodiesDirAlt, mapPath } = writeFixtureCorpus();

    const report = await runRegeneration(options(dataDir, bodiesDir, bodiesDirAlt, mapPath));

    expect(report.redistributionEvidence).toEqual({
      ledger: path.join(dataDir, 'rights-evidence.jsonl'),
      claims: 1,
      evidenced: 1,
    });
    expect(report.published).toBe(3);
  });
});
