import { describe, expect, it } from 'vitest';
import { parseWorkflowJson } from '../../workflow';
import { MAX_JAVASCRIPT_SOURCE_BYTES, analyzeWorkflowJavaScript } from './javascript-analysis';

function analyzeNodes(nodes: unknown[]) {
  const parsed = parseWorkflowJson(JSON.stringify({ nodes, connections: {} }));
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) throw new Error(parsed.message);
  return analyzeWorkflowJavaScript(parsed.workflow);
}

function analyzeCode(source: string, extra: Record<string, unknown> = {}) {
  return analyzeNodes([{
    id: 'js-1', name: 'JavaScript', type: 'n8n-nodes-base.code', typeVersion: 2,
    parameters: { jsCode: source, ...extra },
  }]);
}

describe('scanner-core JavaScript analyzer', () => {
  it('detects executable indicators in source order with source spans', () => {
    const result = analyzeCode('eval(input); require("child_process"); process.env.TOKEN;');

    expect(result.findings.map((finding) => finding.evidence.indicator)).toEqual([
      'EVAL', 'CHILD_PROCESS_REQUIRE', 'ENVIRONMENT_ACCESS',
    ]);
    expect(result.findings[0]?.evidence).toMatchObject({ start: 0, end: 11 });
    expect(result.findings.every((finding) => finding.policyId === 'JAVASCRIPT_DYNAMIC_EXECUTION')).toBe(true);
    expect(result.findings.every((finding) => finding.message === 'Custom JavaScript uses a dynamic execution primitive.')).toBe(true);
  });

  it('does not treat comments or strings as executable indicators', () => {
    expect(analyzeCode('// eval(input)\nconst label = "child_process";')).toMatchObject({ findings: [], diagnostics: [] });
  });

  it('reports malformed source without returning its text', () => {
    // R-04 regression note: JavaScript parsing is all-or-nothing by design. Acorn returns one AST
    // or throws, so `const = ; secret-value` produces no findings and JAVASCRIPT_PARSE_FAILED. The
    // required-stage mapping makes the scan INDETERMINATE; the analyzer never fabricates a partial
    // AST or scans raw source text after a syntax error. Python's CST keeps pre-error findings.
    const source = 'const = ; secret-value';
    const result = analyzeCode(source);

    expect(result).toEqual({ findings: [], diagnostics: [{
      code: 'JAVASCRIPT_PARSE_FAILED', category: 'PARSER', location: { path: '/nodes/0' },
    }] });
    expect(JSON.stringify(result)).not.toContain(source);
  });

  it('reports unsupported variants and unavailable selected source', () => {
    expect(analyzeCode('eval(input)', { language: 'ruby', pythonCode: 'exec(input)' })).toEqual({
      findings: [], diagnostics: [{
        code: 'UNSUPPORTED_CODE_NODE_VARIANT', category: 'SOURCE', location: { path: '/nodes/0' },
      }],
    });
    expect(analyzeCode('eval(input)', { language: 'pythonNative', pythonCode: 'exec(input)' })).toEqual({
      findings: [], diagnostics: [],
    });
    expect(analyzeNodes([{
      id: 'legacy-1', name: 'Legacy', type: 'n8n-nodes-base.function', typeVersion: 1,
      parameters: { functionItemCode: 'eval(input)' },
    }])).toEqual({ findings: [], diagnostics: [{
      code: 'JAVASCRIPT_SOURCE_UNAVAILABLE', category: 'SOURCE', location: { path: '/nodes/0' },
    }] });
  });

  it('enforces source and finding limits with redacted diagnostics', () => {
    expect(analyzeCode('x'.repeat(MAX_JAVASCRIPT_SOURCE_BYTES + 1))).toEqual({ findings: [], diagnostics: [{
      code: 'ANALYSIS_LIMIT_EXCEEDED', category: 'LIMIT', location: { path: '/nodes/0' },
    }] });

    const result = analyzeCode('eval(input);\n'.repeat(11));
    expect(result.findings).toHaveLength(10);
    expect(result.diagnostics).toEqual([{ code: 'ANALYSIS_LIMIT_EXCEEDED', category: 'LIMIT', location: { path: '/nodes/0' } }]);
    expect(JSON.stringify(result.diagnostics)).not.toContain('eval');
  });

  it('produces byte-identical output for repeated analysis', () => {
    const source = 'const cp = require("node:child_process"); cp.spawn(command);';
    expect(JSON.stringify(analyzeCode(source))).toBe(JSON.stringify(analyzeCode(source)));
  });
});

