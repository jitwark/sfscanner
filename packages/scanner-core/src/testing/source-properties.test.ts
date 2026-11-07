import { describe, expect, it } from 'vitest';
import { DEFAULT_SCANNER_LIMITS_V2, type ScannerLimitsV2 } from '@hub/contracts';
import { normalizeSecurityWorkflow } from '../workflow-v2/normalize-security-workflow';
import { parseSourceDocument } from '../source/source-parser';
import type { SourceParseResult } from '../source/source-types';
import {
  createPropertyRng,
  malformedByteCases,
  unicodeCases,
  workflowCases,
} from './property-generators';

const encoder = new TextEncoder();
const profileLimits = (overrides: Partial<ScannerLimitsV2> = {}): ScannerLimitsV2 => ({
  ...DEFAULT_SCANNER_LIMITS_V2,
  ...overrides,
});

function assertPosition(position: { line: number; column: number; utf16Offset: number; utf8ByteOffset: number }, text: string): void {
  const prefix = text.slice(0, position.utf16Offset);
  const lineBreaks = prefix.match(/\n/g)?.length ?? 0;
  const lastBreak = prefix.lastIndexOf('\n');
  expect(position.line).toBe(lineBreaks + 1);
  expect(position.column).toBe(prefix.length - lastBreak);
  expect(position.utf8ByteOffset).toBe(encoder.encode(prefix).length);
}

describe('scanner-core deterministic source properties', () => {

  it('replays fixed-seed PRNG sequences exactly', () => {
    const first = createPropertyRng(0x1002);
    const second = createPropertyRng(0x1002);
    for (let index = 0; index < 32; index += 1) {
      expect(first.nextUint32()).toBe(second.nextUint32());
    }
  });

  it('returns bounded closed failures for malformed bytes without throwing', () => {
    for (const bytes of malformedByteCases(0x1003, 32)) {
      let result: SourceParseResult | undefined;
      expect(() => {
        result = parseSourceDocument(bytes, profileLimits({ maxBytes: 256 }));
      }).not.toThrow();
      expect(result?.ok).toBe(false);
      if (result && !result.ok) {
        expect(['UTF8_DECODING_FAILED', 'INVALID_JSON']).toContain(result.code);
        expect(Object.keys(result)).toEqual(expect.arrayContaining(['ok', 'code', 'message']));
      }
    }
  });

  it('terminates at a configured source-depth bound with a closed outcome', () => {
    for (const item of workflowCases(0x1004, 8)) {
      const result = parseSourceDocument(
        encoder.encode(item.canonical),
        profileLimits({ maxDocumentDepth: 1 }),
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('WORKFLOW_TOO_COMPLEX');
        if (result.code === 'WORKFLOW_TOO_COMPLEX') {
          expect(result.cause).toBe('DOCUMENT_DEPTH_LIMIT');
        }
      }
    }
  });

  it('keeps Unicode coordinates stable across UTF-8 BOM handling', () => {
    for (const item of unicodeCases(0x1005, 16)) {
      const plainBytes = encoder.encode(item.text);
      const bomBytes = Uint8Array.of(0xef, 0xbb, 0xbf, ...plainBytes);
      const plain = parseSourceDocument(plainBytes, profileLimits());
      const bom = parseSourceDocument(bomBytes, profileLimits());
      expect(plain.ok).toBe(true);
      expect(bom.ok).toBe(true);
      if (!plain.ok || !bom.ok) continue;
      expect(plain.document.bom).toBe('NONE');
      expect(bom.document.bom).toBe('UTF8');
      expect(plain.document.rawSha256).not.toBe(bom.document.rawSha256);
      if (plain.document.root.kind !== 'OBJECT' || bom.document.root.kind !== 'OBJECT') continue;
      const plainSpan = plain.document.root.members[0]?.ref.span;
      const bomSpan = bom.document.root.members[0]?.ref.span;
      expect(plainSpan).not.toBeNull();
      expect(bomSpan).toEqual(plainSpan);
      if (!plainSpan) continue;
      assertPosition(plainSpan.start, item.text);
      assertPosition(plainSpan.end, item.text);
    }
  });

  it('keeps normalized identity deterministic for repeated input', () => {
    for (const item of workflowCases(0x1006, 16)) {
      const first = parseSourceDocument(encoder.encode(item.canonical), profileLimits());
      const second = parseSourceDocument(encoder.encode(item.canonical), profileLimits());
      expect(first.ok).toBe(true);
      expect(second.ok).toBe(true);
      if (!first.ok || !second.ok) continue;
      const normalizedFirst = normalizeSecurityWorkflow(first.document, profileLimits());
      const normalizedSecond = normalizeSecurityWorkflow(second.document, profileLimits());
      expect(normalizedFirst.ok).toBe(true);
      expect(normalizedSecond.ok).toBe(true);
      if (!normalizedFirst.ok || !normalizedSecond.ok) continue;
      expect(normalizedFirst.semanticSha256).toBe(normalizedSecond.semanticSha256);
      expect(normalizedFirst.ambiguitySha256).toBe(normalizedSecond.ambiguitySha256);
      expect(normalizedFirst.counters).toEqual(normalizedSecond.counters);
    }
  });
});
