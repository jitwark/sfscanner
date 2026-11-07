import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { auditScannerCore } from './check-scanner-core.mjs';

const packageJson = {
  name: '@hub/scanner-core',
  version: '0.1.0',
  type: 'module',
  dependencies: {
    '@hub/contracts': '0.1.0',
    '@lezer/python': '^1.1.19',
    '@humanwhocodes/momoa': '^3.3.10',
    '@noble/hashes': '^2.0.1',
    acorn: '^8.17.0',
  },
  exports: {
    './canonical-json': './src/canonical-json.ts',
    './workflow': './src/workflow.ts',
    './scanner-version': './src/scanner-version.ts',
    './redaction': './src/redaction/redaction.ts',
    './policy': './src/policy/policy.ts',
    './policy-helpers': './src/policy/policy-helpers.ts',
    './rule-catalog': './src/policy/rule-catalog.ts',
    './provider-token-patterns': './src/provider-token-patterns.ts',
    './analyzers/code/javascript-analysis': './src/analyzers/code/javascript-analysis.ts',
    './analyzers/code/python-analysis': './src/analyzers/code/python-analysis.ts',
    './analyzers/taint/taint-analysis': './src/analyzers/taint/taint-analysis.ts',
    './analyzers/taint/taint-lattice': './src/analyzers/taint/taint-lattice.ts',
    './analyzers/taint/taint-propagation': './src/analyzers/taint/taint-propagation.ts',
    './analyzers/taint/taint-sources': './src/analyzers/taint/taint-sources.ts',
    './analyzers/taint/taint-traces': './src/analyzers/taint/taint-traces.ts',
    './analyzers/ai/ai-capability-analysis': './src/analyzers/ai/ai-capability-analysis.ts',
    './graph-dominators': './src/graph-dominators.ts',
    './result/canonical-findings': './src/result/canonical-findings.ts',
    './result/analysis-completeness': './src/result/analysis-completeness.ts',
    './result/analysis-diagnostics-collection': './src/result/analysis-diagnostics-collection.ts',
    './result/summary': './src/result/summary.ts',
    './policies/profile': {
      types: './src/policies/profile.ts',
      import: './src/policies/profile.ts',
      default: './src/policies/profile.ts',
    },
    './engine': './src/engine/engine.ts',
  },
};

function fixtureRoot(source, exports = packageJson) {
  const root = mkdtempSync(join(tmpdir(), 'hub-scanner-core-'));
  const packageRoot = join(root, 'packages', 'scanner-core');
  mkdirSync(join(packageRoot, 'src'), { recursive: true });
  writeFileSync(join(packageRoot, 'package.json'), JSON.stringify(exports));
  writeFileSync(join(packageRoot, 'src', 'canonical-json.ts'), source);
  writeFileSync(join(packageRoot, 'src', 'workflow.ts'), 'export const workflow = true;');
  for (const target of Object.values(exports.exports ?? {})) {
    const targetPath = typeof target === 'string' ? target : target?.import;
    if (!targetPath?.startsWith('./src/') || targetPath.includes('*')) continue;
    const filePath = join(packageRoot, targetPath.slice(2));
    mkdirSync(join(filePath, '..'), { recursive: true });
    if (!existsSync(filePath)) writeFileSync(filePath, 'export const fixture = true;');
  }
  return root;
}

