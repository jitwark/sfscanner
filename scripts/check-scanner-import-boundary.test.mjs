import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { findScannerImportViolations } from './check-scanner-import-boundary.mjs';

function fixtureRoot(files) {
  const root = mkdtempSync(join(tmpdir(), 'scanner-import-boundary-'));
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

describe('scanner import boundary checker', () => {
  // Fixture roots are synthetic, so `app/src/workflow/**` paths appear here even though packet
  // 5.2c deleted that layer: the rule under test is "a scanner consumer resolves parsing and
  // workflow types through @hub/scanner-core", and it must keep firing if the layer returns.
  it('reports legacy pipeline imports with file, line, specifier, and migration guidance', () => {
    withFixture({
      'pipeline/scan/legacy-consumer.ts': [
        "import { scanWorkflow } from '../../app/src/scanner/engine.js';",
        "import { parseWorkflowJson } from '../../app/src/workflow/workflow.js';",
      ].join('\n'),
    }, (root) => {
      expect(findScannerImportViolations(root)).toEqual([
        expect.objectContaining({
          file: 'pipeline/scan/legacy-consumer.ts',
          line: 1,
          specifier: '../../app/src/scanner/engine.js',
          message: expect.stringContaining('@hub/scanner-core'),
        }),
        expect.objectContaining({
          file: 'pipeline/scan/legacy-consumer.ts',
          line: 2,
          specifier: '../../app/src/workflow/workflow.js',
          message: expect.stringContaining('@hub/scanner-core/workflow'),
        }),
      ]);
    });
  });

  it('reports app scanner imports of the legacy app workflow layer', () => {
    withFixture({
      'app/src/scanner/taint-consumer.ts': "import type { NormalizedWorkflow } from '@/src/workflow/workflow';\n",
      'app/src/scanner/core-consumer.ts': "import { parseWorkflowJson } from '@hub/scanner-core/workflow';\n",
    }, (root) => {
      expect(findScannerImportViolations(root)).toEqual([
        expect.objectContaining({
          file: 'app/src/scanner/taint-consumer.ts',
          line: 1,
          specifier: '@/src/workflow/workflow',
          message: expect.stringContaining('@hub/scanner-core/workflow'),
        }),
      ]);
    });
  });

  it('ignores tests, fixtures, shared-core imports, and legitimate local scanner UI imports', () => {
    withFixture({
      'app/src/scanner/consumer.test.ts': "import { parseWorkflowJson } from '@/src/workflow/workflow';\n",
      'app/src/scanner/__fixtures__/fixture.ts': "import { parseWorkflowJson } from '@/src/workflow/workflow';\n",
      'pipeline/cli/__fixtures__/fixture.mjs': "import '../../app/src/scanner/engine.js';\n",
      'app/src/scanner/report/report.tsx': "import type { ScanWorkflowResult } from '../engine';\n",
      'pipeline/scan/core-consumer.ts': "import { parseWorkflowJson } from '@hub/scanner-core/workflow';\n",
    }, (root) => expect(findScannerImportViolations(root)).toEqual([]));
  });
});
