import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { bodyFileByEntryId, loadOfficialBodyMap, readOfficialBody } from './official-bodies.js';

const scratch: string[] = [];

/** The one folder the fixture map bound, and therefore the folder a run must declare. */
const SOURCE_DIR = '/bodies';
const DECLARED = [SOURCE_DIR];

function scratchDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'regen-bodies-'));
  scratch.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of scratch.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** A minimal map that satisfies both reconciliation equations. */
function reconciledMap() {
  const source = { sourceDir: SOURCE_DIR, provenance: 'curated_official_folder' };
  return {
    schemaVersion: 'official-body-map-v1',
    rows: [
      { templateId: 1, entryId: 'a', file: 'official__1_one.json', ...source },
      { templateId: 2, entryId: 'b', file: 'official__2_two.json', ...source },
    ],
    withoutBody: [{ templateId: 3, entryId: 'c' }],
    refusedBodies: [],
    orphanBodies: [{ templateId: 4, file: 'official__4_four.json', ...source }],
    counts: {
      catalogueOfficial: 3,
      bodyFiles: 3,
      ignoredBodyFiles: 0,
      matched: 2,
      withoutBody: 1,
      refused: 0,
      shadowedBodyFiles: 0,
      orphanBodyFiles: 1,
      duplicateCatalogueTemplateIds: 0,
      duplicateBodyTemplateIds: 0,
      entriesWithoutTemplateId: 0,
      malformedBodyFileNames: 0,
    },
  };
}

describe('loadOfficialBodyMap', () => {
  it('accepts a map that reconciles and exposes entry ids to bodies', () => {
    const dir = scratchDir();
    const file = path.join(dir, 'map.json');
    fs.writeFileSync(file, JSON.stringify(reconciledMap()), 'utf8');

    const map = loadOfficialBodyMap(file, DECLARED);
    expect(map.counts.matched).toBe(2);
    expect([...bodyFileByEntryId(map)]).toEqual([
      ['a', { file: 'official__1_one.json', sourceDir: SOURCE_DIR }],
      ['b', { file: 'official__2_two.json', sourceDir: SOURCE_DIR }],
    ]);
  });

  it('refuses a run whose declared folders are not the folders the map bound', () => {
    const dir = scratchDir();
    const file = path.join(dir, 'map.json');
    fs.writeFileSync(file, JSON.stringify(reconciledMap()), 'utf8');

    expect(() => loadOfficialBodyMap(file, [path.join(dir, 'other')])).toThrow(/this run declared/);
    expect(() => loadOfficialBodyMap(file, [])).toThrow(/this run declared/);
  });

  it('refuses a map whose join equation does not hold, naming the equation', () => {
    const dir = scratchDir();
    const broken = reconciledMap();
    broken.counts.matched = 1;
    const file = path.join(dir, 'map.json');
    fs.writeFileSync(file, JSON.stringify(broken), 'utf8');

    expect(() => loadOfficialBodyMap(file, DECLARED)).toThrow(/matched 1 \+ withoutBody 1 != catalogue official 3/);
  });

  it('refuses a map with a duplicate templateId rather than picking a winner', () => {
    const dir = scratchDir();
    const broken = reconciledMap();
    broken.counts.duplicateBodyTemplateIds = 1;
    const file = path.join(dir, 'map.json');
    fs.writeFileSync(file, JSON.stringify(broken), 'utf8');

    expect(() => loadOfficialBodyMap(file, DECLARED)).toThrow(/duplicate templateId/);
  });

  it('refuses a missing map and says how to emit one', () => {
    expect(() => loadOfficialBodyMap(path.join(scratchDir(), 'absent.json'), DECLARED)).toThrow(/emit-body-map/);
  });

  it('refuses a file that is not an official-body map', () => {
    const dir = scratchDir();
    const file = path.join(dir, 'map.json');
    fs.writeFileSync(file, JSON.stringify({ rows: [] }), 'utf8');
    expect(() => loadOfficialBodyMap(file, DECLARED)).toThrow(/not an official-body-map artifact/);
  });
});

describe('readOfficialBody', () => {
  it('parses a body file by name', () => {
    const dir = scratchDir();
    fs.writeFileSync(path.join(dir, 'official__1_one.json'), JSON.stringify({ nodes: [], connections: {} }), 'utf8');
    expect(readOfficialBody(dir, 'official__1_one.json')).toEqual({ nodes: [], connections: {} });
  });

  it('names the file, and only the file, when it cannot be read or parsed', () => {
    const dir = scratchDir();
    expect(() => readOfficialBody(dir, 'official__9_missing.json')).toThrow(/official__9_missing\.json/);
    fs.writeFileSync(path.join(dir, 'official__2_broken.json'), '{ not json', 'utf8');
    expect(() => readOfficialBody(dir, 'official__2_broken.json')).toThrow(/not valid JSON: official__2_broken\.json/);
  });
});