function withFixture(source, exports, callback) {
  const root = fixtureRoot(source, exports);
  try {
    callback(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe('scanner-core boundary checker', () => {
  it('accepts the repository package and direct canonical-json export', () => {
    expect(auditScannerCore(join(import.meta.dirname, '..')).errors).toEqual([]);
  });

  it('excludes canonical test-support modules without exempting test helpers', () => {
    withFixture('', packageJson, (root) => {
      const src = join(root, 'packages', 'scanner-core', 'src');
      writeFileSync(join(src, 'fixture.test-support.ts'), 'import { vi } from "vitest"; export const testApi = vi;\n');
      expect(auditScannerCore(root).errors).toEqual([]);
    });
    withFixture('', packageJson, (root) => {
      const src = join(root, 'packages', 'scanner-core', 'src');
      writeFileSync(join(src, 'fixture.test-helper.ts'), 'import { vi } from "vitest"; export const testApi = vi;\n');
      expect(auditScannerCore(root).errors).toEqual(expect.arrayContaining([
        expect.stringContaining('fixture.test-helper.ts: runtime import is not allowed: vitest'),
      ]));
    });
  });

  it('fails closed when the direct package export is missing or wildcarded', () => {
    withFixture('', { ...packageJson, exports: { './*': './src/*.ts' } }, (root) => {
      expect(auditScannerCore(root).errors).toEqual(expect.arrayContaining([
        'package exports must include an explicit ./canonical-json entry',
        'package exports must not contain wildcard keys',
      ]));
    });
  });

  it('requires the workflow export to point at the package-local implementation', () => {
    withFixture('', {
      ...packageJson,
      exports: { ...packageJson.exports, './workflow': './src/missing.ts' },
    }, (root) => {
      expect(auditScannerCore(root).errors).toEqual(expect.arrayContaining([
        './workflow must explicitly target ./src/workflow.ts',
      ]));
    });
  });

  it('accepts only explicitly declared scanner-core runtime imports', () => {
    withFixture(
      'import { parse } from "@humanwhocodes/momoa";\n'
      + 'import { sha256 } from "@noble/hashes/sha2.js";\n'
      + 'import { parser } from "@lezer/python";\n'
      + 'import { parse as parseJavaScript } from "acorn";\n'
      + 'export const value = parse && sha256 && parser && parseJavaScript;\n',
      packageJson,
      (root) => expect(auditScannerCore(root).errors).toEqual([]),
    );
  });

  it('accepts the browser-safe contracts runtime package', () => {
    withFixture(
      'import { DEFAULT_SCANNER_LIMITS_V2 } from "@hub/contracts";\n'
      + 'export const value = DEFAULT_SCANNER_LIMITS_V2;\n',
      packageJson,
      (root) => expect(auditScannerCore(root).errors).toEqual([]),
    );
  });

  it('ignores strings, regex literals, and uppercase constants as runtime references', () => {
    withFixture(
      "const PROCESS = 'pro' + 'cess';\n"
      + "const safety = /process\\.env|fetch\\s*\\(/i;\n"
      + "export const value = { PROCESS, safety, text: 'Buffer XMLHttpRequest' };\n",
      packageJson,
      (root) => expect(auditScannerCore(root).errors).toEqual([]),
    );
  });

  it('fails closed when an unterminated regex could hide runtime references', () => {
    withFixture(
      "const safety = /process\n"
      + "fetch('/audit');\n",
      packageJson,
      (root) => expect(auditScannerCore(root).errors).toEqual(expect.arrayContaining([
        expect.stringContaining('unterminated regex literal'),
        expect.stringContaining('prohibited runtime reference /\\bprocess\\b/'),
        expect.stringContaining('prohibited runtime reference /\\bfetch\\s*\\(/'),
      ])),
    );
  });

  it('reports an unterminated regex even without another prohibited reference', () => {
    withFixture(
      'const safety = /only a pattern\n',
      packageJson,
      (root) => expect(auditScannerCore(root).errors).toEqual(expect.arrayContaining([
        expect.stringContaining('unterminated regex literal'),
      ])),
    );
  });

  it('rejects real process, fetch, and Node imports', () => {
    withFixture(
      "import fs from 'node:fs';\n"
      + "import process from 'node:process';\n"
      + "export const value = process.env.TEST ?? fetch('/audit');\n",
      packageJson,
      (root) => expect(auditScannerCore(root).errors).toEqual(expect.arrayContaining([
        expect.stringContaining('prohibited import/specifier node:fs'),
        expect.stringContaining('prohibited import/specifier node:process'),
        expect.stringContaining('prohibited runtime reference /\\bprocess\\b/'),
        expect.stringContaining('prohibited runtime reference /\\bfetch\\s*\\(/'),
      ])),
    );
  });

  it('rejects undeclared or unrelated runtime dependencies and imports', () => {
    withFixture(
      'import thing from "not-allowed"; export const value = thing;\n',
      { ...packageJson, dependencies: { ...packageJson.dependencies, 'not-allowed': '^1.0.0' } },
      (root) => expect(auditScannerCore(root).errors).toEqual(expect.arrayContaining([
        'runtime dependency is not allowed in scanner-core: not-allowed',
        expect.stringContaining('runtime import is not allowed: not-allowed'),
      ])),
    );
  });

  it('rejects prohibited imports and runtime globals in source files', () => {
    withFixture('import fs from "node:fs"; export const value = process.env.TEST;\n', packageJson, (root) => {
      expect(auditScannerCore(root).errors).toEqual(expect.arrayContaining([
        expect.stringContaining('prohibited import/specifier'),
        expect.stringContaining('prohibited runtime reference'),
      ]));
    });
  });

  it('does not treat documentation strings or comments as runtime references', () => {
    withFixture(
      "export const documentation = 'Worker process fetch XMLHttpRequest'; // process\n",
      packageJson,
      (root) => expect(auditScannerCore(root).errors).toEqual([]),
    );
  });
});
