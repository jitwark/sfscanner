import { describe, expect, it } from 'vitest';
import { escapeJsonPointerSegment, toJsonPointer } from './json-pointer';

describe('scanner-core JSON pointers', () => {
  it('escapes slash and tilde segments in RFC 6901 order', () => {
    expect(escapeJsonPointerSegment('a/b~c')).toBe('a~1b~0c');
    expect(toJsonPointer(['nodes', 0, 'parameters', 'a/b~c']))
      .toBe('/nodes/0/parameters/a~1b~0c');
  });
});
