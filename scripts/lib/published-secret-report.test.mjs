import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { STRICT_RULES } from './published-secret-candidates.mjs';
import { artifactSet, ARTIFACT_ROOTS, relative, renderFindings, renderSummary, reportMatches } from './published-secret-report.mjs';

const VALUE = 'qqbbjjvvww0123456789';
const OTHER = 'xxzzqqbbjjvv0123456789';

const temporaryDirectories = [];

function temporaryDirectory() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'published-secret-report-test-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  while (temporaryDirectories.length > 0) fs.rmSync(temporaryDirectories.pop(), { recursive: true, force: true });
});

describe('published secret artifact set', () => {
  it('names every published surface it is meant to read', () => {
    expect([...ARTIFACT_ROOTS]).toEqual(['data', 'app/public/data', 'app/out', 'outputs']);
  });

  it('measures the roots it has and names the ones it does not', () => {
    const directory = temporaryDirectory();
    fs.writeFileSync(path.join(directory, 'catalogue-0.json'), JSON.stringify({ a: 1 }));
    const missing = path.join(directory, 'absent');
    const set = artifactSet({ root: directory, override: `${directory};${missing}` });
    expect(set.files).toEqual([path.join(directory, 'catalogue-0.json')]);
    expect(set.present).toEqual([directory]);
    expect(set.missing).toEqual([relative(directory, missing)]);
    expect(set.bytes).toBe(Buffer.byteLength(JSON.stringify({ a: 1 })));
  });

  it('reports a path inside the workspace relatively and one outside it absolutely', () => {
    const root = path.join('C:', 'workspace');
    expect(relative(root, path.join(root, 'data', 'manifest.json'))).toBe('data/manifest.json');
    expect(relative(root, path.join('C:', 'elsewhere', 'x.json'))).toBe('C:/elsewhere/x.json');
  });
});

describe('published secret report rendering', () => {
  const summary = {
    bodiesDir: 'corpus',
    bodiesScanned: 10,
    candidates: {
      strict: { distinctValues: 3, valuesByRule: { [STRICT_RULES.BASIC_HEADER]: 3 }, fieldPaths: ['workflow.nodes[].parameters.headerParameters.parameters[].value'], sourceBodies: 3 },
      loose: { distinctValues: 4, valuesByRule: { 'loose:authorization-shaped-pair': 4 }, fieldPaths: ['workflow.nodes[].parameters.headerAuth.value'], sourceBodies: 4 },
      belowSweepFloor: { total: 2, strict: 0, loose: 2 },
      sweepFloor: 8,
      distinctNeedles: 7,
      needlesSwept: 5,
    },
    artifactsSwept: { roots: ['data'], missingRoots: ['app/out'], files: 12, bytes: 4096 },
    positiveControl: { detectedValues: 5, plantedValues: 5, strictClasses: [STRICT_RULES.BASIC_HEADER], looseClasses: ['loose:authorization-shaped-pair'], lineArtifactDetected: true },
    matches: { strict: 1, looseOnly: 1 },
    findings: {
      strict: [{ artifact: 'data/catalogue-0.json', fieldPath: '$.entries[0].header', ruleClass: STRICT_RULES.BASIC_HEADER, needleLength: VALUE.length }],
      looseOnly: [{ artifact: 'data/packs/pack-0.jsonl', fieldPath: 'line[3].value', ruleClass: 'loose:authorization-shaped-pair', needleLength: VALUE.length, needleIsExpression: true, sourceBodyCount: 1 }],
    },
  };

  it('renders the counts, the paths, the floor and the absent roots', () => {
    const text = renderSummary(summary);
    expect(text).toContain('strict candidates: 3 distinct values across 3 bodies');
    expect(text).toContain('needles swept: 5 of 7 (below the 8-character floor: 2)');
    expect(text).toContain('Artifacts: 12 files / 4096 bytes');
    expect(text).toContain('absent (not swept) app/out');
    expect(text).toContain('Positive control: 5/5 planted values detected');
  });

  it('renders findings as artifact, field path and rule class, never a value', () => {
    const text = renderFindings(summary.findings);
    expect(text).toContain(`LEAK data/catalogue-0.json $.entries[0].header ${STRICT_RULES.BASIC_HEADER}`);
    expect(text).toContain('Widened sweep (reported, not asserted): 1 match(es)');
    expect(text).toContain('len=20 expression=true bodies=1');
    expect(text).not.toContain(VALUE);
    expect(renderSummary(summary)).not.toContain(VALUE);
  });

  it('renders nothing when there is nothing to report', () => {
    expect(renderFindings({ strict: [], looseOnly: [] })).toBe('');
  });
});

