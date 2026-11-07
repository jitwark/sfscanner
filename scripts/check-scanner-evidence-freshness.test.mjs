import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { auditScannerEvidenceFreshness } from './check-scanner-evidence-freshness.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const valid = `# Fixture\n\n> Status: current\n> Last verified: 2026-09-10\n> Owner: Scanner maintainer\n> Source of truth: [workflow](../../packages/scanner-core/src/v2/scan-workflow.ts)\n`;

function fixture(body = valid) {
  const root = mkdtempSync(join(tmpdir(), 'scanner-freshness-'));
  mkdirSync(join(root, 'docs/scanner'), { recursive: true });
  mkdirSync(join(root, 'packages/scanner-core/src/v2'), { recursive: true });
  writeFileSync(join(root, 'packages/scanner-core/src/v2/scan-workflow.ts'), '// authority\n');
  writeFileSync(join(root, 'docs/scanner/architecture-v2.md'), body);
  return root;
}

describe('scanner evidence freshness gate', () => {
  it('accepts a fixed as-of date and deterministic in-window evidence', () => {
    const root = fixture();
    expect(auditScannerEvidenceFreshness(root, { asOf: '2026-09-11', maxAgeDays: 30, documents: ['docs/scanner/architecture-v2.md'], checkGenerated: false }).errors).toEqual([]);
    rmSync(root, { recursive: true, force: true });
  });

  it('rejects malformed, future, stale, and missing owner/source evidence with file and line', () => {
    const root = fixture(valid.replace('2026-09-10', 'not-a-date').replace('> Owner: Scanner maintainer', '> Owner:'));
    const errors = auditScannerEvidenceFreshness(root, { asOf: '2026-09-11', maxAgeDays: 3, documents: ['docs/scanner/architecture-v2.md'], checkGenerated: false }).errors;
    expect(errors.some((error) => /architecture-v2\.md:\d+:/i.test(error))).toBe(true);
    expect(errors.some((error) => /date|owner|source/i.test(error))).toBe(true);
    rmSync(root, { recursive: true, force: true });

    const futureRoot = fixture(valid.replace('2026-09-10', '2026-09-12'));
    expect(auditScannerEvidenceFreshness(futureRoot, { asOf: '2026-09-11', maxAgeDays: 30, documents: ['docs/scanner/architecture-v2.md'], checkGenerated: false }).errors.some((error) => /future/i.test(error))).toBe(true);
    rmSync(futureRoot, { recursive: true, force: true });

    const staleRoot = fixture(valid.replace('2026-09-10', '2026-01-01'));
    expect(auditScannerEvidenceFreshness(staleRoot, { asOf: '2026-09-11', maxAgeDays: 3, documents: ['docs/scanner/architecture-v2.md'], checkGenerated: false }).errors.some((error) => /stale/i.test(error))).toBe(true);
    rmSync(staleRoot, { recursive: true, force: true });
  });

  it('uses REFERENCE_DATE or SOURCE_DATE_EPOCH without consulting the current clock', () => {
    const root = fixture();
    const priorReference = process.env.REFERENCE_DATE;
    const priorEpoch = process.env.SOURCE_DATE_EPOCH;
    process.env.REFERENCE_DATE = '2026-09-11';
    delete process.env.SOURCE_DATE_EPOCH;
    expect(auditScannerEvidenceFreshness(root, { maxAgeDays: 30, documents: ['docs/scanner/architecture-v2.md'], checkGenerated: false }).errors).toEqual([]);
    delete process.env.REFERENCE_DATE;
    process.env.SOURCE_DATE_EPOCH = String(Date.UTC(2026, 8, 11) / 1000);
    expect(auditScannerEvidenceFreshness(root, { maxAgeDays: 30, documents: ['docs/scanner/architecture-v2.md'], checkGenerated: false }).errors).toEqual([]);
    if (priorReference === undefined) delete process.env.REFERENCE_DATE; else process.env.REFERENCE_DATE = priorReference;
    if (priorEpoch === undefined) delete process.env.SOURCE_DATE_EPOCH; else process.env.SOURCE_DATE_EPOCH = priorEpoch;
    rmSync(root, { recursive: true, force: true });
  });

  it('detects generated source digest or byte drift', () => {
    const generatedDir = join(ROOT, 'docs/scanner/generated');
    const generatedDocs = Object.fromEntries(['rules.md', 'diagnostics.md', 'limits.md', 'schemas.md', 'cli.md', 'examples.md'].map((name) => [name, readFileSync(join(generatedDir, name), 'utf8')]));
    generatedDocs['rules.md'] = generatedDocs['rules.md'].replace('scanner-reference:digest=', 'scanner-reference:digest=0000000000000000000000000000000000000000000000000000000000000000<!--');
    const errors = auditScannerEvidenceFreshness(ROOT, { asOf: '2026-09-11', maxAgeDays: 30, generatedDocs }).errors;
    expect(errors.some((error) => /generated|digest|drift/i.test(error))).toBe(true);
  });

  it('rejects placeholder evidence claims and stale recorded release evidence', () => {
    const root = fixture(`${valid}\n> Recorded: 2026-01-01\nTODO: replace evidence\n`);
    const errors = auditScannerEvidenceFreshness(root, { asOf: '2026-09-11', maxAgeDays: 3, documents: ['docs/scanner/architecture-v2.md'], checkGenerated: false }).errors;
    expect(errors.some((error) => /stale/i.test(error))).toBe(true);
    expect(errors.some((error) => /placeholder/i.test(error))).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });
});
