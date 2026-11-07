import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  auditEmittedScannerWorker,
  findEmittedArtifactViolations,
  findForbiddenCheck,
  main,
} from './check-browser-safe.mjs';

describe('browser-safe source gate', () => {
  it('allows a bundled local dynamic import used for code splitting', () => {
    expect(findForbiddenCheck("import('./report/report-result')")).toBeNull();
    expect(findForbiddenCheck('import("../shared/module")')).toBeNull();
  });

  it.each([
    "import('next/dynamic')",
    'import(moduleName)',
    "import('https://example.test/remote.js')",
  ])('rejects non-local dynamic import %s', (line) => {
    expect(findForbiddenCheck(line)).toBe('non-local dynamic import() call (remote code loading)');
  });

  it('does not let an earlier string hide an executable dynamic import', () => {
    expect(findForbiddenCheck('const example = "import(local)"; import(moduleName);'))
      .toBe('non-local dynamic import() call (remote code loading)');
  });

  it('does not let an earlier string hide an executable Node import', () => {
    const line = `const example = "from 'node:fs'"; import thing from 'node:path';`;
    expect(findForbiddenCheck(line)).toBe('node: import or module reference');
  });

  it('keeps network primitives and explicit ignores fail-closed', () => {
    expect(findForbiddenCheck('fetch(url)')).toBe('fetch() call');
    expect(findForbiddenCheck('fetch(url) // browser-safe-ignore', { testOnly: true })).toBeNull();
    expect(findForbiddenCheck('fetch(url) // browser-safe-ignore', { testOnly: false }))
      .toBe('browser-safe-ignore directive outside test-only file');
  });
});

