import { describe, expect, test } from 'vitest';
import {
  CATEGORY_DOMAINS,
  CLASSIFIER_VERSION,
  MIN_CONFIDENCE,
  TAXONOMY,
  isCategoryDomain,
  summarizeClassifications,
  validateClassification,
} from './taxonomy';

const PROMPT = 'describe-2';
const valid = { domain: 'ai-and-agents', subcategory: 'agents', confidence: 0.9 };

describe('the enum itself', () => {
  test('exposes domains in a stable sorted order', () => {
    expect(CATEGORY_DOMAINS).toEqual([...CATEGORY_DOMAINS].sort());
    expect(CATEGORY_DOMAINS).toHaveLength(7);
  });

  test('every domain has subcategories, and none are shared between domains', () => {
    const seen = new Set<string>();
    for (const domain of CATEGORY_DOMAINS) {
      const subs = TAXONOMY[domain] as readonly string[];
      expect(subs.length).toBeGreaterThan(0);
      for (const sub of subs) {
        expect(seen.has(sub)).toBe(false);
        seen.add(sub);
      }
    }
  });

  test('recognizes only real domains', () => {
    expect(isCategoryDomain('ai-and-agents')).toBe(true);
    expect(isCategoryDomain('made-up')).toBe(false);
    expect(isCategoryDomain('toString')).toBe(false);
    expect(isCategoryDomain(null)).toBe(false);
  });
});

describe('validateClassification accepts only what the enum allows', () => {
  test('accepts a well-formed confident answer', () => {
    expect(validateClassification(valid, PROMPT)).toEqual({
      domain: 'ai-and-agents',
      subcategory: 'agents',
      confidence: 0.9,
      classifierVersion: CLASSIFIER_VERSION,
      promptVersion: PROMPT,
      validationStatus: 'VALID',
    });
  });

  test('a novel domain becomes uncategorized, never a new category', () => {
    const result = validateClassification({ ...valid, domain: 'crypto-trading' }, PROMPT);
    expect(result.domain).toBeNull();
    expect(result.validationStatus).toBe('UNKNOWN_DOMAIN');
  });

  test('a subcategory from the wrong domain is refused', () => {
    // `invoicing` is real, but it does not belong to ai-and-agents.
    const result = validateClassification({ ...valid, subcategory: 'invoicing' }, PROMPT);
    expect(result.domain).toBeNull();
    expect(result.validationStatus).toBe('UNKNOWN_SUBCATEGORY');
  });

  test('low confidence is recorded rather than accepted', () => {
    const result = validateClassification({ ...valid, confidence: MIN_CONFIDENCE - 0.01 }, PROMPT);
    expect(result.domain).toBeNull();
    expect(result.validationStatus).toBe('LOW_CONFIDENCE');
    expect(result.confidence).toBeCloseTo(MIN_CONFIDENCE - 0.01);
  });

  test.each([null, undefined, 'a string', 42, [], {}])('malformed input %j is uncategorized', (raw) => {
    const result = validateClassification(raw, PROMPT);
    expect(result.domain).toBeNull();
    expect(result.classifierVersion).toBe(CLASSIFIER_VERSION);
  });

  test('clamps an out-of-range confidence instead of trusting it', () => {
    expect(validateClassification({ ...valid, confidence: 7 }, PROMPT).confidence).toBe(1);
    expect(validateClassification({ ...valid, confidence: -3 }, PROMPT).confidence).toBe(0);
    expect(validateClassification({ ...valid, confidence: NaN }, PROMPT).confidence).toBe(0);
  });

  test('always records the versions, including on failure', () => {
    const result = validateClassification('garbage', PROMPT);
    expect(result.classifierVersion).toBe(CLASSIFIER_VERSION);
    expect(result.promptVersion).toBe(PROMPT);
  });
});

describe('summarizeClassifications', () => {
  test('counts outcomes so a cohort can be aborted on them', () => {
    const summary = summarizeClassifications([
      validateClassification(valid, PROMPT),
      validateClassification({ ...valid, domain: 'nope' }, PROMPT),
      validateClassification({ ...valid, confidence: 0.1 }, PROMPT),
    ]);

    expect(summary.total).toBe(3);
    expect(summary.categorized).toBe(1);
    expect(summary.uncategorizedRate).toBeCloseTo(2 / 3);
    expect(summary.byStatus).toEqual({ VALID: 1, UNKNOWN_DOMAIN: 1, LOW_CONFIDENCE: 1 });
  });

  test('handles an empty cohort without dividing by zero', () => {
    expect(summarizeClassifications([])).toEqual({
      total: 0,
      categorized: 0,
      uncategorizedRate: 0,
      byStatus: {},
    });
  });
});
