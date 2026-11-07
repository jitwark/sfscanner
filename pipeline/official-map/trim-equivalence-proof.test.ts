import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  assessTrimProof,
  encodeCorpusBodyFile,
  measureTrimEquivalence,
  serializeTrimEquivalenceProof,
  TRIM_EQUIVALENCE_SCHEMA,
  trimEquivalenceReconciles,
  type TrimEquivalenceProof,
} from './trim-equivalence-proof';

const scratch: string[] = [];

function scratchDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'trim-proof-'));
  scratch.push(dir);
  return dir;
}

/**
 * Both sides are written with the corpus's own encoder rather than as literals:
 * the raw-byte comparison is only meaningful if the fixture is formatted the way
 * the folders are, and the encoder is what the proof uses to re-emit a trimmed body.
 */
function bodyDir(files: Array<{ name: string; body: unknown; trailingNewline: boolean }>): string {
  const dir = scratchDir();
  for (const file of files) {
    writeFileSync(path.join(dir, file.name), encodeCorpusBodyFile(file.body, file.trailingNewline));
  }
  return dir;
}

afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A curated body: the shape curation left on disk, and what a trimmed master must reproduce. */
const twin = {
  id: 7,
  name: 'twin',
  nodes: [{ name: 'Read Sheet', type: 'n8n-nodes-base.googleSheets', parameters: { sheetId: 'real-id' } }],
  connections: {},
  settings: {},
};

function annotated(body: unknown): Record<string, unknown> {
  return { ...(body as Record<string, unknown>), _security: { verdict: 'safe' }, _documentation: { title: 'prose' } };
}

/** 7 is content-identical once trimmed, 8 is redacted in the master, 9 and 10 have no twin. */
const curatedDir = (): string =>
  bodyDir([
    { name: 'official__7_twin.json', body: twin, trailingNewline: true },
    { name: 'official__8_redacted.json', body: { ...twin, id: 8 }, trailingNewline: true },
    { name: 'official__10_curated_only.json', body: { ...twin, id: 10 }, trailingNewline: true },
    { name: 'github_someone__1_not_a_body.json', body: { twitter: 'nothing to do with this join' }, trailingNewline: true },
  ]);

function masterFiles(overrides: Record<number, unknown> = {}): Array<{ name: string; body: unknown; trailingNewline: boolean }> {
  return [
    { name: 'official__7_twin.json', body: overrides[7] ?? annotated(twin), trailingNewline: false },
    {
      name: 'official__8_redacted.json',
      body:
        overrides[8] ??
        annotated({
          ...twin,
          id: 8,
          nodes: [{ ...twin.nodes[0], parameters: { sheetId: '{{ $env.REDACTED_API_KEY }}' } }],
        }),
      trailingNewline: false,
    },
    { name: 'official__9_master_only.json', body: annotated({ ...twin, id: 9 }), trailingNewline: false },
  ];
}

describe('the cross-folder trim equivalence proof', () => {
  it('compares every template id present in both folders, and only those', () => {
    const proof = measureTrimEquivalence({ curatedDir: curatedDir(), masterDir: bodyDir(masterFiles()) });

    // 7 and 8 are in both folders; 10 is curated-only and 9 is master-only.
    expect(proof.pairsCompared).toBe(2);
    expect(proof.canonicalMatches + proof.contentMismatchIds.length).toBe(proof.pairsCompared);
    expect(proof.encoderFidelity).toEqual({ curatedRoundTrips: 2, masterRoundTrips: 2 });
    expect(trimEquivalenceReconciles(proof)).toEqual([]);
  });

  it('measures canonical equality and raw byte equality separately, and never conflates them', () => {
    const proof = measureTrimEquivalence({ curatedDir: curatedDir(), masterDir: bodyDir(masterFiles()) });

    // 7: identical once the two annotation keys are removed, in content and in bytes.
    // 8: the master carries a redaction placeholder where the curated twin carries the real value.
    expect(proof.canonicalMatches).toBe(1);
    expect(proof.rawByteMatches).toBe(1);
    expect(proof.formatOnlyMatches).toBe(0);
    expect(proof.contentMismatchIds).toEqual([8]);
    expect(proof.removedKeyHistogram).toEqual([
      { key: '_documentation', count: 2 },
      { key: '_security', count: 2 },
    ]);
    expect(proof.sampleMismatches).toEqual([
      { templateId: 8, file: 'official__8_redacted.json', differingPaths: ['nodes[0].parameters.sheetId'] },
    ]);
  });

  it('reports a key-order difference as a canonical match and a raw byte mismatch', () => {
    // Same content, different key order: the sorted-key comparison holds, the byte
    // comparison does not, and the two counts must not be reported as one another.
    const reordered = {
      name: twin.name,
      nodes: twin.nodes,
      id: twin.id,
      connections: twin.connections,
      settings: twin.settings,
      _security: { verdict: 'safe' },
      _documentation: { title: 'prose' },
    };
    const proof = measureTrimEquivalence({
      curatedDir: bodyDir([{ name: 'official__7_twin.json', body: twin, trailingNewline: true }]),
      masterDir: bodyDir([{ name: 'official__7_twin.json', body: reordered, trailingNewline: false }]),
    });

    expect(proof.pairsCompared).toBe(1);
    expect(proof.canonicalMatches).toBe(1);
    expect(proof.rawByteMatches).toBe(0);
    expect(proof.formatOnlyMatches).toBe(1);
    expect(proof.contentMismatchIds).toEqual([]);
  });

  it('refuses its own verdict when a single pair differs beyond its annotations', () => {
    const proof = measureTrimEquivalence({ curatedDir: curatedDir(), masterDir: bodyDir(masterFiles()) });

    expect(proof.verdict).toBe('trim-refused');
    expect(proof.verdictReason).toContain('1 of 2');
  });

  it('serializes deterministically with the schema stamp on the artifact', () => {
    // The same folders, twice: the artifact is a function of the corpus, not of when it ran.
    const curated = curatedDir();
    const master = bodyDir(masterFiles());
    const first = serializeTrimEquivalenceProof(measureTrimEquivalence({ curatedDir: curated, masterDir: master }));
    const second = serializeTrimEquivalenceProof(measureTrimEquivalence({ curatedDir: curated, masterDir: master }));

    expect(second).toBe(first);
    expect(first.endsWith('\n')).toBe(true);
    expect(JSON.parse(first)).toMatchObject({
      schemaVersion: TRIM_EQUIVALENCE_SCHEMA,
      pairsCompared: 2,
      contentMismatchIds: [8],
      verdict: 'trim-refused',
    });
  });
});

