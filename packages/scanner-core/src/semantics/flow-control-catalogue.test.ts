import { describe, expect, it } from 'vitest';
import { adaptSemanticEndpoints } from '../analyzers/taint-v2/catalogue-adapter';
import { BUILTIN_SEMANTIC_CATALOGUE_V2 } from './builtin-catalogue';
import { resolveNodeSemantics } from './catalogue-resolver';
import { createSemanticCatalogueDigest } from './catalogue-admission';

const EXPECTED = {
  'n8n-nodes-base.set': 'flow-control.set',
  'n8n-nodes-base.if': 'flow-control.if',
  'n8n-nodes-base.switch': 'flow-control.switch',
  'n8n-nodes-base.merge': 'flow-control.merge',
  'n8n-nodes-base.splitInBatches': 'flow-control.split-in-batches',
  'n8n-nodes-base.scheduleTrigger': 'flow-control.schedule-trigger',
  'n8n-nodes-base.googleSheets': 'google-workspace.google-sheets',
} as const;
const VERSION = {
  'n8n-nodes-base.set': '3.4.0',
  'n8n-nodes-base.if': '2.3.0',
  'n8n-nodes-base.switch': '3.4.0',
  'n8n-nodes-base.merge': '3.2.0',
  'n8n-nodes-base.splitInBatches': '3.0.0',
  'n8n-nodes-base.scheduleTrigger': '1.3.0',
  'n8n-nodes-base.googleSheets': '4.7.0',
} as const;

describe('flow-control catalogue coverage', () => {
  it('resolves every pinned family at a source-declared version', () => {
    for (const [nodeType, semanticId] of Object.entries(EXPECTED)) {
      const record = resolveNodeSemantics(BUILTIN_SEMANTIC_CATALOGUE_V2, { nodeType, version: VERSION[nodeType as keyof typeof VERSION] });
      expect(record?.semanticId, nodeType).toBe(semanticId);
    }
  });

  it('claims no external effects or destinations for pure flow control', () => {
    for (const [nodeType, semanticId] of Object.entries(EXPECTED).filter(([nodeType]) => nodeType !== 'n8n-nodes-base.googleSheets')) {
      const record = BUILTIN_SEMANTIC_CATALOGUE_V2.records.find((item) => item.semanticId === semanticId)!;
      expect(record.nodeType).toBe(nodeType);
      expect(record.entry === 'TRIGGER' ? [] : record.effects).toEqual([]);
      expect(record.destinationPaths).toEqual([]);
      expect(record.credentialPaths).toEqual([]);
    }
  });

  it('models Google Sheets as a conservative external integration', () => {
    const record = BUILTIN_SEMANTIC_CATALOGUE_V2.records.find((item) => item.semanticId === 'google-workspace.google-sheets')!;
    expect(record.effects).toEqual(['READ_EXTERNAL', 'WRITE_EXTERNAL']);
    expect(record.destinationPaths).toContain('/documentId');
    expect(record.credentialPaths).toContain('/credentials/googleSheetsOAuth2Api');
  });

  it('does not claim a fixed port count for dynamic switch outputs', () => {
    const record = BUILTIN_SEMANTIC_CATALOGUE_V2.records.find((item) => item.semanticId === 'flow-control.switch')!;
    expect(record.ports).toEqual([]);
  });

  it('matches Filter V1 and V2 single Main outputs', () => {
    for (const version of ['1.0.0', '2.0.0', '2.1.0', '2.2.0', '2.3.0']) {
      const record = resolveNodeSemantics(BUILTIN_SEMANTIC_CATALOGUE_V2, { nodeType: 'n8n-nodes-base.filter', version });
      expect(record?.semanticId, version).toBe('flow-control.filter');
      expect(record?.ports, version).toEqual([{ type: 'main', index: 0, itemMode: 'EACH' }]);
    }
  });

  it('keeps partial new-family metadata on the unknown analyzer path', () => {
    for (const semanticId of ['google-workspace.google-drive', 'flow-control.filter', 'flow-control.aggregate']) {
      const record = BUILTIN_SEMANTIC_CATALOGUE_V2.records.find((item) => item.semanticId === semanticId)!;
      expect(record.errorMode, semanticId).toBe('UNKNOWN');
      expect(record.retryMode, semanticId).toBe('UNKNOWN');
      expect(adaptSemanticEndpoints({ node: { ref: { ordinal: 0 }, type: record.nodeType } as never, semantics: record }).status, semanticId).toBe('UNKNOWN');
    }
  });

  it('keeps unknown versions fail-closed', () => {
    expect(resolveNodeSemantics(BUILTIN_SEMANTIC_CATALOGUE_V2, { nodeType: 'n8n-nodes-base.noOp', version: '2.0.0' })).toBeNull();
    expect(resolveNodeSemantics(BUILTIN_SEMANTIC_CATALOGUE_V2, { nodeType: 'n8n-nodes-base.set', version: '9.0.0' })).toBeNull();
  });

  it('pins the recomputed catalogue digest and content version', () => {
    const { digest: _digest, ...body } = BUILTIN_SEMANTIC_CATALOGUE_V2;
    expect(BUILTIN_SEMANTIC_CATALOGUE_V2.version).toBe('2.2.0');
    expect(createSemanticCatalogueDigest(body)).toBe('58419339dcf99ed398d2955282662e6f6d37208f62393cafb56818d4a38182d7');
  });
});
