import { describe, expect, it } from 'vitest';
import { canonicalizeJson, canonicalizeJsonForHash, fingerprint, structuralHash } from './signatures.js';

describe('dedup/signatures', () => {
  describe('fingerprint', () => {
    it('uses explicit JSON encodings for strings, booleans, null, and finite numbers', () => {
      expect(canonicalizeJson({ z: 'café', a: 'line\n"', n: -0, huge: 1e21, small: 1e-7, bool: false, nil: null }))
        .toBe('{"a":"line\\n\\\"","bool":false,"huge":1e+21,"n":0,"nil":null,"small":1e-7,"z":"café"}');
    });

    it('rejects values outside the canonical JSON domain', () => {
      expect(() => canonicalizeJson(undefined)).toThrow(/canonical JSON/);
      expect(() => canonicalizeJson(Number.NaN)).toThrow(/canonical JSON/);
      expect(() => canonicalizeJson(Infinity)).toThrow(/canonical JSON/);
      expect(() => canonicalizeJson({ missing: undefined })).toThrow(/canonical JSON/);
    });

    it('hashes object snapshots using their JSON representation without weakening strict validation', () => {
      expect(canonicalizeJsonForHash({ present: 'value', missing: undefined })).toBe('{"present":"value"}');
      expect(() => canonicalizeJsonForHash({ invalid: Number.NaN })).toThrow(/canonical JSON/);
    });

    it('produces identical sha256 for objects with different key ordering', () => {
      const obj1 = { b: 2, a: 1, nested: { y: 'hello', x: 10 } };
      const obj2 = { a: 1, nested: { x: 10, y: 'hello' }, b: 2 };

      expect(fingerprint(obj1)).toBe(fingerprint(obj2));
    });

    it('produces different sha256 for different content', () => {
      const obj1 = { name: 'Workflow A' };
      const obj2 = { name: 'Workflow B' };

      expect(fingerprint(obj1)).not.toBe(fingerprint(obj2));
    });
  });

  describe('structuralHash', () => {
    it('collides when workflows differ only by renamed node names and ids', () => {
      const wf1 = {
        nodes: [
          { id: 'node_1', name: 'Start Webhook', type: 'n8n-nodes-base.webhook' },
          { id: 'node_2', name: 'Fetch Data', type: 'n8n-nodes-base.httpRequest' },
        ],
        connections: {
          'Start Webhook': {
            main: [[{ node: 'Fetch Data', type: 'main', index: 0 }]],
          },
        },
      };

      const wf2 = {
        nodes: [
          { id: 'n_a', name: 'MyTrigger', type: 'n8n-nodes-base.webhook' },
          { id: 'n_b', name: 'HTTP Client', type: 'n8n-nodes-base.httpRequest' },
        ],
        connections: {
          MyTrigger: {
            main: [[{ node: 'HTTP Client', type: 'main', index: 0 }]],
          },
        },
      };

      expect(structuralHash(wf1)).toBe(structuralHash(wf2));
    });

    it('does not collide when edge topology differs', () => {
      const wf1 = {
        nodes: [
          { id: '1', name: 'Start', type: 'n8n-nodes-base.webhook' },
          { id: '2', name: 'NodeA', type: 'n8n-nodes-base.httpRequest' },
          { id: '3', name: 'NodeB', type: 'n8n-nodes-base.slack' },
        ],
        connections: {
          Start: {
            main: [[{ node: 'NodeA', type: 'main', index: 0 }]],
          },
          NodeA: {
            main: [[{ node: 'NodeB', type: 'main', index: 0 }]],
          },
        },
      };

      const wf2 = {
        nodes: [
          { id: '1', name: 'Start', type: 'n8n-nodes-base.webhook' },
          { id: '2', name: 'NodeA', type: 'n8n-nodes-base.httpRequest' },
          { id: '3', name: 'NodeB', type: 'n8n-nodes-base.slack' },
        ],
        connections: {
          Start: {
            main: [
              [{ node: 'NodeA', type: 'main', index: 0 }],
              [{ node: 'NodeB', type: 'main', index: 0 }],
            ],
          },
        },
      };

      expect(structuralHash(wf1)).not.toBe(structuralHash(wf2));
    });
  });
});