/** The smallest shape the gate accepts: every field present and internally consistent. */
function proofFixture(overrides: Partial<TrimEquivalenceProof> = {}): TrimEquivalenceProof {
  return {
    schemaVersion: TRIM_EQUIVALENCE_SCHEMA,
    curatedDir: path.resolve('fixture', 'curated'),
    masterDir: path.resolve('fixture', 'master'),
    pairsCompared: 4,
    canonicalMatches: 4,
    rawByteMatches: 4,
    formatOnlyMatches: 0,
    contentMismatchIds: [],
    sampleMismatches: [],
    removedKeyHistogram: [{ key: '_security', count: 4 }],
    encoderFidelity: { curatedRoundTrips: 4, masterRoundTrips: 4 },
    verdict: 'trim-permitted',
    verdictReason: '4 compared pairs are content-identical once trimmed',
    ...overrides,
  };
}

const masterDirs = [path.resolve('fixture', 'master')];

describe('the trim gate', () => {
  it('permits trimming on a proof of one or more content-identical pairs', () => {
    expect(assessTrimProof(proofFixture(), masterDirs)).toEqual({
      permitted: true,
      reason: '4 compared pairs are content-identical once their annotations are removed',
    });
  });

  it('refuses when a single compared pair differs in content, whatever the byte count says', () => {
    const failed = proofFixture({ canonicalMatches: 3, rawByteMatches: 3, contentMismatchIds: [8] });
    const verdict = assessTrimProof(failed, masterDirs);

    expect(verdict.permitted).toBe(false);
    expect(verdict.reason).toContain('1 of 4');
  });

  it('refuses an empty proof, which would otherwise pass by comparing nothing', () => {
    const verdict = assessTrimProof(
      proofFixture({ pairsCompared: 0, canonicalMatches: 0, rawByteMatches: 0, encoderFidelity: { curatedRoundTrips: 0, masterRoundTrips: 0 } }),
      masterDirs,
    );

    expect(verdict.permitted).toBe(false);
    expect(verdict.reason).toContain('no pairs');
  });

  it('refuses a proof that is not scoped to the folders being read', () => {
    const verdict = assessTrimProof(proofFixture(), [path.resolve('fixture', 'somewhere-else')]);

    expect(verdict.permitted).toBe(false);
    expect(verdict.reason).toContain('not one of the folders');
  });

  it('refuses a proof whose own counts do not reconcile', () => {
    const verdict = assessTrimProof(proofFixture({ contentMismatchIds: [8] }), masterDirs);

    expect(verdict.permitted).toBe(false);
    expect(verdict.reason).toContain('does not reconcile');
  });

  it('refuses an artifact written against another schema', () => {
    const verdict = assessTrimProof(proofFixture({ schemaVersion: 'official-body-trim-equivalence-v0' }), masterDirs);

    expect(verdict.permitted).toBe(false);
    expect(verdict.reason).toContain('schema');
  });
});
