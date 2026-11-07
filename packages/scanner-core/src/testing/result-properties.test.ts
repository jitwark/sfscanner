import { describe, expect, it } from 'vitest';
import { canonicalizeJson } from '../canonical-json';
import { canonicalBytesV1 } from '../result-v2/canonical-bytes';
import { scanWorkflowV2 } from '../v2';
import { redactEvidence, redactWorkflowJson } from '../redaction/redaction';
import {
  canonicalValueCases,
  redactionCases,
  workflowCases,
} from './property-generators';

const encoder = new TextEncoder();
const profile = { id: 'beta-default', version: '2.0.0' } as const;

function bytesAsNumbers(value: Uint8Array): number[] {
  return Array.from(value);
}

describe('scanner-core deterministic result properties', () => {
  it('makes canonical JSON idempotent and preserves array order', () => {
    for (const item of canonicalValueCases(0x2001, 32)) {
      const canonical = canonicalizeJson(item.value);
      expect(canonicalizeJson(item.permuted)).toBe(canonical);
      expect(canonicalizeJson(JSON.parse(canonical))).toBe(canonical);
      expect(canonicalizeJson(item.arrayPermuted)).not.toBe(canonical);
      expect(bytesAsNumbers(canonicalBytesV1(item.value))).toEqual(
        bytesAsNumbers(canonicalBytesV1(item.permuted)),
      );
      expect(bytesAsNumbers(canonicalBytesV1(item.value))).toEqual(
        bytesAsNumbers(new TextEncoder().encode(canonical)),
      );
    }
  });

  it('keeps scanner results deterministic for repeated generated workflows', () => {
    for (const item of workflowCases(0x2002, 12)) {
      const input = { bytes: encoder.encode(item.canonical), profile };
      const first = scanWorkflowV2(input);
      const second = scanWorkflowV2(input);
      expect(first.ok).toBe(second.ok);
      if (!first.ok || !second.ok) {
        if (!first.ok && !second.ok) expect(first.code).toBe(second.code);
        continue;
      }
      expect(bytesAsNumbers(canonicalBytesV1(first.result))).toEqual(
        bytesAsNumbers(canonicalBytesV1(second.result)),
      );
    }
  });

  it('makes evidence and workflow redaction idempotent without mutating inputs', () => {
    for (const item of redactionCases(0x2003, 24)) {
      const before = canonicalizeJson(item.value);
      const once = redactEvidence(item.value);
      const twice = redactEvidence(once);
      expect(twice).toEqual(once);
      expect(canonicalizeJson(item.value)).toBe(before);
      const redactedJson = redactWorkflowJson(JSON.stringify(item.value));
      expect(redactWorkflowJson(redactedJson)).toBe(redactedJson);
      expect(redactedJson).toContain('[REDACTED]');
    }
  });
});
