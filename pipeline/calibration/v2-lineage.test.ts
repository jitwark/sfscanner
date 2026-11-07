import { describe, expect, it } from 'vitest';
import {
  groupCalibrationLineage,
  CalibrationLineageError,
  type CalibrationLineageRecord,
} from './v2-lineage';

const digest = (hex: string) => hex.repeat(64 / hex.length);

function record(id: string, overrides: Partial<CalibrationLineageRecord> = {}): CalibrationLineageRecord {
  return {
    id,
    provenance: {
      source: 'github:example/repo',
      commit: 'a'.repeat(40),
      path: `workflows/${id}.json`,
      licence: 'MIT',
      permission: 'redistributable',
      digest: digest('a'),
    },
    repository: 'github:example/repo',
    labelSource: 'independent-review',
    reviewer: 'reviewer-a',
    dispute: 'NONE',
    ...overrides,
  };
}

describe('groupCalibrationLineage', () => {
  it('connects explicit repository, template, and near-duplicate lineage transitively', () => {
    const values = [
      record('repository-link', { provenance: { ...record('repository-link').provenance, digest: digest('b') } }),
      record('template-link', {
        repository: 'github:other/repo',
        provenance: { ...record('template-link').provenance, source: 'github:other/repo', digest: digest('c') },
        templateId: 'template-42',
      }),
      record('near-link', {
        repository: 'github:third/repo',
        provenance: { ...record('near-link').provenance, source: 'github:third/repo', digest: digest('d') },
        templateId: 'template-42',
        nearDuplicateGroup: 'near-7',
      }),
      record('repository-link-2', { provenance: { ...record('repository-link-2').provenance, digest: digest('e') }, nearDuplicateGroup: 'near-7' }),
    ];
    const result = groupCalibrationLineage(values);
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0]?.caseIds).toEqual([
      'near-link', 'repository-link', 'repository-link-2', 'template-link',
    ]);
    expect(result.records.every((item) => item.lineageGroup === result.groups[0]?.groupId)).toBe(true);
    expect(result.records.find((item) => item.id === 'template-link')?.provenance.licence).toBe('MIT');
  });

  it('is deterministic for repeated and permuted input', () => {
    const values = [
      record('b', { provenance: { ...record('b').provenance, digest: digest('b') } }),
      record('a', { provenance: { ...record('a').provenance, digest: digest('c') } }),
    ];
    const first = groupCalibrationLineage(values);
    const second = groupCalibrationLineage([...values].reverse());
    expect(second).toEqual(first);
  });

  it('rejects duplicate digests and incomplete provenance/licence evidence', () => {
    expect(() => groupCalibrationLineage([
      record('one'), record('two', { provenance: { ...record('two').provenance, digest: digest('a') } }),
    ])).toThrow(CalibrationLineageError);
    expect(() => groupCalibrationLineage([
      record('missing', { provenance: { ...record('missing').provenance, licence: '' } }),
    ])).toThrow(/licen[cs]e|provenance/i);
  });

  it('retains unlabelled evidence without inventing a label or review', () => {
    const value = record('unlabelled', { labelSource: undefined, reviewer: undefined, dispute: 'HUMAN_REQUIRED' });
    const result = groupCalibrationLineage([value]);
    expect(result.records[0]).toMatchObject({ id: 'unlabelled', labelSource: undefined, reviewer: undefined, dispute: 'HUMAN_REQUIRED' });
  });
  it('accepts explicit flat provenance fields when no nested record is supplied', () => {
    const result = groupCalibrationLineage([{
      id: 'flat-provenance',
      source: 'github:flat/repo',
      commit: 'a'.repeat(40),
      path: 'workflow.json',
      licence: 'MIT',
      permission: 'redistributable',
      digest: digest('f'),
    }]);
    expect(result.records[0]?.provenance).toMatchObject({ source: 'github:flat/repo', commit: 'a'.repeat(40), path: 'workflow.json', licence: 'MIT', permission: 'redistributable' });
  });
});
