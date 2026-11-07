import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import type { Entry } from '@hub/contracts';
import { makeEntry } from './__fixtures__/make-entry';
import { parseArgs, selectDescriptionTargets, uniqueCanonicalEntries } from './run-enrichment';

function makeTestEntry(id: string): Entry {
  return makeEntry({ id, slug: id, title: id });
}

describe('selectDescriptionTargets', () => {
  test('uses the description limit for outstanding work rather than the corpus prefix', () => {
    const entries = ['one', 'two', 'three', 'four'].map(makeTestEntry);
    const checkpoint = {
      one: { summary: 'one', description: 'one', descriptionSource: 'generated' as const },
      two: { summary: 'two', description: 'two', descriptionSource: 'generated' as const },
    };

    expect(selectDescriptionTargets(entries, checkpoint, 1, false).map((entry) => entry.id)).toEqual([
      'three',
    ]);
  });

  test('includes checkpointed fallbacks only when explicitly requested', () => {
    const entries = ['one', 'two', 'three'].map(makeTestEntry);
    const checkpoint = {
      one: { summary: 'one', description: 'one', descriptionSource: 'generated' as const },
      two: { summary: 'two', description: 'two', descriptionSource: 'fallback' as const },
    };

    expect(selectDescriptionTargets(entries, checkpoint, 2, true).map((entry) => entry.id)).toEqual([
      'two',
      'three',
    ]);
  });
});

describe('parseArgs', () => {
  test('supports describing without replacing packaged artifacts', () => {
    expect(
      parseArgs(['--run', 'fixture', '--describe-limit', '40', '--describe-only']),
    ).toMatchObject({
      runId: 'fixture',
      describeLimit: 40,
      describeOnly: true,
    });
  });

  test('parses bounded batch and verification controls', () => {
    expect(parseArgs([
      '--run', 'fixture', '--enrichment-batch-size', '25', '--verify-only',
      '--batch-ledger', 'ledger.json',
    ])).toMatchObject({
      enrichmentBatchSize: 25,
      verifyOnly: true,
      batchLedgerPath: 'ledger.json',
      checkpointPath: undefined,
      batchManifestPath: undefined,
    });
    expect(parseArgs(['--run', 'fixture', '--preflight']).preflightOnly).toBe(true);
  });

  test('supports isolated checkpoint and manifest paths for a canary', () => {
    expect(parseArgs([
      '--run', 'fixture', '--checkpoint', 'canary-checkpoint.json', '--batch-manifest', 'canary-manifest.json',
    ])).toMatchObject({
      checkpointPath: 'canary-checkpoint.json',
      batchManifestPath: 'canary-manifest.json',
    });
  });
});

describe('uniqueCanonicalEntries', () => {
  test('collapses a duplicate official page record when only fetch time differs', () => {
    const first = makeTestEntry('same');
    const second = makeTestEntry('same');
    second.source = { ...second.source, fetchedAt: '2026-01-02T00:00:00.000Z' };

    expect(uniqueCanonicalEntries([first, second])).toEqual([first]);
  });

  test('fails closed when duplicate IDs have different catalogue metadata', () => {
    const first = makeTestEntry('same');
    const second = makeTestEntry('same');
    second.title = 'Different title';

    expect(() => uniqueCanonicalEntries([first, second])).toThrow(/conflicting records/);
  });
});

describe('scanner dependency boundary', () => {
  test('uses the pipeline scanner-core seam for in-process rescans', () => {
    const source = fs.readFileSync(
      fileURLToPath(new URL('./run-enrichment.ts', import.meta.url)),
      'utf8',
    );

    expect(source).toMatch(
      /import \{ scanWorkflowWithCore \} from '\.\/scan\/scanner-core-adapter\.js';/,
    );
    expect(source).toMatch(/scanWorkflowWithCore\(\s*workflow\s+as\s+Parameters/);
    expect(source).not.toContain("await import('../app/src/scanner/engine.js')");
    expect(source).not.toContain("await import('../app/src/workflow/workflow.js')");
  });
});
