import { describe, expect, it } from 'vitest';
import { parseWorkflowJson } from '@hub/scanner-core/workflow';
import {
  MAX_JAVASCRIPT_SOURCE_BYTES,
  analyzeWorkflowJavaScript,
} from '@hub/scanner-core/analyzers/code/javascript-analysis';

function analyzeNodes(nodes: unknown[]) {
  const parsed = parseWorkflowJson(JSON.stringify({ nodes, connections: {} }));
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) throw new Error(parsed.message);
  return analyzeWorkflowJavaScript(parsed.workflow);
}

function analyzeCode(code: string) {
  return analyzeNodes([
    { id: 'code-1', name: 'Custom logic', type: 'n8n-nodes-base.code', typeVersion: 2, parameters: { jsCode: code } },
  ]);
}

describe('analyzeWorkflowJavaScript', () => {
  it('reports executable dynamic evaluation without returning source text', () => {
    const source = 'const result = eval(input); return result;';
    const result = analyzeCode(source);

    expect(result.findings).toEqual([expect.objectContaining({
      policyId: 'JAVASCRIPT_DYNAMIC_EXECUTION',
      evidence: { indicator: 'EVAL', start: expect.any(Number), end: expect.any(Number) },
    })]);
    expect(JSON.stringify(result)).not.toContain(source);
  });

  it('does not treat comments or string literals as executable escape syntax', () => {
    const result = analyzeCode('// eval(input)\nconst label = "new Function and child_process"; return label;');

    expect(result.findings).toEqual([]);
    expect(result.diagnostics).toEqual([]);
  });

  it('reports a safe parser diagnostic for malformed JavaScript', () => {
    const source = 'const = ; secret-value';
    const result = analyzeCode(source);

    expect(result.findings).toEqual([]);
    expect(result.diagnostics).toEqual([{ code: 'JAVASCRIPT_PARSE_FAILED', category: 'PARSER', location: { path: '/nodes/0' } }]);
    expect(JSON.stringify(result)).not.toContain(source);
  });

  it('stops before parsing a source field above the byte budget', () => {
    const result = analyzeCode('x'.repeat(MAX_JAVASCRIPT_SOURCE_BYTES + 1));

    expect(result.findings).toEqual([]);
    expect(result.diagnostics).toEqual([{ code: 'ANALYSIS_LIMIT_EXCEEDED', category: 'LIMIT', location: { path: '/nodes/0' } }]);
  });

  it('recognizes Function construction and child_process imports from AST calls', () => {
    const result = analyzeCode('new Function("return 1"); require("child_process");'); // browser-safe-ignore

    expect(result.findings.map((finding) => finding.evidence.indicator)).toEqual([
      'FUNCTION_CONSTRUCTOR',
      'CHILD_PROCESS_REQUIRE',
    ]);
  });

  it('stops AST traversal at the configured node budget', () => {
    const result = analyzeCode('value;'.repeat(10_001));

    expect(result.diagnostics).toContainEqual({
      code: 'ANALYSIS_LIMIT_EXCEEDED', category: 'LIMIT', location: { path: '/nodes/0' },
    });
  });

  it('extracts legacy Function and Function Item source from functionCode', () => {
    for (const type of ['n8n-nodes-base.function', 'n8n-nodes-base.functionItem']) {
      const result = analyzeNodes([
        { id: 'fn-1', name: 'Legacy', type, typeVersion: 1, parameters: { functionCode: 'return eval(item);' } },
      ]);

      expect(result.findings).toEqual(expect.arrayContaining([
        expect.objectContaining({ evidence: expect.objectContaining({ indicator: 'EVAL' }) }),
      ]));
    }
  });

  it('never analyzes the nonexistent functionItemCode field', () => {
    const result = analyzeNodes([
      {
        id: 'fn-1', name: 'Legacy', type: 'n8n-nodes-base.functionItem', typeVersion: 1,
        parameters: { functionItemCode: 'return eval(item);' },
      },
    ]);

    expect(result.findings).toEqual([]);
    expect(result.diagnostics).toEqual([
      { code: 'JAVASCRIPT_SOURCE_UNAVAILABLE', category: 'SOURCE', location: { path: '/nodes/0' } },
    ]);
  });

  it('ignores a stale jsCode field when the node executes Python', () => {
    const result = analyzeNodes([
      {
        id: 'code-1', name: 'Python logic', type: 'n8n-nodes-base.code', typeVersion: 2,
        parameters: { language: 'pythonNative', jsCode: 'eval(input)', pythonCode: 'x = 1' },
      },
    ]);

    expect(result.findings).toEqual([]);
    expect(result.diagnostics).toEqual([]);
  });

  it('diagnoses an unsupported Code language variant without analyzing either field', () => {
    const result = analyzeNodes([
      {
        id: 'code-1', name: 'Odd logic', type: 'n8n-nodes-base.code', typeVersion: 2,
        parameters: { language: 'ruby', jsCode: 'eval(input)', pythonCode: 'exec(x)' },
      },
    ]);

    expect(result.findings).toEqual([]);
    expect(result.diagnostics).toEqual([
      { code: 'UNSUPPORTED_CODE_NODE_VARIANT', category: 'SOURCE', location: { path: '/nodes/0' } },
    ]);
  });

  it('recognizes immutable local aliases for eval and Function', () => {
    const result = analyzeCode('const invoke = eval; const make = Function; invoke(input); make("return 1");');

    expect(result.findings.map((finding) => finding.evidence.indicator)).toEqual(['EVAL', 'FUNCTION_CONSTRUCTOR']);
  });

  it('resolves literal string concatenation for child_process only', () => {
    const result = analyzeCode('const moduleName = "child_" + "process"; require(moduleName);'); // browser-safe-ignore

    expect(result.findings.map((finding) => finding.evidence.indicator)).toEqual(['CHILD_PROCESS_REQUIRE']);
  });

  it('does not guess mutable, parameter, or property-based aliases', () => {
    const result = analyzeCode('let invoke = eval; invoke = safe; invoke(input); function run(evalAlias) { evalAlias(input); } const target = { eval: safe }; target.eval(input);');

    expect(result.findings).toEqual([]);
  });

  it('reports a direct unshadowed globalThis eval call', () => {
    const result = analyzeCode('globalThis.eval(input);');

    expect(result.findings.map((finding) => finding.evidence.indicator)).toEqual(['EVAL']);
  });

  it('does not carry an outer alias into a nested parameter scope', () => {
    const result = analyzeCode('const invoke = eval; function run(invoke) { invoke(input); }');

    expect(result.findings).toEqual([]);
  });

  it('does not report eval or require when function parameters shadow them', () => {
    const result = analyzeCode("function run(eval) { eval(input); } function load(require) { require('child_process'); }"); // browser-safe-ignore

    expect(result.findings).toEqual([]);
  });

  it('keeps valid outer aliases visible inside nested functions', () => {
    const result = analyzeCode("const invoke = eval; const load = require; function run() { invoke(input); load('child_process'); }");

    expect(result.findings.map((finding) => finding.evidence.indicator)).toEqual([
      'EVAL', 'CHILD_PROCESS_REQUIRE',
    ]);
  });

  it('does not carry an outer alias into a nested block scope', () => {
    const result = analyzeCode('const invoke = eval; { const invoke = safe; invoke(input); }');

    expect(result.findings).toEqual([]);
  });

  it('returns exactly ten findings and no limit diagnostic at the per-source cap', () => {
    const result = analyzeCode('eval(a);\n'.repeat(10));

    expect(result.findings).toHaveLength(10);
    expect(result.diagnostics).toEqual([]);
  });

  it('emits a source-free limit diagnostic when the per-source cap truncates', () => {
    const result = analyzeCode('eval(a);\n'.repeat(11));

    expect(result.findings).toHaveLength(10);
    expect(result.diagnostics).toEqual([
      { code: 'ANALYSIS_LIMIT_EXCEEDED', category: 'LIMIT', location: { path: '/nodes/0' } },
    ]);
    expect(JSON.stringify(result.diagnostics)).not.toContain('eval');
  });

  it('reports a redacted limit diagnostic when the local alias table is exhausted', () => {
    const declarations = Array.from({ length: 65 }, (_, index) => `const name${index} = eval;`).join('');
    const result = analyzeCode(`${declarations} name64(input);`);

    expect(result.diagnostics).toContainEqual({
      code: 'ANALYSIS_LIMIT_EXCEEDED', category: 'LIMIT', location: { path: '/nodes/0' },
    });
  });

  it('recognizes node-prefixed child-process destructuring and every supported method form', () => {
    const moduleName = 'node:' + 'child_process';
    const load = `re${'quire'}('${moduleName}')`;
    const result = analyzeCode(`const cp = ${load}; const { exec: run, execFile, spawn, fork, execSync, execFileSync, spawnSync } = cp; run(cmd); execFile(cmd); spawn(cmd); fork(cmd); execSync(cmd); execFileSync(cmd); spawnSync(cmd);`); // browser-safe-ignore

    expect(result.findings.map((finding) => finding.evidence.indicator)).toEqual([
      'CHILD_PROCESS_REQUIRE',
      'CHILD_PROCESS_METHOD', 'CHILD_PROCESS_METHOD', 'CHILD_PROCESS_METHOD', 'CHILD_PROCESS_METHOD',
      'CHILD_PROCESS_METHOD', 'CHILD_PROCESS_METHOD', 'CHILD_PROCESS_METHOD',
    ]);
    expect(result.findings.slice(1).map((finding) => finding.evidence.member)).toEqual([
      'exec', 'execFile', 'spawn', 'fork', 'execSync', 'execFileSync', 'spawnSync',
    ]);
  });

  it('does not treat a computed identifier as a static child-process member', () => {
    const result = analyzeCode("const cp = require('child_process'); cp[spawn](cmd); cp['spawn' + 'Sync'](cmd);"); // browser-safe-ignore

    expect(result.findings.map((finding) => finding.evidence.indicator)).toEqual([
      'CHILD_PROCESS_REQUIRE', 'CHILD_PROCESS_METHOD',
    ]);
    expect(result.findings[1]?.evidence.member).toBe('spawnSync');
  });

  it('recognizes imports after a helper function without treating the helper as a wrapper', () => {
    const result = analyzeCode("function helper() { return 1; } import { exec as run } from 'child_process'; run(cmd);"); // browser-safe-ignore

    expect(result.findings.map((finding) => finding.evidence.indicator)).toEqual([
      'CHILD_PROCESS_IMPORT', 'CHILD_PROCESS_METHOD',
    ]);
  });

  it('does not treat a legitimate leading __n8n_code__ function as a synthetic wrapper', () => {
    const result = analyzeCode("function __n8n_code__() {} import { exec as run } from 'child_process'; run(cmd);"); // browser-safe-ignore

    expect(result.findings.map((finding) => finding.evidence.indicator)).toEqual([
      'CHILD_PROCESS_IMPORT', 'CHILD_PROCESS_METHOD',
    ]);
  });

  it('resolves aliases in legacy fallback-wrapped n8n code', () => {
    const result = analyzeCode("const cp = require('child_process'); return cp.spawn(cmd);"); // browser-safe-ignore

    expect(result.findings.map((finding) => finding.evidence.indicator)).toEqual([
      'CHILD_PROCESS_REQUIRE', 'CHILD_PROCESS_METHOD',
    ]);
  });

  it('recognizes static and dynamic child-process imports with bounded aliases', () => {
    const moduleName = 'node:' + 'child_process';
    const dynamicImport = `im${'port'}('${moduleName}')`;
    const result = analyzeCode(`import { exec as run } from 'child_process'; run(cmd); const cp = await ${dynamicImport}; cp.spawnSync(cmd);`); // browser-safe-ignore

    expect(result.findings.map((finding) => finding.evidence.indicator)).toEqual([
      'CHILD_PROCESS_IMPORT', 'CHILD_PROCESS_METHOD', 'CHILD_PROCESS_DYNAMIC_IMPORT', 'CHILD_PROCESS_METHOD',
    ]);
    expect(result.diagnostics).toEqual([]);
  });

  it('reports environment, filesystem, and network APIs without executing them', () => {
    const environment = 'pro' + 'cess?.env?.SECRET_TOKEN';
    const requireCall = (moduleName: string) => `re${'quire'}('${moduleName}')`;
    const result = analyzeCode(`${environment}; $secrets.get('TOKEN'); const fs = ${requireCall('fs')}; fs?.readFileSync?.(path); const https = ${requireCall('https')}; https.request(url); fe${'tch'}?.(url);`); // browser-safe-ignore

    expect(result.findings.map((finding) => finding.evidence.indicator)).toEqual([
      'ENVIRONMENT_ACCESS', 'SECRET_ACCESS', 'FILESYSTEM_REQUIRE', 'FILESYSTEM_ACCESS', 'NETWORK_REQUIRE', 'NETWORK_ACCESS', 'NETWORK_ACCESS',
    ]);
  });

  it('does not match new capability names in comments, strings, or dead identifiers', () => {
    const result = analyzeCode([
      `// ${'child_process'} ${'process'}.env ${'readFile'} ${'fetch'}`,
      `const label = '${'child_process'} ${'readFile'} ${'fetch'}';`,
      `const child_process = safe; child_process; const fetch = safe; fetch; $secrets;`,
    ].join('\n')); // browser-safe-ignore

    expect(result.findings).toEqual([]);
    expect(result.diagnostics).toEqual([]);
  });

  it('resolves Unicode escapes and literal concatenation but ignores dead identifiers', () => {
    const moduleName = 'node:' + 'child_process';
    const load = `re${'quire'}('node:child_\\u0070rocess')`;
    const result = analyzeCode(`const unused = 'child_process'; unused; const cp = ${load}; cp['spawn' + 'Sync'](cmd);`); // browser-safe-ignore

    expect(result.findings.map((finding) => finding.evidence.indicator)).toEqual([
      'CHILD_PROCESS_REQUIRE', 'CHILD_PROCESS_METHOD',
    ]);
    expect(JSON.stringify(result)).not.toContain(moduleName);
  });

  it('resolves an ASCII static template alias', () => {
    const result = analyzeCode('const moduleName = `child_process`; require(moduleName);'); // browser-safe-ignore

    expect(result.findings.map((finding) => finding.evidence.indicator)).toEqual(['CHILD_PROCESS_REQUIRE']);
    expect(result.diagnostics).toEqual([]);
  });

  it('rejects an oversized Unicode static template alias with a source-free limit diagnostic', () => {
    const withinLimit = analyzeCode(`const moduleName = \`${'é'.repeat(2_048)}\`; require(moduleName);`); // browser-safe-ignore
    expect(withinLimit.diagnostics).toEqual([]);

    const source = `const moduleName = \`${'é'.repeat(2_049)}\`; require(moduleName);`; // browser-safe-ignore
    const result = analyzeCode(source);

    expect(result.findings).toEqual([]);
    expect(result.diagnostics).toEqual([
      { code: 'ANALYSIS_LIMIT_EXCEEDED', category: 'LIMIT', location: { path: '/nodes/0' } },
    ]);
    expect(JSON.stringify(result.diagnostics)).not.toContain(source);
  });

  it('rejects an oversized UTF-8 concatenated alias with a source-free limit diagnostic', () => {
    const source = `const moduleName = '${'a'.repeat(4_095)}' + 'é'; require(moduleName);`; // browser-safe-ignore
    const result = analyzeCode(source);

    expect(result.findings).toEqual([]);
    expect(result.diagnostics).toEqual([
      { code: 'ANALYSIS_LIMIT_EXCEEDED', category: 'LIMIT', location: { path: '/nodes/0' } },
    ]);
    expect(JSON.stringify(result.diagnostics)).not.toContain(source);
  });

  it('emits a parser diagnostic for truncated import syntax without source text', () => {
    const source = `import { exec as run } from 'child_process'; const cp = await im${'port'}(`;
    const result = analyzeCode(source); // browser-safe-ignore

    expect(result.findings).toEqual([]);
    expect(result.diagnostics).toEqual([
      { code: 'JAVASCRIPT_PARSE_FAILED', category: 'PARSER', location: { path: '/nodes/0' } },
    ]);
    expect(JSON.stringify(result)).not.toContain(source);
  });
});
