import { describe, expect, test } from 'vitest';
import { estimateSimilarity, findNearDuplicates, minhash, shingles } from './similarity';

const boilerplate = (service: string) =>
  `This workflow waits for a web hook to fire. It reads the data that comes in. It checks the fields it needs are there. Then it builds a short message and sends it to ${service}.`;

describe('shingles', () => {
  test('produces overlapping word triples', () => {
    expect([...shingles('a b c d')]).toEqual(['a b c', 'b c d']);
  });

  test('ignores punctuation and case so formatting cannot hide a duplicate', () => {
    expect([...shingles('Read the Data.')]).toEqual([...shingles('read   the data')]);
  });

  test('keeps a short text as a single shingle rather than dropping it', () => {
    expect([...shingles('two words')]).toEqual(['two words']);
    expect([...shingles('')]).toEqual([]);
  });
});

describe('minhash', () => {
  test('is deterministic across calls', () => {
    expect(minhash('the workflow reads a sheet')).toEqual(minhash('the workflow reads a sheet'));
  });

  test('identical text gives identical signatures', () => {
    expect(estimateSimilarity(minhash(boilerplate('Slack')), minhash(boilerplate('Slack')))).toBe(1);
  });

  test('unrelated text scores low', () => {
    const a = minhash('This workflow reads rows from a sheet and writes them to a database.');
    const b = minhash('Whales migrate across the ocean each year to find warmer water.');
    expect(estimateSimilarity(a, b)).toBeLessThan(0.2);
  });
});

describe('findNearDuplicates', () => {
  test('catches boilerplate that differs only in the service name', () => {
    const pairs = findNearDuplicates([
      { id: 'a', text: boilerplate('Slack') },
      { id: 'b', text: boilerplate('Telegram') },
    ]);

    expect(pairs).toHaveLength(1);
    expect(pairs[0]?.a).toBe('a');
    expect(pairs[0]?.b).toBe('b');
    expect(pairs[0]?.similarity).toBeGreaterThan(0.6);
  });

  test('does not pair genuinely different descriptions', () => {
    expect(
      findNearDuplicates([
        { id: 'a', text: 'This workflow reads rows from a sheet and writes them to a database.' },
        { id: 'b', text: 'This workflow watches a folder and sends a note when a file lands.' },
      ]),
    ).toEqual([]);
  });

  test('returns each pair once, ordered, never mirrored', () => {
    const pairs = findNearDuplicates([
      { id: 'z', text: boilerplate('Slack') },
      { id: 'a', text: boilerplate('Gmail') },
    ]);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]?.a).toBe('a');
    expect(pairs[0]?.b).toBe('z');
  });

  test('is stable: the same cohort in a different order gives the same pairs', () => {
    const documents = [
      { id: 'a', text: boilerplate('Slack') },
      { id: 'b', text: boilerplate('Telegram') },
      { id: 'c', text: 'A completely separate description about reading files from disk.' },
    ];
    const forward = findNearDuplicates(documents);
    const reversed = findNearDuplicates([...documents].reverse());
    expect(forward).toEqual(reversed);
  });

  test('handles an empty cohort and a single document', () => {
    expect(findNearDuplicates([])).toEqual([]);
    expect(findNearDuplicates([{ id: 'only', text: boilerplate('Slack') }])).toEqual([]);
  });

  test('bounds work: a cohort of identical texts does not explode into ordered duplicates', () => {
    const documents = Array.from({ length: 20 }, (_, index) => ({
      id: `id-${index}`,
      text: boilerplate('Slack'),
    }));
    // 20 identical documents means 190 unordered pairs, each reported once.
    expect(findNearDuplicates(documents)).toHaveLength(190);
  });
});
