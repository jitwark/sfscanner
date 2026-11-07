import { describe, expect, it } from 'vitest';
import { DEFAULT_SCANNER_LIMITS_V2 } from '@hub/contracts';
import { BETA_DEFAULT_PROFILE_MANIFEST } from '../capabilities/profile-manifest';
import { spanLossIsSecurityRequired } from './span-loss-classification';
import { scanWorkflowV2, type ScanWorkflowV2Success } from './index';

/**
 * The admission ceiling, the stored-span boundary and the byte envelope, read from the engine's own
 * result at the public `scanWorkflowV2` boundary. The process-isolated timing/throughput companion is
 * `scripts/measure-workflow-capacity.mjs`; it is an evidence script and is not run by this test.
 *
 * Boundary arithmetic for this fixture (four members per node — `id`, `name`, `type`,
 * `typeVersion` — and one connection record per non-tail node): the parser charges 12 spans per
 * node minus 4 for the chain, so `maxStoredSourceSpans = 25,000` holds 2,083 nodes (24,992 spans)
 * and the next node crosses it (25,004). A five-member node (an explicit `parameters: {}`) charges
 * 13 spans per node and moves the boundary to 1,923/1,924; the boundary is a property of the
 * document shape, not an intrinsic node cap.
 *
 * The byte cases pin the ordering the admission path depends on: an oversized payload is refused on
 * `byteLength` before the engine enumerates own properties or copies bytes. An own accessor property
 * is unrepresentable in an admitted request, so on a payload inside the bound the same property is
 * refused as `INVALID_CONFIG`; an oversized payload that carries it is refused as
 * `WORKFLOW_TOO_LARGE` instead, which is only reachable when the bound is applied first.
 */
const encoder = new TextEncoder();
const profile = { id: 'beta-default', version: '2.0.0' } as const;
const LAST_COMPLETE = 2_083;
const FIRST_DEGRADED = 2_084;

const chain = (count: number): Uint8Array => encoder.encode(JSON.stringify({
  nodes: Array.from({ length: count }, (_, index) => ({
    id: `n${index}`, name: `N${index}`, type: 'n8n-nodes-base.noOp', typeVersion: 1,
  })),
  connections: Object.fromEntries(Array.from({ length: Math.max(0, count - 1) }, (_, index) => [
    `N${index}`, { main: [[{ node: `N${index + 1}`, type: 'main', index: 0 }]] },
  ])),
}));

describe('5,000-node capacity', () => {
  const scan = (count: number) => {
    const result = scanWorkflowV2({ bytes: chain(count), profile });
    if (!result.ok) throw new Error(`${count} did not scan: ${result.code}`);
    return result.result;
  };
  const spanRow = (result: ScanWorkflowV2Success['result']) =>
    result.limits.usage.find(({ id }) => id === 'maxStoredSourceSpans');

  it('admits 5,000 nodes with the recorded span omission and rejects 5,001 at the node limit', () => {
    const admitted = scan(5_000);
    expect(admitted.analysis.status).toBe('DEGRADED');
    expect(admitted.limits.usage.find(({ id }) => id === 'maxStoredSourceSpans')).toEqual({
      id: 'maxStoredSourceSpans',
      maximum: DEFAULT_SCANNER_LIMITS_V2.maxStoredSourceSpans,
      examined: 59_996,
      omitted: 34_996,
      exhausted: true,
    });
    expect(admitted.analysis.diagnostics.map(({ code }) => code)).toContain('OPTIONAL_LIMIT_EXCEEDED');
    const rejected = scanWorkflowV2({ bytes: chain(5_001), profile });
    expect(rejected).toMatchObject({ ok: false, code: 'WORKFLOW_TOO_COMPLEX', cause: 'NODE_LIMIT' });
    expect(DEFAULT_SCANNER_LIMITS_V2.maxNodes).toBe(5_000);
  }, 120_000);

  it('classifies stored-span loss at the complete boundary as presentation-only', () => {
    const complete = scan(LAST_COMPLETE);
    expect(complete.analysis.status).toBe('COMPLETE');
    expect(spanRow(complete)).toEqual({
      id: 'maxStoredSourceSpans',
      maximum: DEFAULT_SCANNER_LIMITS_V2.maxStoredSourceSpans,
      examined: 24_992,
      omitted: 0,
      exhausted: false,
    });
    const degraded = scan(FIRST_DEGRADED);
    expect(degraded.analysis.status).toBe('DEGRADED');
    expect(spanRow(degraded)).toEqual({
      id: 'maxStoredSourceSpans',
      maximum: DEFAULT_SCANNER_LIMITS_V2.maxStoredSourceSpans,
      examined: 25_004,
      omitted: 4,
      exhausted: true,
    });
    expect(spanLossIsSecurityRequired(BETA_DEFAULT_PROFILE_MANIFEST)).toBe(false);
    expect(degraded.analysis.diagnostics.map(({ code }) => code)).toContain('OPTIONAL_LIMIT_EXCEEDED');
    expect(degraded.assessment).not.toBeNull();
  }, 120_000);
});

/** An own accessor property no admitted `Uint8Array` can legitimately carry. */
const withHostileOwnProperty = (bytes: Uint8Array): Uint8Array =>
  Object.defineProperty(bytes, 'hostileOwn', { get: () => 1, enumerable: true, configurable: true });

describe('byte envelope at the public boundary', () => {
  const minimal = encoder.encode('{"nodes":[],"connections":{}}');
  const scanBytes = (bytes: Uint8Array, maxBytes: number) =>
    scanWorkflowV2({ bytes, profile, limits: { maxBytes } });

  it('admits the exact byte length and refuses one byte under it', () => {
    const admitted = scanBytes(minimal, minimal.byteLength);
    if (!admitted.ok) throw new Error(`exact-length payload did not scan: ${admitted.code}`);
    expect(admitted.result.analysis.status).toBe('COMPLETE');
    expect(scanBytes(minimal, minimal.byteLength - 1)).toMatchObject({
      ok: false,
      code: 'WORKFLOW_TOO_LARGE',
      cause: 'PAYLOAD_BYTE_LIMIT',
    });
  });

  it('refuses an oversized payload before enumerating or copying its own properties', () => {
    const oversized = withHostileOwnProperty(new Uint8Array(1_024 * 1_024));
    expect(scanBytes(oversized, 16)).toMatchObject({
      ok: false,
      code: 'WORKFLOW_TOO_LARGE',
      cause: 'PAYLOAD_BYTE_LIMIT',
    });
    expect(scanBytes(withHostileOwnProperty(minimal.slice()), minimal.byteLength)).toMatchObject({
      ok: false,
      code: 'INVALID_CONFIG',
    });
  });
});
