import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readV2ScanReceipts } from './v2-scan-receipts.js';

const writes: string[] = [];
const sidecar = (lines: unknown[]) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v2-receipts-'));
  writes.push(dir);
  const file = path.join(dir, 'v2-scan-evidence.ndjson');
  fs.writeFileSync(file, lines.map((line) => JSON.stringify(line)).join('\n'));
  return file;
};
afterEach(() => { for (const dir of writes.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

const identity = { scannerVersion: '2.0.0', engineBuildDigest: 'a'.repeat(64), profileId: 'beta-default', profileVersion: '2.0.0', rulesetDigest: 'b'.repeat(64), semanticsDigest: 'c'.repeat(64), limitsDigest: 'd'.repeat(64) };
const base = { schemaVersion: 'v2-scan-evidence-v1', inventorySha256: 'e'.repeat(64), scanFreshness: 'CURRENT', rightsClass: 'link_only', retainedVerdict: null, receiptReasonCode: null };

describe('v2 receipt sidecar reader', () => {
  it('binds scan.entryId to the record and reads RESULT/REFUSED receipts', () => {
    const file = sidecar([
      { ...base, entryId: 'a'.repeat(16), scan: { entryId: 'a'.repeat(16), rightsClass: 'link_only', ok: true, identity, bodySha256: 'f'.repeat(64), resultDigest: '9'.repeat(64), analysisStatus: 'COMPLETE', assessment: { grade: 'LOW', score: 90 }, diagnosticCodes: [], findingIds: [], security: {}, refusalCode: null } },
      { ...base, entryId: 'b'.repeat(16), scanFreshness: 'NO_RESULT', scan: { entryId: 'b'.repeat(16), rightsClass: 'link_only', ok: false, identity, bodySha256: 'f'.repeat(64), resultDigest: null, analysisStatus: 'INDETERMINATE', assessment: null, diagnosticCodes: [], findingIds: [], security: {}, refusalCode: 'SEMANTIC_CATALOGUE_INVALID' } },
    ]);
    const receipts = readV2ScanReceipts(file).receiptsByWorkflowId;
    expect(receipts['a'.repeat(16)]?.outcome).toBe('RESULT');
    expect(receipts['b'.repeat(16)]?.outcome).toBe('REFUSED');
  });

  it('refuses a receipt whose scan.entryId belongs to another row', () => {
    const file = sidecar([{ ...base, entryId: 'b'.repeat(16), scan: { entryId: 'a'.repeat(16), rightsClass: 'link_only', ok: true, identity, bodySha256: 'f'.repeat(64), resultDigest: '9'.repeat(64), analysisStatus: 'COMPLETE', assessment: null, diagnosticCodes: [], findingIds: [], security: {}, refusalCode: null } }]);
    expect(() => readV2ScanReceipts(file)).toThrow(/bound to record/);
  });

  it('throws on a malformed refusal instead of downgrading it', () => {
    const file = sidecar([{ ...base, entryId: 'b'.repeat(16), scan: { entryId: 'b'.repeat(16), rightsClass: 'link_only', ok: false, identity, bodySha256: 'not-hex', resultDigest: null, analysisStatus: 'INDETERMINATE', assessment: null, diagnosticCodes: [], findingIds: [], security: {}, refusalCode: 'SEMANTIC_CATALOGUE_INVALID' } }]);
    expect(() => readV2ScanReceipts(file)).toThrow(/body digest/);
  });
});
