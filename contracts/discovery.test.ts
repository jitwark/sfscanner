import { describe, expect, it } from 'vitest';
import {
  normalizeDiscoverySlug,
  normalizeTaxonomyValue,
  toNormalizedTag,
} from './discovery';

describe('discovery taxonomy', () => {
  it('uses canonical serializable slugs and labels', () => {
    expect(toNormalizedTag('trigger', 'Execute-Workflow', 4)).toEqual({
      slug: 'execute-workflow',
      label: 'Execute Workflow',
      group: 'trigger',
      count: 4,
    });
    expect(toNormalizedTag('security', 'LOW', 2)).toEqual({
      slug: 'LOW',
      label: 'LOW',
      group: 'security',
      count: 2,
    });
    expect(toNormalizedTag('rights', 'link_only', 1)).toEqual({
      slug: 'link_only',
      label: 'Link-only',
      group: 'rights',
      count: 1,
    });
  });

  it('preserves unknown taxonomy values as unknown instead of guessing', () => {
    expect(normalizeTaxonomyValue('trigger', 'Kafka Event')).toBe('unknown');
    expect(toNormalizedTag('capability', 'surprise-mode', 3)).toEqual({
      slug: 'unknown',
      label: 'Uncategorized',
      group: 'capability',
      count: 3,
    });
  });

  it('normalizes free-form integration and intent slugs once', () => {
    expect(normalizeDiscoverySlug(' Google Sheets ')).toBe('google-sheets');
    expect(normalizeDiscoverySlug('')).toBe('unknown');
    expect(toNormalizedTag('integration', 'custom-crm', 2).label).toBe('Custom CRM');
    expect(toNormalizedTag('intent', 'daily-digest', 1).label).toBe('Daily Digest');
  });
});
