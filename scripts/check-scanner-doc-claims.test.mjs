import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { auditScannerDocClaims, scanExampleErrors } from './check-scanner-doc-claims.mjs';

const roots = [];
function sandbox(files) {
  const root = mkdtempSync(join(tmpdir(), 'scanner-doc-claims-'));
  roots.push(root);
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(dirname(resolve(root, file)), { recursive: true });
    writeFileSync(resolve(root, file), content, 'utf8');
  }
  return root;
}
function errorsFor(content) {
  const root = sandbox({ 'doc.md': content });
  return auditScannerDocClaims(root, { documents: ['doc.md'] }).errors;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const NEGATED = [
  '# sfscanner',
  '',
  '`sfscanner` is ESM-only. `require(\'sfscanner\')` is not supported: no CommonJS artifact is shipped.',
  '',
  '`beta-hardened` defines the advisory analyzers but is not admitted or selectable, so they do not run.',
  '',
  'Both client examples start `node` with `<npm-root>/sfscanner/dist/mcp.js`, where `<npm-root>` is',
  'the global module directory printed by `npm root -g`.',
].join('\n');

describe('scanner doc claims', () => {
  it('accepts negated CJS/hardened claims and a portable installed MCP path', () => {
    expect(errorsFor(NEGATED)).toEqual([]);
  });

  it('rejects affirmative support, default, and profile claims', () => {
    const errors = errorsFor([
      'Set the threshold (Default: `HIGH`).',
      'CJS is supported for library consumers.',
      "require('sfscanner') works in CommonJS.",
      '`beta-hardened` adds taint analysis and runs the advisory analyzers.',
    ].join('\n'));
    expect(errors).toEqual(expect.arrayContaining([
      'doc.md:1: default fail-on is INFO',
      'doc.md:2: the package ships no CommonJS surface',
      'doc.md:3: require() is unsupported; the package is ESM-only',
      'doc.md:4: unadmitted profile capability is promised',
    ]));
  });

  it('rejects private locations and working-directory-relative MCP configuration', () => {
    const errors = errorsFor([
      'Checkout: d:/projects/n8n-community/community-hub',
      'Clone https://github.com/jitwark/n8n-community.git',
      'Args: "/absolute/path/to/dist/mcp.js"',
      'Args: "./node_modules/sfscanner/dist/mcp.js"',
    ].join('\n'));
    expect(errors).toEqual(expect.arrayContaining([
      'doc.md:1: private absolute local path',
      'doc.md:2: private clone URL',
      'doc.md:3: absolute example path instead of an install path',
      'doc.md:4: MCP example is working-directory relative; use the installed module path',
    ]));
  });

  it('requires a directory scan example to select the v2 grammar', () => {
    expect(scanExampleErrors('doc.md', 'sfscanner scan .n8n --format sarif > out.sarif')).toEqual([
      'doc.md:1: directory scan example needs --schema v2',
    ]);
    expect(scanExampleErrors('doc.md', 'sfscanner --schema v2 scan .n8n --format sarif > out.sarif')).toEqual([]);
    expect(scanExampleErrors('doc.md', 'sfscanner scan workflow.json --format sarif > out.sarif')).toEqual([]);
    expect(scanExampleErrors('doc.md', 'npm run scan:cli -- scan workflows --format=sarif --output=scan.sarif')).toEqual([]);
  });

  it('requires the module-support negation and INFO default in the package README', () => {
    const root = sandbox({
      'packages/scanner-cli/README.md': 'The package is ESM-only. Set the threshold (Default: `INFO`).\n',
    });
    const { errors } = auditScannerDocClaims(root, { documents: ['packages/scanner-cli/README.md'] });
    expect(errors).toEqual(expect.arrayContaining([
      'packages/scanner-cli/README.md:1: unsupported require() is not stated',
      'packages/scanner-cli/README.md:1: shipped CommonJS absence is not stated',
      'packages/scanner-cli/README.md:1: MCP example is not the installed module path',
      'packages/scanner-cli/README.md:1: <npm-root> is not defined',
    ]));
  });
});