describe('scanner-core JavaScript analyzer sink table', () => {
  const indicators = (source: string) =>
    analyzeCode(source).findings.map((finding) => finding.evidence.indicator);

  // Each spelling below was measured false-clean (findings AND diagnostics empty) on the shipped
  // analyzer, so a regression here is a silent miss rather than a noisy duplicate.
  it.each([
    ["require('vm')", "const vm = require('vm'); vm.runInNewContext('1')", 'VM_REQUIRE'],
    ["require('worker_threads')", "const w = require('worker_threads'); new w.Worker('x')", 'WORKER_THREADS_REQUIRE'],
    ["require('module')", "const M = require('module'); new M.Module('x')", 'MODULE_REQUIRE'],
    ['indirect eval', "(0, eval)('1')", 'EVAL'],
    ['member eval', "globalThis.eval('1')", 'EVAL'],
    ['string setTimeout', "setTimeout('1', 10)", 'STRING_TIMER'],
    ['concatenated process binding', "const p = 'pro' + 'cess'; p.env.API_KEY", 'ENVIRONMENT_ACCESS'],
  ])('flags %s with a finding or diagnostic', (_name, source, indicator) => {
    const result = analyzeCode(source);

    expect(result).not.toEqual({ findings: [], diagnostics: [] });
    expect(indicators(source)).toContain(indicator);
  });

  it('flags module usage through a node-prefixed or concatenated module name', () => {
    expect(indicators("const vm = require('node:' + 'vm'); vm.runInThisContext('1')")).toEqual([
      'VM_REQUIRE', 'VM_METHOD',
    ]);
    expect(indicators("const { Worker } = require('worker_threads'); new Worker('x')")).toEqual([
      'WORKER_THREADS_REQUIRE', 'WORKER_THREADS_METHOD',
    ]);
    expect(indicators("const { createRequire } = require('module'); createRequire(import.meta.url)")).toEqual([
      'MODULE_REQUIRE', 'MODULE_METHOD',
    ]);
  });

  it('flags member code compilation and computed member eval', () => {
    expect(indicators("globalThis.Function('return 1')")).toEqual(['FUNCTION_CONSTRUCTOR']);
    expect(indicators("globalThis['eval']('1')")).toEqual(['EVAL']);
    expect(indicators("window.eval('1'); self.eval('1'); global.eval('1')")).toEqual(['EVAL', 'EVAL', 'EVAL']);
  });

  it('does not resolve a mutable alias after it is rebound to a safe function', () => {
    const result = analyzeCode('let invoke = eval; invoke = safe; invoke(input);');

    expect(result).toEqual({ findings: [], diagnostics: [] });
  });

  it('flags every string timer form that compiles its first argument', () => {
    expect(indicators("setInterval('1', 10)")).toEqual(['STRING_TIMER']);
    expect(indicators("setImmediate('1')")).toEqual(['STRING_TIMER']);
    expect(indicators("const code = 'pro' + 'cess.env.X'; setTimeout(code, 10)")).toEqual(['STRING_TIMER']);
  });

  it('does not flag timers, eval, or Function reached without a code-shaped argument', () => {
    // Negative fixtures: the sink table must not fire on callback timers, dynamic-only eval
    // arguments, non-global member calls, shadowed globals, or comma operands that are not sinks.
    expect(indicators('setTimeout(handler, 10)')).toEqual([]);
    expect(indicators('setTimeout(() => {}, 10)')).toEqual([]);
    expect(indicators('setTimeout(code, 10)')).toEqual([]);
    expect(indicators("const gg = { eval: safe }; gg.eval(input)")).toEqual([]);
    expect(indicators('function run(globalThis) { globalThis.eval(input); }')).toEqual([]);
    expect(indicators('(0, invoke)(input)')).toEqual([]);
    expect(indicators("const s = 'eval'; s(input)")).toEqual([]);
  });

  it('flags a statically unresolvable require once, without double-firing a resolvable one', () => {
    const [finding] = analyzeCode('require(moduleName)').findings;

    expect(finding).toMatchObject({
      policyId: 'JAVASCRIPT_DYNAMIC_EXECUTION',
      severity: 'HIGH',
      evidence: { indicator: 'MODULE_UNRESOLVED', start: 0, end: 19 },
    });
    expect(finding?.evidence).not.toHaveProperty('member');
    expect(indicators("require('child_process')")).toEqual(['CHILD_PROCESS_REQUIRE']);
    expect(indicators("const name = 'child_' + 'process'; require(name)")).toEqual(['CHILD_PROCESS_REQUIRE']);
  });

  it('does not report an unresolvable require for a shadowed require or a dynamic import', () => {
    // Negative fixtures: only a bare, unshadowed `require` loader qualifies, and a dynamic
    // `import()` keeps its existing (silent) treatment rather than borrowing the new indicator.
    expect(indicators('function load(require) { require(moduleName); }')).toEqual([]);
    expect(indicators('import(moduleName)')).toEqual([]);
  });

  it('keeps the limit diagnostic instead of an unresolvable-require finding when resolution overflows', () => {
    const source = `const moduleName = \`${'é'.repeat(2_049)}\`; require(moduleName);`;
    const result = analyzeCode(source); // browser-safe-ignore

    expect(result.findings).toEqual([]);
    expect(result.diagnostics).toEqual([
      { code: 'ANALYSIS_LIMIT_EXCEEDED', category: 'LIMIT', location: { path: '/nodes/0' } },
    ]);
  });
});
