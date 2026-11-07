import { describe, expect, it } from 'vitest';
import { mapTooComplexReason, tryCountRawNodes } from './scan-worker-error-mapping';

describe('mapTooComplexReason', () => {
  it('maps the NODE_LIMIT cause to TOO_MANY_NODES', () => {
    expect(mapTooComplexReason('NODE_LIMIT')).toBe('TOO_MANY_NODES');
  });

  it('maps the EDGE_LIMIT cause to TOO_MANY_EDGES', () => {
    expect(mapTooComplexReason('EDGE_LIMIT')).toBe('TOO_MANY_EDGES');
  });

  it('maps the CONNECTION_DEPTH_LIMIT cause to CONNECTIONS_TOO_DEEP', () => {
    expect(mapTooComplexReason('CONNECTION_DEPTH_LIMIT')).toBe('CONNECTIONS_TOO_DEEP');
  });

  it('maps the PARAMETER_COMPLEXITY_LIMIT cause to PARAMETERS_TOO_COMPLEX', () => {
    expect(mapTooComplexReason('PARAMETER_COMPLEXITY_LIMIT')).toBe('PARAMETERS_TOO_COMPLEX');
  });

  it('maps the DOCUMENT_DEPTH_LIMIT cause to DOCUMENT_TOO_DEEP', () => {
    expect(mapTooComplexReason('DOCUMENT_DEPTH_LIMIT')).toBe('DOCUMENT_TOO_DEEP');
  });

  it('maps duplicate pointer output exhaustion to an explicit incomplete-scan reason', () => {
    expect(mapTooComplexReason('DUPLICATE_KEY_LOCATION_LIMIT')).toBe('DUPLICATE_LOCATIONS_TOO_COMPLEX');
  });

  it('throws rather than silently mapping an unrecognized cause to a specific reason', () => {
    // Guards against the exact audited bug reappearing under a new name: an
    // unmappable cause must never silently resolve to TOO_MANY_NODES (or any
    // other specific reason). `WorkflowTooComplexCause` is a closed union, so
    // this can only happen via a type-unsafe call (e.g. from JS, or a cast) —
    // exercised here by forcing an unknown value past the type checker.
    const unknownCause = 'SOME_FUTURE_LIMIT' as unknown as Parameters<typeof mapTooComplexReason>[0];
    expect(() => mapTooComplexReason(unknownCause)).toThrow(/unmapped too-complex cause/i);
  });
});

describe('tryCountRawNodes', () => {
  it('returns the raw node array length when present', () => {
    expect(tryCountRawNodes(JSON.stringify({ nodes: [1, 2, 3], connections: {} }))).toBe(3);
  });

  it('returns undefined for unparsable JSON rather than throwing', () => {
    expect(tryCountRawNodes('not json')).toBeUndefined();
  });

  it('returns undefined when nodes is missing', () => {
    expect(tryCountRawNodes(JSON.stringify({ connections: {} }))).toBeUndefined();
  });

  it('returns undefined when nodes is not an array', () => {
    expect(tryCountRawNodes(JSON.stringify({ nodes: 'oops' }))).toBeUndefined();
  });
});
