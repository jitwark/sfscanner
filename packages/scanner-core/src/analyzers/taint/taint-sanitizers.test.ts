import { describe, expect, it } from 'vitest';
import { TAINT_SINK_KINDS } from './taint-lattice';
import { resolveSanitizedSinks, resolveWrapperChainSanitization } from './taint-sanitizers';

describe('scanner-core taint sanitizers', () => {
  it('clears only headers for percent encoding', () => {
    expect([...resolveSanitizedSinks('encodeURIComponent')]).toEqual(['HEADER']);
    expect(resolveSanitizedSinks('encodeURIComponent').has('SSRF')).toBe(false);
    expect(resolveSanitizedSinks('encodeURIComponent').has('PATH')).toBe(false);
  });

  it('clears every sink for numeric coercion', () => {
    for (const callee of ['Number', 'parseInt', 'parseFloat']) {
      expect([...resolveSanitizedSinks(callee)]).toEqual([...TAINT_SINK_KINDS]);
    }
  });

  it('uses the outermost wrapper and recognizes no unknown wrapper', () => {
    expect([...resolveWrapperChainSanitization(['decodeURIComponent', 'encodeURIComponent'])]).toEqual([]);
    expect([...resolveWrapperChainSanitization(['Number', 'decodeURIComponent'])]).toEqual([...TAINT_SINK_KINDS]);
    expect([...resolveWrapperChainSanitization(['buildValue', 'encodeURIComponent'])]).toEqual([]);
  });
});
