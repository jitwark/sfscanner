import { describe, expect, it } from 'vitest';
import { CONTENT_SECURITY_POLICY } from './csp';

const directives: Record<string, string[]> = Object.fromEntries(
  CONTENT_SECURITY_POLICY.split(';').map((directive) => {
    const [name, ...values] = directive.trim().split(/\s+/);
    return [name as string, values];
  }),
);

/** Every directive's sources, flattened. */
const sources = Object.values(directives).flat();

describe('content security policy', () => {
  it('allows no remote script, style, frame, or connection source', () => {
    for (const source of sources) {
      expect(source).not.toMatch(/^https?:\/\//);
      expect(source).not.toMatch(/^\*/);
    }
  });

  it('refuses eval', () => {
    expect(CONTENT_SECURITY_POLICY).not.toContain('unsafe-eval');
  });

  it('omits frame-ancestors, which a meta-delivered policy silently drops', () => {
    expect('frame-ancestors' in directives).toBe(false);
  });

  it('keeps the directives the export actually relies on', () => {
    expect(directives['default-src']).toEqual(["'self'"]);
    expect(directives['connect-src']).toEqual(["'self'"]);
    expect(directives['worker-src']).toEqual(["'self'", 'blob:']);
    expect(directives['object-src']).toEqual(["'none'"]);
    expect(directives['base-uri']).toEqual(["'none'"]);
    expect(directives['form-action']).toEqual(["'none'"]);
  });
});
