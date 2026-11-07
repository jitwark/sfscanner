import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildOfficialBodyMap,
  type BodySource,
  officialBodyMapReconciles,
  parseOfficialBodyFileName,
  serializeOfficialBodyMap,
} from './body-map';

const scratch: string[] = [];

/** A body with the shape a curated export has and no injected annotation. */
function body(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: 1, name: 'Fixture', nodes: [], connections: {}, settings: {}, ...overrides };
}

/** A real directory holding the named bodies. A string value is written verbatim, so a test can plant invalid JSON. */
function makeSource(provenance: string, files: Record<string, unknown>): BodySource {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'official-body-map-'));
  scratch.push(dir);
  for (const [name, value] of Object.entries(files)) {
    writeFileSync(path.join(dir, name), typeof value === 'string' ? value : JSON.stringify(value), 'utf8');
  }
  return { dir, provenance };
}

function entry(id: string, kind: string, templateId?: number) {
  return { id, rights: { status: 'link_only' }, source: { kind, ...(templateId === undefined ? {} : { templateId }) } };
}

const shards = [
  [entry('a', 'n8n_official', 10), entry('b', 'n8n_official', 20), entry('c', 'n8n_official', 30), entry('g', 'github')],
  [entry('d', 'n8n_official', 40)],
];

afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('official body map', () => {
  it('reconciles every catalogue entry and every body file across the declared sources', () => {
    const source = makeSource('curated_official', {
      'official__10_slug.json': body({ id: 10 }),
      'official__30_another_slug.json': body({ id: 30 }),
      'official__99_orphan.json': body({ id: 99 }),
      'notes.json': body(),
    });
    const map = buildOfficialBodyMap(shards, [source]);

    expect(map.counts).toMatchObject({
      catalogueOfficial: 4,
      bodyFiles: 3,
      ignoredBodyFiles: 1,
      matched: 2,
      withoutBody: 2,
      refused: 0,
      shadowedBodyFiles: 0,
      orphanBodyFiles: 1,
    });
    expect(map.rows).toEqual([
      { templateId: 10, entryId: 'a', file: 'official__10_slug.json', sourceDir: source.dir, provenance: 'curated_official' },
      {
        templateId: 30,
        entryId: 'c',
        file: 'official__30_another_slug.json',
        sourceDir: source.dir,
        provenance: 'curated_official',
      },
    ]);
    expect(map.withoutBody).toEqual([
      { templateId: 20, entryId: 'b' },
      { templateId: 40, entryId: 'd' },
    ]);
    // The github entry is not an official entry and is not counted on either side.
    expect(map.counts.catalogueOfficial).toBe(4);
    expect(officialBodyMapReconciles(map)).toEqual([]);
  });

  it('resolves a template from the first source that holds it and records that source', () => {
    const curated = makeSource('curated_official', {
      'official__10_a.json': body({ id: 10 }),
      'official__30_first.json': body({ id: 30 }),
    });
    const master = makeSource('annotated_master', {
      'official__20_b.json': body({ id: 20 }),
      'official__30_second.json': body({ id: 30 }),
      'official__99_orphan.json': body({ id: 99 }),
    });
    const map = buildOfficialBodyMap(shards, [curated, master]);

    expect(map.rows).toEqual([
      { templateId: 10, entryId: 'a', file: 'official__10_a.json', sourceDir: curated.dir, provenance: 'curated_official' },
      { templateId: 20, entryId: 'b', file: 'official__20_b.json', sourceDir: master.dir, provenance: 'annotated_master' },
      {
        templateId: 30,
        entryId: 'c',
        file: 'official__30_first.json',
        sourceDir: curated.dir,
        provenance: 'curated_official',
      },
    ]);
    // The later source's copy of 30 is never consulted.
    expect(map.counts.shadowedBodyFiles).toBe(1);
    expect(map.orphanBodies).toEqual([
      { templateId: 99, file: 'official__99_orphan.json', sourceDir: master.dir, provenance: 'annotated_master' },
    ]);
    expect(officialBodyMapReconciles(map)).toEqual([]);
  });

  it('gives precedence to the declared order, not to a source tag, a file name, or a directory listing', () => {
    const curated = makeSource('curated_official', { 'official__10_zulu.json': body({ id: 10 }) });
    const master = makeSource('annotated_master', { 'official__10_alpha.json': body({ id: 10 }) });

    const curatedFirst = buildOfficialBodyMap(shards, [curated, master]);
    expect(curatedFirst.rows[0]).toEqual({
      templateId: 10,
      entryId: 'a',
      file: 'official__10_zulu.json',
      sourceDir: curated.dir,
      provenance: 'curated_official',
    });

    const masterFirst = buildOfficialBodyMap(shards, [master, curated]);
    expect(masterFirst.rows[0]).toEqual({
      templateId: 10,
      entryId: 'a',
      file: 'official__10_alpha.json',
      sourceDir: master.dir,
      provenance: 'annotated_master',
    });
  });

  it('refuses a source that declares no provenance instead of inferring one', () => {
    const source = makeSource('curated_official', { 'official__10_a.json': body({ id: 10 }) });
    for (const bad of [{ dir: source.dir }, { dir: source.dir, provenance: '  ' }, { dir: source.dir, provenance: '' }]) {
      expect(() => buildOfficialBodyMap(shards, [bad as BodySource])).toThrow(/provenance/i);
    }
  });

  it('refuses an annotated body, names its keys, and leaves the entry without a usable body', () => {
    const annotated = makeSource('annotated_master', {
      'official__10_master.json': body({ id: 10, _security: { verdict: 'safe' }, _documentation: 'model prose' }),
    });
    const authentic = makeSource('curated_official', { 'official__10_curated.json': body({ id: 10 }) });

    // The annotated source holds 10 first, so the refusal is final: a later
    // authentic copy does not quietly rescue an entry whose declared body is
    // annotated, and the entry stays unscanned.
    const map = buildOfficialBodyMap(shards, [annotated, authentic]);
    expect(map.rows).toEqual([]);
    expect(map.refusedBodies).toEqual([
      {
        templateId: 10,
        file: 'official__10_master.json',
        sourceDir: annotated.dir,
        provenance: 'annotated_master',
        offendingKeys: ['_documentation', '_security'],
      },
    ]);
    expect(map.withoutBody).toContainEqual({ templateId: 10, entryId: 'a' });
    expect(map.counts.shadowedBodyFiles).toBe(1);
    expect(officialBodyMapReconciles(map)).toEqual([]);
  });

  it('refuses a body that cannot be read as a workflow, so a broken file is a finding and not a silent absence', () => {
    const source = makeSource('curated_official', {
      'official__10_broken.json': '{ not json',
      'official__20_array.json': '[1,2,3]',
    });
    const map = buildOfficialBodyMap(shards, [source]);

    expect(map.counts.refused).toBe(2);
    expect(map.refusedBodies.map((refused) => refused.offendingKeys)).toEqual([
      ['<not-a-workflow-body>'],
      ['<not-a-workflow-body>'],
    ]);
    expect(officialBodyMapReconciles(map)).toEqual([]);
  });

  it('reports a foreign file and a provenance sidecar as ignored but refuses an official-prefixed .json that does not fit the convention', () => {
    const clean = makeSource('curated_official', {
      'official__10_a.json': body({ id: 10 }),
      'notes.json': body(),
      'official-body-provenance.jsonl': '{}\n',
    });
    const cleanMap = buildOfficialBodyMap(shards, [clean]);
    expect(cleanMap.counts.ignoredBodyFiles).toBe(2);
    expect(cleanMap.counts.malformedBodyFileNames).toBe(0);
    expect(officialBodyMapReconciles(cleanMap)).toEqual([]);

    const odd = makeSource('curated_official', { 'official__10_a.json': body({ id: 10 }), 'official__abc_x.json': body() });
    expect(buildOfficialBodyMap(shards, [odd]).counts.malformedBodyFileNames).toBe(1);
    expect(officialBodyMapReconciles(buildOfficialBodyMap(shards, [odd]))).toEqual([
      '1 file(s) start with "official" but do not match the official__<templateId>_<slug>.json convention',
    ]);
  });

  it('refuses a map that cannot be reconciled, and says which equation broke', () => {
    const duplicated = makeSource('curated_official', {
      'official__10_slug.json': body({ id: 10 }),
      'official__10_other.json': body({ id: 10 }),
      'official__30_s.json': body({ id: 30 }),
    });
    const map = buildOfficialBodyMap(shards, [duplicated]);
    expect(map.counts.duplicateBodyTemplateIds).toBe(1);
    expect(officialBodyMapReconciles(map)).toEqual(['1 duplicate templateId(s) on the body side']);

    // A collapsed key is also a counting failure: two entries share one id, so
    // the map can only account for one of them. Both are reported.
    const brokenShards = [[...shards[0], entry('dup', 'n8n_official', 10)], shards[1]];
    const duplicatedEntry = buildOfficialBodyMap(
      brokenShards,
      [makeSource('curated_official', { 'official__10_s.json': body({ id: 10 }), 'official__20_s.json': body({ id: 20 }) })],
    );
    expect(duplicatedEntry.counts.duplicateCatalogueTemplateIds).toBe(1);
    expect(officialBodyMapReconciles(duplicatedEntry)).toEqual([
      'matched 2 + withoutBody 2 != catalogue official 5',
      '1 duplicate templateId(s) on the catalogue side',
    ]);
  });

  it('treats an official entry without an integer templateId as a failure, not as an orphan', () => {
    const source = makeSource('curated_official', { 'official__10_s.json': body({ id: 10 }) });
    const broken = buildOfficialBodyMap([[entry('x', 'n8n_official'), entry('y', 'n8n_official', 10)], []], [source]);
    expect(broken.counts.entriesWithoutTemplateId).toBe(1);
    // The keyless entry cannot be placed on either side of the join, so the
    // count equation reports it as well as the explicit reason.
    expect(officialBodyMapReconciles(broken)).toEqual([
      'matched 1 + withoutBody 0 != catalogue official 2',
      '1 official entr(y|ies) carry no integer source.templateId',
    ]);
  });

  it('parses the slug whole, so an underscore in the slug does not truncate or shift the id', () => {
    expect(parseOfficialBodyFileName('official__10000_Auto-Create_TikTok_Videos_VEED.io.json')).toEqual({
      templateId: 10000,
      slug: 'Auto-Create_TikTok_Videos_VEED.io',
    });
    for (const near of ['official__10.json', 'official__abc_x.json', 'Official__10_x.json', 'official__10_x.yaml']) {
      expect(parseOfficialBodyFileName(near)).toBeNull();
    }
  });

  it('orders rows numerically and serializes byte-identically for repeated runs', () => {
    const source = makeSource('curated_official', {
      'official__999_nine.json': body({ id: 999 }),
      'official__10000_ten_thousand.json': body({ id: 10000 }),
    });
    const wide = [[entry('nine', 'n8n_official', 999), entry('ten-thousand', 'n8n_official', 10000)]];
    const first = serializeOfficialBodyMap(buildOfficialBodyMap(wide, [source]));
    const second = serializeOfficialBodyMap(buildOfficialBodyMap(wide, [source]));
    expect(second).toBe(first);
    expect(JSON.parse(first).rows.map((row: { templateId: number }) => row.templateId)).toEqual([999, 10000]);
    expect(first.endsWith('\n')).toBe(true);
  });
});
