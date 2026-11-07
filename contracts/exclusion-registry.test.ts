import { describe, expect, it } from 'vitest';
import {
  EMPTY_EXCLUSION_REGISTRY,
  appendExclusion,
  createExclusionRegistry,
  type ExclusionRecord,
} from './exclusion-registry';

const VALID_ID = 'a1b2c3d4e5f60718'; // 16 hex chars, matches entryId()'s output shape
const OTHER_ID = '0011223344556677';

function record(overrides: Partial<ExclusionRecord> = {}): ExclusionRecord {
  return {
    id: VALID_ID,
    reason: 'DMCA takedown request 2026-08-27',
    excludedAt: '2026-08-27T00:00:00.000Z',
    ...overrides,
  };
}

describe('createExclusionRegistry', () => {
  it('starts empty and excludes nothing', () => {
    expect(EMPTY_EXCLUSION_REGISTRY.records).toEqual([]);
    expect(EMPTY_EXCLUSION_REGISTRY.isExcluded(VALID_ID)).toBe(false);
  });

  it('accepts a well-formed record and makes it findable both ways', () => {
    const registry = createExclusionRegistry([record()]);
    expect(registry.isExcluded(VALID_ID)).toBe(true);
    expect(registry.isExcluded(OTHER_ID)).toBe(false);
    expect(registry.recordFor(VALID_ID)?.reason).toBe('DMCA takedown request 2026-08-27');
    expect(registry.recordFor(OTHER_ID)).toBeUndefined();
  });

  it('rejects an id that is not the 16-hex-character entryId shape', () => {
    expect(() => createExclusionRegistry([record({ id: 'not-a-real-entry-id' })])).toThrow(/malformed id/);
    expect(() => createExclusionRegistry([record({ id: 'short' })])).toThrow(/malformed id/);
    expect(() => createExclusionRegistry([record({ id: VALID_ID.toUpperCase() })])).toThrow(/malformed id/);
  });

  it('rejects an empty or whitespace-only reason', () => {
    expect(() => createExclusionRegistry([record({ reason: '' })])).toThrow(/no reason/);
    expect(() => createExclusionRegistry([record({ reason: '   ' })])).toThrow(/no reason/);
  });

  it('rejects an invalid excludedAt timestamp', () => {
    expect(() => createExclusionRegistry([record({ excludedAt: 'not-a-date' })])).toThrow(/invalid excludedAt/);
  });

  it('rejects two records for the same id, even with different reasons', () => {
    expect(() =>
      createExclusionRegistry([record(), record({ reason: 'a second, different reason' })]),
    ).toThrow(/more than one record/);
  });

  it('is frozen: neither the registry nor its records array nor a record can be mutated', () => {
    const registry = createExclusionRegistry([record()]);
    expect(Object.isFrozen(registry)).toBe(true);
    expect(Object.isFrozen(registry.records)).toBe(true);
    expect(Object.isFrozen(registry.records[0])).toBe(true);
    expect(() => {
      // @ts-expect-error -- proving the runtime freeze, not the type system
      registry.records.push(record({ id: OTHER_ID }));
    }).toThrow();
    expect(() => {
      // @ts-expect-error -- proving the runtime freeze, not the type system
      registry.records[0].reason = 'tampered';
    }).toThrow();
  });
});

describe('appendExclusion', () => {
  it('returns a new registry with the record added, and does not mutate the original', () => {
    const before = createExclusionRegistry([record()]);
    const after = appendExclusion(before, record({ id: OTHER_ID, reason: 'a second exclusion' }));

    expect(before.isExcluded(OTHER_ID)).toBe(false); // original untouched
    expect(after.isExcluded(VALID_ID)).toBe(true); // carries the old record forward
    expect(after.isExcluded(OTHER_ID)).toBe(true); // and the new one
    expect(after.records).toHaveLength(2);
    expect(before.records).toHaveLength(1);
  });

  it('refuses to re-add or silently overwrite an id already recorded', () => {
    const registry = createExclusionRegistry([record({ reason: 'first reason' })]);
    expect(() => appendExclusion(registry, record({ reason: 'a changed reason' }))).toThrow(
      /already recorded.*first reason/s,
    );
    // The original registry's record is untouched by the rejected attempt.
    expect(registry.recordFor(VALID_ID)?.reason).toBe('first reason');
  });

  it('validates the appended record the same way createExclusionRegistry does', () => {
    expect(() => appendExclusion(EMPTY_EXCLUSION_REGISTRY, record({ id: 'bad-id' }))).toThrow(/malformed id/);
  });
});
