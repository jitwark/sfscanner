import { describe, expect, it } from 'vitest';
import { parseEntryArtifact } from '@hub/contracts/entry-artifact';
import {
  DETAIL_ANALYSIS_STATES,
  DETAIL_COMPLETENESS_STATES,
  DETAIL_DESCRIPTION_LEVELS,
  DETAIL_GRAPH_SHAPES,
  DETAIL_GRADES,
  DETAIL_RIGHTS_CLASSES,
  DETAIL_VARIANT_MATRIX,
} from './detail-variant-fixtures';

describe('workflow detail variant matrix', () => {
  it('covers every declared P5.1 dimension', () => {
    const values = (key: keyof (typeof DETAIL_VARIANT_MATRIX)[number]['dimensions']) =>
      new Set(DETAIL_VARIANT_MATRIX.map((variant) => variant.dimensions[key]));

    expect(values('rights')).toEqual(new Set(DETAIL_RIGHTS_CLASSES));
    expect(values('completeness')).toEqual(new Set(DETAIL_COMPLETENESS_STATES));
    expect(values('analysisStatus')).toEqual(new Set(DETAIL_ANALYSIS_STATES));
    expect(values('grade')).toEqual(new Set(DETAIL_GRADES));
    expect(values('graph')).toEqual(new Set(DETAIL_GRAPH_SHAPES));
    expect(values('description')).toEqual(new Set(DETAIL_DESCRIPTION_LEVELS));
    for (const rights of DETAIL_RIGHTS_CLASSES) {
      for (const completeness of DETAIL_COMPLETENESS_STATES) {
        expect(DETAIL_VARIANT_MATRIX.some((variant) => variant.dimensions.rights === rights && variant.dimensions.completeness === completeness)).toBe(true);
      }
    }
  });

  it('is immutable, uniquely and deterministically ordered', () => {
    const ids = DETAIL_VARIANT_MATRIX.map((variant) => variant.id);
    expect(ids).toEqual([...ids].sort());
    expect(new Set(ids).size).toBe(ids.length);
    expect(JSON.stringify(DETAIL_VARIANT_MATRIX)).toBe(JSON.stringify(DETAIL_VARIANT_MATRIX));
    expect(Object.isFrozen(DETAIL_VARIANT_MATRIX)).toBe(true);
    expect(DETAIL_VARIANT_MATRIX.every((variant) => Object.isFrozen(variant) && Object.isFrozen(variant.entry))).toBe(true);
  });

  it('keeps rights actions and body/licence expectations fail-closed', () => {
    for (const variant of DETAIL_VARIANT_MATRIX) {
      const { entry, expectations } = variant;
      if (entry.rights.status === 'redistributable') {
        expect(expectations.action).toBe('download');
        expect(expectations.body).toBe('included');
        expect(entry.rights.licence).toBe('MIT');
        expect(entry.download).toBeDefined();
      } else if (entry.rights.status === 'link_only') {
        expect(expectations.action).toBe('source');
        expect(expectations.body).toBe('suppressed');
        expect(entry.rights.licence).toBeNull();
        expect(entry.download).toBeUndefined();
      } else {
        expect(expectations.action).toBe('none');
        expect(expectations.body).toBe('absent');
        expect(entry.rights.licence).toBeNull();
        expect(entry.download).toBeUndefined();
      }
    }
  });

  it('makes missing source facts visible instead of inferring them', () => {
    for (const variant of DETAIL_VARIANT_MATRIX) {
      const source = variant.entry.source;
      if (variant.expectations.sourceFacts === 'complete') {
        expect(source.author?.name).toBe('Synthetic Maintainer');
        expect(source.path).toBeDefined();
        expect(source.commit).toBeDefined();
      } else {
        expect(source.author).toBeUndefined();
        expect(source.path).toBeUndefined();
        expect(source.commit).toBeUndefined();
      }
      expect(variant.entry.source.permalink).toContain('synthetic.example.test');
      expect(JSON.stringify(variant.entry)).not.toMatch(/secret|password|api[-_]?key|token/i);
    }
  });

  it('keeps description provenance explicit and never upgrades prose', () => {
    for (const variant of DETAIL_VARIANT_MATRIX) {
      const { entry, description } = variant;
      expect(entry.descriptionSource).toBe(description.source);
      expect(entry.descriptionProvenance?.source ?? 'missing').toBe(description.provenance);
      expect(Boolean(entry.descriptionContent)).toBe(description.hasContent);
      expect(variant.expectations.descriptionPublishable).toBe(description.provenance === 'gemini');
    }
  });

  it('represents malformed and incomplete details without inferred readiness', () => {
    for (const variant of DETAIL_VARIANT_MATRIX) {
      const { entry } = variant;
      expect(entry.security.analysisStatus).toBe(variant.dimensions.analysisStatus);
      if (variant.dimensions.completeness === 'complete') {
        expect(entry.structure.partial).toBeUndefined();
        expect(entry.readiness).toBeDefined();
        expect(parseEntryArtifact(entry)).toMatchObject({ id: entry.id });
      } else {
        expect(entry.structure.partial).toBe(true);
        expect(entry.readiness).toBeUndefined();
      }
      if (variant.dimensions.graph === 'malformed') {
        expect(variant.chart).toBeNull();
        expect(variant.malformedChart).toMatchObject({ nodes: [{ x: 'not-a-number' }] });
      }
    }
  });
});
