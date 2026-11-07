import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  applyContentExemptions,
  EXEMPTION_SCHEMA_VERSION,
  loadContentExemptions,
  validateContentExemptions,
} from './public-repo-exemptions.mjs';

function tempJson(content) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'public-repo-exemptions-')), 'exemptions.json');
  fs.writeFileSync(file, JSON.stringify(content));
  return file;
}

describe('public repository content exemptions', () => {
  it('loads the committed exemption file with no validation errors', () => {
    const { exemptions, errors } = loadContentExemptions();
    expect(errors).toEqual([]);
    expect(Array.isArray(exemptions)).toBe(true);
    for (const entry of exemptions) {
      expect(typeof entry.path).toBe('string');
      expect(typeof entry.rule).toBe('string');
      expect(typeof entry.reason).toBe('string');
      expect(typeof entry.evidence).toBe('string');
    }
  });

  it('rejects an exemption file with the wrong schema version', () => {
    const errors = validateContentExemptions({ schemaVersion: 'nope', exemptions: [] });
    expect(errors).toContainEqual(expect.stringContaining('schemaVersion'));
  });

  it('rejects a directory-level or wildcard exemption path', () => {
    const base = { path: 'a/b', rule: 'canary-string', reason: 'because this is a fixture used to test detection', evidence: 'line 3' };
    const errors = validateContentExemptions({
      schemaVersion: EXEMPTION_SCHEMA_VERSION,
      exemptions: [
        { ...base, path: 'a/b/' },
        { ...base, path: 'a/*' },
        { ...base, path: '.' },
      ],
    });
    expect(errors.length).toBeGreaterThanOrEqual(3);
  });

  it('rejects an exemption missing a reason or evidence, or with a duplicate (path, rule) pair', () => {
    const base = { path: 'x/y.json', rule: 'canary-string', reason: 'documented detector fixture used only to test redaction', evidence: 'field "value" at line 1' };
    const errors = validateContentExemptions({
      schemaVersion: EXEMPTION_SCHEMA_VERSION,
      exemptions: [
        { ...base, reason: '' },
        { ...base, evidence: '' },
        base,
        base,
      ],
    });
    expect(errors.some((message) => /reason/i.test(message))).toBe(true);
    expect(errors.some((message) => /evidence/i.test(message))).toBe(true);
    expect(errors.some((message) => /duplicate/i.test(message))).toBe(true);
  });

  it('loads a custom exemption file path and surfaces its validation errors instead of the default file', () => {
    const file = tempJson({ schemaVersion: EXEMPTION_SCHEMA_VERSION, exemptions: [{ path: 'a/*', rule: 'canary-string', reason: 'x'.repeat(20), evidence: 'y' }] });
    const { errors } = loadContentExemptions(file);
    expect(errors.length).toBeGreaterThan(0);
  });

  it('suppresses only findings that exactly match an exemption path and rule, never a whole directory', () => {
    const exemptions = [
      { path: 'fixtures/canary.json', rule: 'canary-string', reason: 'synthetic canary fixture used to test the content-safety detector', evidence: 'literal canary marker' },
    ];
    const findings = [
      { path: 'fixtures/canary.json', rule: 'canary-string', line: 1, column: 1 },
      { path: 'fixtures/canary.json', rule: 'secret-pattern:openai-api-key', line: 2, column: 1 },
      { path: 'fixtures/other.json', rule: 'canary-string', line: 1, column: 1 },
    ];

    const { remaining, suppressed } = applyContentExemptions(findings, exemptions);

    expect(suppressed).toEqual([findings[0]]);
    expect(remaining).toEqual([findings[1], findings[2]]);
  });

  it('reports an exemption entry as stale when nothing in the current findings matches it', () => {
    const exemptions = [
      { path: 'fixtures/canary.json', rule: 'canary-string', reason: 'synthetic canary fixture used to test the content-safety detector', evidence: 'literal canary marker' },
    ];
    const { stale } = applyContentExemptions([], exemptions);
    expect(stale).toEqual(exemptions);
  });
});
