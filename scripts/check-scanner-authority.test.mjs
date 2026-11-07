import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  AUTHORITY_DECLARATIONS,
  findAuthorityViolations,
  formatAuthorityViolation,
} from './check-scanner-authority.mjs';

function fixtureRoot(files) {
  const root = mkdtempSync(join(tmpdir(), 'scanner-authority-'));
  for (const [relativePath, source] of Object.entries(files)) {
    const filePath = join(root, relativePath);
    mkdirSync(join(filePath, '..'), { recursive: true });
    writeFileSync(filePath, source, 'utf8');
  }
  return root;
}

function withFixture(files, callback) {
  const root = fixtureRoot(files);
  try {
    callback(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function declaration(responsibility) {
  return AUTHORITY_DECLARATIONS.find((entry) => entry.responsibility === responsibility);
}

describe('scanner authority check', () => {
  it('finds no second authority in this repository', () => {
    const root = resolve(fileURLToPath(new URL('..', import.meta.url)));

    expect(findAuthorityViolations(root)).toEqual([]);
  });

  it('fails when a second file declares an authority the api-only surface hides', () => {
    const ruleVocabulary = declaration('rule vocabulary');
    withFixture({
      [ruleVocabulary.authority]: `export const ${ruleVocabulary.signature.split(' ').at(-1)} = [];\n`,
      'app/src/scanner/rule-catalog.ts': 'export const betaDefaultRuleCatalog = [];\n',
    }, (root) => {
      const violations = findAuthorityViolations(root, [ruleVocabulary]);

      expect(violations).toHaveLength(1);
      expect(violations[0]).toMatchObject({
        kind: 'DUPLICATE_AUTHORITY',
        responsibility: 'rule vocabulary',
        declaredBy: ['app/src/scanner/rule-catalog.ts', ruleVocabulary.authority].sort(),
      });
      expect(formatAuthorityViolation(violations[0])).toContain(ruleVocabulary.authority);
    });
  });

  it('fails when the authority is deleted, so a rename cannot silence the check', () => {
    const redaction = declaration('redaction');
    withFixture({
      'app/src/scanner/redaction.ts': 'function redactEvidence(value) { return value; }\n',
    }, (root) => {
      const violations = findAuthorityViolations(root, [redaction]);

      expect(violations).toEqual([
        expect.objectContaining({ kind: 'MISSING_AUTHORITY', signature: redaction.signature, authority: redaction.authority }),
      ]);
      expect(formatAuthorityViolation(violations[0])).toContain('no reviewed production file declares');
    });
  });

  it('accepts an adapter that imports, re-exports, or casts an authority', () => {
    const redactionDeclarations = AUTHORITY_DECLARATIONS.filter((entry) => entry.responsibility === 'redaction');
    withFixture({
      'packages/scanner-core/src/redaction/redaction.ts': [
        'export function redactText(value: string): string { return value; }',
        'export function redactEvidence<T>(value: T): T { return value; }',
        'export function redactWorkflowJson(raw: string): string { return raw; }',
        'export function redactFinding(finding: unknown): unknown { return finding; }',
      ].join('\n'),
      'app/src/scanner/redaction.ts': [
        "import { redactEvidence as redactCoreEvidence } from '@hub/scanner-core/redaction';",
        'export { redactText, redactEvidence } from "@hub/scanner-core/redaction";',
        'export const redact = (value: unknown) => redactCoreEvidence(value as never);',
        '// export function redactText and export function redactEvidence live in scanner-core, not here',
      ].join('\n'),
    }, (root) => expect(findAuthorityViolations(root, redactionDeclarations)).toEqual([]));
  });

  it('ignores tests and fixtures, which may restate a vector rather than a responsibility', () => {
    const completeness = declaration('completeness classification');
    withFixture({
      [completeness.authority]: 'export const ANALYSIS_DIAGNOSTIC_COMPLETENESS = {};\n',
      'app/src/scanner/analysis-completeness.test.ts': 'const ANALYSIS_DIAGNOSTIC_COMPLETENESS = {};\n',
      'pipeline/scan/__fixtures__/copy.ts': 'export const ANALYSIS_DIAGNOSTIC_COMPLETENESS = {};\n',
    }, (root) => expect(findAuthorityViolations(root, [completeness])).toEqual([]));
  });
});