describe('emitted scanner worker gate', () => {
  it('resolves the worker chunk from the page/runtime and accepts safe emitted code', () => {
    const root = mkdtempSync(join(tmpdir(), 'hub-browser-safe-'));
    const chunks = join(root, '_next', 'static', 'chunks');
    const pageDir = join(chunks, 'app', 'scanner');
    try {
      mkdirSync(pageDir, { recursive: true });
      writeFileSync(join(pageDir, 'page-test.js'), 'new Worker(new URL(n.p+n.u(42),n.b));');
      writeFileSync(join(chunks, 'webpack-test.js'), 'd.u=e=>"static/chunks/"+e+"."+({42:"abc123"})[e]+".js";');
      writeFileSync(join(chunks, '42.abc123.js'), '(()=>{"use strict";const text="fetch(url)";return text.length})()');

      const result = auditEmittedScannerWorker(root, { minimumBytes: 0 });

      expect(result.workerFile).toBe(join(chunks, '42.abc123.js'));
      expect(result.violations).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  it('resolves and audits every unique emitted worker chunk', () => {
    const root = mkdtempSync(join(tmpdir(), 'hub-browser-safe-multi-worker-'));
    const chunks = join(root, '_next', 'static', 'chunks');
    const pageDir = join(chunks, 'app', 'scanner');
    try {
      mkdirSync(pageDir, { recursive: true });
      writeFileSync(
        join(pageDir, 'page-test.js'),
        'new Worker(new URL(n.p+n.u(42),n.b));new Worker(new URL(n.p+n.u(43),n.b));',
      );
      writeFileSync(join(chunks, 'webpack-test.js'), 'd.u=e=>"static/chunks/"+e+"."+({42:"abc123",43:"def456"})[e]+".js";');
      writeFileSync(join(chunks, '42.abc123.js'), '(()=>{"use strict";const text="fetch(url)";return text.length})()');
      writeFileSync(join(chunks, '43.def456.js'), 'fetch(url);');

      const result = auditEmittedScannerWorker(root, { minimumBytes: 0 });

      expect(result.chunkIds).toEqual(['42', '43']);
      expect(result.workerFiles).toEqual([
        join(chunks, '42.abc123.js'),
        join(chunks, '43.def456.js'),
      ]);
      expect(result.violations).toEqual([
        expect.objectContaining({
          artifact: join(chunks, '43.def456.js'),
          name: 'fetch API reference',
        }),
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('resolves and audits dependencies loaded by each worker bootstrap', () => {
    const root = mkdtempSync(join(tmpdir(), 'hub-browser-safe-worker-closure-'));
    const chunks = join(root, '_next', 'static', 'chunks');
    const pageDir = join(chunks, 'app', 'scanner');
    try {
      mkdirSync(pageDir, { recursive: true });
      writeFileSync(join(pageDir, 'page-test.js'), 'new Worker(new URL(n.p+n.u(42),n.b));');
      writeFileSync(join(chunks, 'webpack-test.js'), 'd.u=e=>"static/chunks/"+e+"."+({42:"root123"})[e]+".js";');
      writeFileSync(
        join(chunks, '42.root123.js'),
        'a.u=e=>"static/chunks/"+e+"."+({11:"safe123",12:"bad123"})[e]+".js";a.x=()=>Promise.all([11,12].map(a.e,a));',
      );
      writeFileSync(join(chunks, '11.safe123.js'), 'const safe = 1;');
      writeFileSync(join(chunks, '12.bad123.js'), 'fetch(url);');

      const result = auditEmittedScannerWorker(root, { minimumBytes: 0 });

      expect(result.workerFiles).toEqual([
        join(chunks, '42.root123.js'),
        join(chunks, '11.safe123.js'),
        join(chunks, '12.bad123.js'),
      ]);
      expect(result.violations).toEqual([
        expect.objectContaining({
          artifact: join(chunks, '12.bad123.js'),
          name: 'fetch API reference',
        }),
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each([
    ['fetch API reference', 'fetch(url)'],
    ['XMLHttpRequest API reference', 'new XMLHttpRequest()'],
    ['Node process global', 'process.env.NODE_ENV'],
    ['Node module import', 'import fs from "node:fs"'],
  ])('rejects %s in emitted code', (name, source) => {
    expect(findEmittedArtifactViolations(source, 'fixture.js')).toEqual([
      expect.objectContaining({ name }),
    ]);
  });

  it('does not treat forbidden API names inside bundled scanner strings as runtime use', () => {
    const source = 'const indicators = new Set(["fetch", "XMLHttpRequest", "node:fs"]);';

    expect(findEmittedArtifactViolations(source, 'fixture.js')).toEqual([]);
  });

  it('ignores a method named process but detects the emitted global-process shim', () => {
    expect(findEmittedArtifactViolations('this.process(input);', 'fixture.js')).toEqual([]);
    expect(findEmittedArtifactViolations('class Hash { process(input) {} }', 'fixture.js')).toEqual([]);
    expect(findEmittedArtifactViolations('module.g.process.env;', 'fixture.js')).toEqual([
      expect.objectContaining({ name: 'Node process global' }),
    ]);
  });

  it('allows only the reviewed parser-tracing process fallback wrapper', () => {
    const wrapper = 'var i,s;t.exports=(null==(i=u.g.process)?void 0:i.env)&&"object"==typeof(null==(s=u.g.process)?void 0:s.env)?u.g.process:u(5116)';

    expect(findEmittedArtifactViolations(wrapper, 'fixture.js')).toEqual([]);
    expect(findEmittedArtifactViolations(`${wrapper};globalThis.process.env`, 'fixture.js'))
      .toEqual([expect.objectContaining({ name: 'Node process global' })]);
    expect(findEmittedArtifactViolations(`${wrapper};u.g.process.exit(1)`, 'fixture.js'))
      .toEqual([expect.objectContaining({ name: 'Node process global' })]);
  });

  it('detects explicit globalThis.process access without treating ordinary properties as globals', () => {
    expect(findEmittedArtifactViolations('globalThis.process.env;', 'fixture.js')).toEqual([
      expect.objectContaining({ name: 'Node process global' }),
    ]);
    expect(findEmittedArtifactViolations('module.process(input);', 'fixture.js')).toEqual([]);
  });

  it('detects forbidden code inside a template substitution but ignores template text', () => {
    expect(findEmittedArtifactViolations('const message = `fetch(url) ${fetch(url)}`;', 'template.js'))
      .toEqual([expect.objectContaining({ name: 'fetch API reference' })]);
  });

  it('keeps source mode source-only when an emitted output directory exists', () => {
    const root = mkdtempSync(join(tmpdir(), 'hub-browser-safe-source-only-'));
    try {
      const pageDir = join(root, '_next', 'static', 'chunks', 'app', 'scanner');
      const chunksDir = join(root, '_next', 'static', 'chunks');
      mkdirSync(pageDir, { recursive: true });
      writeFileSync(join(pageDir, 'page-test.js'), 'new Worker(new URL(n.p+n.u(42),n.b));');
      writeFileSync(join(chunksDir, 'webpack-test.js'), 'd.u=e=>"static/chunks/"+e+"."+({42:"abc123"})[e]+".js";');
      writeFileSync(join(chunksDir, '42.abc123.js'), 'fetch(url);');

      expect(main([], { sourceDirs: [], sourceFiles: [], outputDir: root })).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('retains emitted auditing behind the explicit --emitted mode', () => {
    const root = mkdtempSync(join(tmpdir(), 'hub-browser-safe-emitted-'));
    try {
      const pageDir = join(root, '_next', 'static', 'chunks', 'app', 'scanner');
      const chunksDir = join(root, '_next', 'static', 'chunks');
      mkdirSync(pageDir, { recursive: true });
      writeFileSync(join(pageDir, 'page-test.js'), 'new Worker(new URL(n.p+n.u(42),n.b));');
      writeFileSync(join(chunksDir, 'webpack-test.js'), 'd.u=e=>"static/chunks/"+e+"."+({42:"abc123"})[e]+".js";');
      writeFileSync(join(chunksDir, '42.abc123.js'), 'fetch(url);');

      expect(main(['--emitted'], {
        sourceDirs: [], sourceFiles: [], outputDir: root, minimumWorkerBytes: 0,
      })).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