describe('published secret findings', () => {
  function caseFiles() {
    const directory = temporaryDirectory();
    const strictFile = path.join(directory, 'catalogue-0.json');
    fs.writeFileSync(strictFile, JSON.stringify({ entries: [{ header: VALUE }] }));
    const looseFile = path.join(directory, 'analytics.json');
    fs.writeFileSync(looseFile, JSON.stringify({ note: OTHER }));
    return { directory, strictFile, looseFile };
  }

  const needles = [
    { id: 0, value: VALUE, strictRules: [STRICT_RULES.BASIC_HEADER], fieldPaths: ['workflow.nodes[].parameters.headerParameters.parameters[].value'], sources: ['official__1_a.json'] },
    { id: 1, value: OTHER, strictRules: [], fieldPaths: ['workflow.nodes[].parameters.headerAuth.value'], sources: ['official__2_b.json', 'official__3_c.json'] },
  ];

  it('partitions matches into the assertion and the widened sweep', async () => {
    const { directory, strictFile, looseFile } = caseFiles();
    const { resolveMatches } = await import('./published-secret-sweep.mjs');
    const result = reportMatches({
      matches: [{ file: strictFile, needleIds: [0] }, { file: looseFile, needleIds: [1] }],
      needles,
      root: directory,
      resolve: resolveMatches,
    });
    expect(result.strict).toHaveLength(1);
    expect(result.looseOnly).toHaveLength(1);
    expect(result.strict[0]).toMatchObject({
      artifact: 'catalogue-0.json',
      fieldPath: '$.entries[0].header',
      ruleClass: STRICT_RULES.BASIC_HEADER,
      strict: true,
      needleIsExpression: false,
      sourceBodies: ['official__1_a.json'],
      sourceBodyCount: 1,
    });
    expect(result.looseOnly[0]).toMatchObject({
      artifact: 'analytics.json',
      ruleClasses: ['loose:authorization-shaped-pair'],
      strict: false,
      sourceBodyCount: 2,
    });
  });

  it('carries no value into a finding', async () => {
    const { directory, strictFile, looseFile } = caseFiles();
    const { resolveMatches } = await import('./published-secret-sweep.mjs');
    const result = reportMatches({
      matches: [{ file: strictFile, needleIds: [0] }, { file: looseFile, needleIds: [1] }],
      needles,
      root: directory,
      resolve: resolveMatches,
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(VALUE);
    expect(serialized).not.toContain(OTHER);
    expect(serialized).toContain('needleLength');
  });

  it('sorts findings deterministically', async () => {
    const directory = temporaryDirectory();
    const a = path.join(directory, 'b.json');
    const b = path.join(directory, 'a.json');
    for (const file of [a, b]) fs.writeFileSync(file, JSON.stringify({ x: VALUE }));
    const { resolveMatches } = await import('./published-secret-sweep.mjs');
    const run = () => reportMatches({
      matches: [{ file: a, needleIds: [0] }, { file: b, needleIds: [0] }],
      needles,
      root: directory,
      resolve: resolveMatches,
    });
    expect(run().strict.map((finding) => finding.artifact)).toEqual(['a.json', 'b.json']);
    expect(run()).toEqual(run());
  });
});
