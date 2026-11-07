import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { auditScannerSourceClaims } from './check-scanner-source-claims.mjs';

const ROOT = resolve(import.meta.dirname, '..');

function fixture({ body, name = 'architecture-v2.md', source = 'packages/scanner-core/src/v2/scan-workflow.ts' }) {
  const root = mkdtempSync(join(tmpdir(), 'scanner-claims-'));
  mkdirSync(join(root, 'docs/scanner'), { recursive: true });
  mkdirSync(join(root, 'packages/scanner-core/src/v2'), { recursive: true });
  writeFileSync(join(root, 'packages/scanner-core/src/v2/scan-workflow.ts'), '// authority\n');
  writeFileSync(join(root, 'docs/scanner', name), body.replace('SOURCE_PATH', source));
  return root;
}

const valid = `# Fixture\n\n> Status: current\n> Last verified: 2026-09-11\n> Owner: Scanner maintainer\n> Source of truth: [workflow](../../packages/scanner-core/src/v2/scan-workflow.ts)\n\nA truthful negative: HUMAN_REQUIRED; NOT READY FOR DEPLOYMENT.\n`;

describe('scanner source-claims gate', () => {
  it('accepts the committed authoritative scope and truthful nonclaims', () => {
    expect(auditScannerSourceClaims(ROOT).errors).toEqual([]);
  });

  it('reports missing metadata, dead links, and invalid source paths with file and line', () => {
    const root = fixture({ body: valid.replace('> Owner: Scanner maintainer', '> Owner:').replace('workflow](../../packages/scanner-core/src/v2/scan-workflow.ts)', 'dead](../../missing.ts)') });
    const errors = auditScannerSourceClaims(root, { documents: ['docs/scanner/architecture-v2.md'], checkGenerated: false }).errors;
    expect(errors.some((error) => /docs[\\/]scanner[\\/]architecture-v2\.md:\d+:/i.test(error))).toBe(true);
    expect(errors.some((error) => /owner|resolve/i.test(error))).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });

  it('rejects absolute, escaping, archive, and missing-anchor links', () => {
    const body = `${valid}[absolute](/etc/passwd) [escape](../../../outside.md) [archive](../../docs/archive/old.md) [anchor](../../packages/scanner-core/src/v2/scan-workflow.ts#missing)`;
    const root = fixture({ body });
    const errors = auditScannerSourceClaims(root, { documents: ['docs/scanner/architecture-v2.md'], checkGenerated: false }).errors;
    expect(errors.filter((error) => /absolute|travers|archive|anchor/i.test(error)).length).toBeGreaterThanOrEqual(4);
    rmSync(root, { recursive: true, force: true });
  });

  it('rejects placeholders, dummy hashes, secrets, and unauthorized gate success claims', () => {
    const body = `${valid}\nTODO: replace this.\nsha256: ${'0'.repeat(64)}\npassword: "leaked"\nCI passed and deployment complete.`;
    const root = fixture({ body });
    const errors = auditScannerSourceClaims(root, { documents: ['docs/scanner/architecture-v2.md'], checkGenerated: false }).errors;
    expect(errors.filter((error) => /placeholder|hash|secret|external gate|claim/i.test(error)).length).toBeGreaterThanOrEqual(4);
    rmSync(root, { recursive: true, force: true });
  });

  it('does not require v2 metadata from explicitly legacy evidence artifacts', () => {
    const root = fixture({ name: 'calibration-v2-results.md', body: '# Legacy evidence\n\n> Status: HUMAN_REQUIRED\n' });
    expect(auditScannerSourceClaims(root, { documents: [] , checkGenerated: false }).errors).toEqual([]);
    rmSync(root, { recursive: true, force: true });
  });
});
