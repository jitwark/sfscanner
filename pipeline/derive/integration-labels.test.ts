import { describe, expect, it } from 'vitest';
import { INTEGRATION_MAP } from '../enrich/integration-map.js';
import { integrationLabelForNodeType } from './structure.js';
import {
  canonicalIntegrationLabel,
  legacyIntegrationLabel,
  normalizeIntegrationLabels,
} from './integration-labels.js';

describe('canonicalIntegrationLabel', () => {
  it('maps a published legacy label back to the vendor tag its node type produces today', () => {
    // The label the pre-679f0d0 normaliser emitted for `n8n-nodes-base.googleSheets`
    // is `google-sheets`; today's mapping turns the node type itself into the same tag.
    expect(legacyIntegrationLabel('n8n-nodes-base.googleSheets')).toBe('google-sheets');
    expect(integrationLabelForNodeType('n8n-nodes-base.googleSheets')).toBe('google-sheets');
    expect(canonicalIntegrationLabel('google-sheets')).toBe('google-sheets');
  });

  it('drops a capability label that is not a vendor product', () => {
    // `httpRequest` publishes the capability word `http-request`; its only tag is
    // the non-vendor `http`, so it contributes no integration — same as today.
    expect(canonicalIntegrationLabel('http-request')).toBeNull();
    expect(canonicalIntegrationLabel('code')).toBeNull();
    expect(canonicalIntegrationLabel('schedule')).toBeNull();
  });

  it('drops a community node type the integration map does not describe', () => {
    expect(canonicalIntegrationLabel('@acme/n8n-nodes-acme.acme')).toBeNull();
  });

  it('resolves a label naming two node types deterministically, independent of insertion order', () => {
    // `googleSheets` and `googleSheetsTrigger` both collapse to `google-sheets`.
    expect(legacyIntegrationLabel('n8n-nodes-base.googleSheetsTrigger')).toBe('google-sheets');
    const again = canonicalIntegrationLabel('google-sheets');
    expect(again).toBe('google-sheets');
  });

  it('is case- and whitespace-insensitive in the published label', () => {
    expect(canonicalIntegrationLabel('  Google-Sheets  ')).toBe('google-sheets');
  });

  it('reproduces the body-derived tag for every node type the map describes', () => {
    // The invariant that makes a body-less entry's label mean the same thing as a
    // body-derived one: mapping a published label yields exactly the tag that
    // node type produces today — for every node type the map knows.
    let withTag = 0;
    for (const key of Object.keys(INTEGRATION_MAP)) {
      const direct = integrationLabelForNodeType(key);
      if (!direct) continue;
      withTag += 1;
      expect(canonicalIntegrationLabel(legacyIntegrationLabel(key))).toBe(direct);
    }
    expect(withTag).toBeGreaterThan(40);
  });
});

describe('normalizeIntegrationLabels', () => {
  it('maps, drops, dedupes and sorts like a body-derived list', () => {
    expect(normalizeIntegrationLabels(['telegram', 'code', 'google-sheets', 'gmail', 'telegram']))
      .toEqual(['gmail', 'google-sheets', 'telegram']);
  });

  it('returns an empty list when no published label names a mapped integration', () => {
    expect(normalizeIntegrationLabels(['code', 'set', 'http-request', 'if'])).toEqual([]);
  });

  it('tolerates a non-conforming label without throwing', () => {
    expect(normalizeIntegrationLabels(['', '  ', '.3ds'])).toEqual([]);
  });
});
