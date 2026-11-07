import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { GENERATED_DOCS, loadScannerReferenceSources, renderScannerReference } from './lib/scanner-reference-generators.mjs';
import { auditScannerV2Docs } from './check-scanner-v2-docs.mjs';

const ROOT = resolve(import.meta.dirname, '..');

function committedDocs() {
  return Object.fromEntries(GENERATED_DOCS.map((name) => [name, readFileSync(resolve(ROOT, 'docs/scanner/generated', name), 'utf8')]));
}

describe('generated scanner v2 docs gate', () => {
  it('accepts the committed six-file output when it matches regeneration', () => {
    const result = auditScannerV2Docs(ROOT);
    expect(result.errors).toEqual([]);
    expect(Object.keys(result.docs)).toEqual(GENERATED_DOCS);
  });

  it('detects byte drift and malformed generated metadata', () => {
    const model = loadScannerReferenceSources(ROOT);
    const generated = renderScannerReference(model);
    const docs = { ...generated, 'rules.md': generated['rules.md'].replace('## Rules', '## Drift') };
    const result = auditScannerV2Docs(ROOT, { docs });
    expect(result.errors.some((error) => /drift|regenerat/i.test(error))).toBe(true);

    const malformed = { ...generated, 'limits.md': generated['limits.md'].replace('DO NOT EDIT', 'EDIT') };
    expect(auditScannerV2Docs(ROOT, { docs: malformed }).errors.some((error) => /header/i.test(error))).toBe(true);
  });

  it('rejects missing files, source links, and CRLF output', () => {
    const generated = renderScannerReference(loadScannerReferenceSources(ROOT));
    const docs = { ...generated };
    delete docs['examples.md'];
    docs['schemas.md'] = `${docs['schemas.md'].replaceAll('\n', '\r\n')}\r\n`;
    docs['cli.md'] = docs['cli.md'].replace('../../../packages/scanner-cli/src/v2/help.ts', '../../../does-not-exist.ts');
    const result = auditScannerV2Docs(ROOT, { docs });
    expect(result.errors.some((error) => /missing/i.test(error))).toBe(true);
    expect(result.errors.some((error) => /LF|line ending/i.test(error))).toBe(true);
    expect(result.errors.some((error) => /link|path/i.test(error))).toBe(true);
  });

  it('rejects absolute generated links and secret-like values', () => {
    const generated = renderScannerReference(loadScannerReferenceSources(ROOT));
    const docs = { ...generated, 'cli.md': generated['cli.md'].replace('../../../packages/scanner-cli/src/v2/help.ts', '/private/secret.ts') };
    docs['examples.md'] = docs['examples.md'].replace('Examples are local synthetic fixtures', 'password: "leaked"\\n\\nExamples are local synthetic fixtures');
    const errors = auditScannerV2Docs(ROOT, { docs }).errors;
    expect(errors.some((error) => /absolute path/i.test(error))).toBe(true);
    expect(errors.some((error) => /secret-like/i.test(error))).toBe(true);
  });

  it('exposes the committed files as a complete deterministic set', () => {
    expect(Object.keys(committedDocs())).toEqual(GENERATED_DOCS);
  });
});
