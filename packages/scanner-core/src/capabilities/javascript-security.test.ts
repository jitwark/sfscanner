import { describe, expect, it } from 'vitest';
import { DEFAULT_SCANNER_LIMITS_V2 } from '@hub/contracts';
import { parseSourceDocument } from '../source/source-parser';
import { normalizeSecurityWorkflow } from '../workflow-v2/normalize-security-workflow';
import type { AnalyzerContextV2 } from './scheduler';
import { evaluateJavaScriptSecurity } from './javascript-security';

const encoder = new TextEncoder();
function contextFor(text: string, limits = DEFAULT_SCANNER_LIMITS_V2): AnalyzerContextV2 {
  const parsed = parseSourceDocument(encoder.encode(text), limits);
  if (!parsed.ok) throw new Error('source fixture failed');
  const normalized = normalizeSecurityWorkflow(parsed.document, limits);
  if (!normalized.ok) throw new Error('workflow fixture failed');
  return { source: parsed.document, workflow: normalized.workflow, target: { schemaVersion: 'scanner-target-v3', edition: 'COMMUNITY', deployment: 'SELF_HOSTED', role: 'OWNER', taskRunner: 'NATIVE', communityPackages: [], configuration: [], contextDigest: 'c'.repeat(64) }, limits, semantics: { id: 's', version: '1', digest: 's'.repeat(64), resolvedNodeSemantics: new Map() }, rules: { id: 'r', version: '1', digest: 'r'.repeat(64), rules: new Map() }, priorOutcomes: new Map() };
}
function nodeFor(code: string, extra: Record<string, unknown> = {}) {
  const context = contextFor(JSON.stringify({ nodes: [{ id: 'code', name: 'Code', type: 'n8n-nodes-base.code', parameters: { jsCode: code, ...extra } }], connections: {} }));
  const node = context.workflow.nodes[0];
  if (!node) throw new Error('node fixture failed');
  return { context, node };
}

describe('JavaScript security capability', () => {
  it('reports execution, filesystem, network, environment, and module indicators without source text', () => {
    const { node, context } = nodeFor("eval(x); process.env.API_KEY; require('fs').readFileSync(x); fetch(url); import('child_process');");
    const result = evaluateJavaScriptSecurity(node, context);
    expect(result.findings.map((finding) => finding.ruleId)).toEqual(expect.arrayContaining(['JAVASCRIPT_DYNAMIC_EXECUTION']));
    expect(result.facts.map((fact) => fact.properties.indicator)).toEqual(expect.arrayContaining(['EVAL', 'ENVIRONMENT_ACCESS', 'FILESYSTEM_REQUIRE', 'FILESYSTEM_ACCESS', 'NETWORK_ACCESS', 'CHILD_PROCESS_DYNAMIC_IMPORT']));
    expect(JSON.stringify(result)).not.toContain('API_KEY');
  });

  it.each([
    { name: 'destructured require', code: "const { exec } = require('child_process'); exec(x);", module: 'CHILD_PROCESS_REQUIRE' },
    { name: 'node: destructured require alias', code: "const { exec: run } = require('node:child_process'); run(x);", module: 'CHILD_PROCESS_REQUIRE' },
    { name: 'named import', code: "import { exec } from 'child_process'; exec(x);", module: 'CHILD_PROCESS_IMPORT' },
    { name: 'aliased named import', code: "import { exec as run } from 'child_process'; run(x);", module: 'CHILD_PROCESS_IMPORT' },
    { name: 'node: named import', code: "import { exec } from 'node:child_process'; exec(x);", module: 'CHILD_PROCESS_IMPORT' },
    { name: 'namespace import', code: "import * as cp from 'child_process'; cp.exec(x);", module: 'CHILD_PROCESS_IMPORT' },
    { name: 'default import', code: "import cp from 'child_process'; cp.exec(x);", module: 'CHILD_PROCESS_IMPORT' },
  ])('tracks calls from $name', ({ code, module }) => {
    const { node, context } = nodeFor(code);
    const result = evaluateJavaScriptSecurity(node, context);
    expect(result.facts.filter((fact) => fact.properties.indicator === 'CHILD_PROCESS_METHOD')).toHaveLength(1);
    expect(result.facts.some((fact) => fact.properties.indicator === module)).toBe(true);
  });

  it('accepts a static string property key and retains call offsets without source text', () => {
    const code = "const { 'exec': run } = require('child_process'); run('binding-source-secret');";
    const { node, context } = nodeFor(code);
    const result = evaluateJavaScriptSecurity(node, context);
    const method = result.facts.find((fact) => fact.properties.indicator === 'CHILD_PROCESS_METHOD');
    expect(method?.properties.start).toBe(code.indexOf('run(\'binding-source-secret\')'));
    expect(method?.properties.end).toBe(code.indexOf('run(\'binding-source-secret\')') + 'run(\'binding-source-secret\')'.length);
    expect(JSON.stringify(result)).not.toContain('binding-source-secret');
  });

  it('keeps an imported member shadowed only inside its lexical scope', () => {
    const { node, context } = nodeFor("import { exec as run } from 'child_process'; function safe(run) { run(x); } run(y);");
    const result = evaluateJavaScriptSecurity(node, context);
    expect(result.facts.filter((fact) => fact.properties.indicator === 'CHILD_PROCESS_METHOD')).toHaveLength(1);
  });

  it('does not grant builtin provenance to unsupported destructuring sources or shapes', () => {
    const cases = [
      "const { exec } = 'child_process'; exec(x);",
      "const { [key]: exec } = require('child_process'); exec(x);",
      "const { ...exec } = require('child_process'); exec(x);",
      "const { exec = fallback } = require('child_process'); exec(x);",
      "const { nested: { exec } } = require('child_process'); exec(x);",
      "const { exec, [key]: run } = require('child_process'); exec(x); run(y);",
      "const { exec } = require(getModule()); exec(x);",
      "const { exec } = require('child_process', extra); exec(x);",
      "const cp = require('child_process'); const { exec } = cp; exec(x);",
      "import { exec } from 'node:unknown'; exec(x);",
    ];
    for (const code of cases) {
      const { node, context } = nodeFor(code);
      const result = evaluateJavaScriptSecurity(node, context);
      expect(result.facts.filter((fact) => fact.properties.indicator === 'CHILD_PROCESS_METHOD'), code).toHaveLength(0);
    }
  });

  it('does not grant destructuring provenance to a locally shadowed require', () => {
    const code = "const { exec: outer } = require('child_process'); function safe(require) { const { exec: inner } = require('child_process'); inner(x); } outer(y);";
    const { node, context } = nodeFor(code);
    const result = evaluateJavaScriptSecurity(node, context);
    expect(result.facts.filter((fact) => fact.properties.indicator === 'CHILD_PROCESS_METHOD')).toHaveLength(1);
  });

  it('predeclares later lexical require bindings before resolving destructuring initializers', () => {
    const { node, context } = nodeFor("const { exec } = require('child_process'); const require = safe; exec(x);");
    const result = evaluateJavaScriptSecurity(node, context);
    expect(result.facts.filter((fact) => fact.properties.indicator === 'CHILD_PROCESS_METHOD')).toHaveLength(0);
  });

  it('treats var require in a nested block as function-scoped while preserving outer builtin calls', () => {
    const code = "const { exec: outer } = require('child_process'); function f() { { var require; } const { exec } = require('child_process'); exec(x); } outer(y);";
    const { node, context } = nodeFor(code);
    const result = evaluateJavaScriptSecurity(node, context);
    expect(result.facts.filter((fact) => fact.properties.indicator === 'CHILD_PROCESS_METHOD')).toHaveLength(1);
    expect(result.facts.filter((fact) => fact.properties.indicator === 'CHILD_PROCESS_REQUIRE')).toHaveLength(1);
  });

  it.each([
    { kind: 'for', statement: 'for (let exec = unused; false; ) exec(x);' },
    { kind: 'for-in', statement: 'for (let exec in values) exec(x);' },
    { kind: 'for-of', statement: 'for (let exec of values) exec(x);' },
    { kind: 'switch', statement: 'switch (exec(x)) { case 0: let exec; exec(y); }' },
    { kind: 'block class declaration', statement: '{ class exec { run() { exec(x); } } }' },
    { kind: 'named class expression', statement: 'const C = class exec { run() { exec(x); } };' },
  ])('keeps imported calls outside the $kind lexical scope', ({ kind, statement }) => {
    const { node, context } = nodeFor(`import { exec } from 'child_process'; ${statement} exec(y);`);
    expect(evaluateJavaScriptSecurity(node, context).facts.filter((fact) => fact.properties.indicator === 'CHILD_PROCESS_METHOD')).toHaveLength(kind === 'switch' ? 2 : 1);
  });

  it('keeps var loop bindings function-scoped', () => {
    const { node, context } = nodeFor("import { exec } from 'child_process'; function f() { for (var exec of values) exec(x); exec(y); } exec(z);");
    expect(evaluateJavaScriptSecurity(node, context).facts.filter((fact) => fact.properties.indicator === 'CHILD_PROCESS_METHOD')).toHaveLength(1);
  });

  it('does not treat a member assignment through an imported alias as rebinding the alias', () => {
    const code = "import { exec } from 'child_process'; exec(before); ({ value: exec.value } = input); exec(after);";
    const { node, context } = nodeFor(code);
    const result = evaluateJavaScriptSecurity(node, context);
    expect(result.facts.filter((fact) => fact.properties.indicator === 'CHILD_PROCESS_METHOD')).toHaveLength(2);
    expect(result.diagnostics.map(({ code: diagnostic }) => diagnostic)).not.toContain('OPTIONAL_LIMIT_EXCEEDED');
  });

  it('keeps imported indicators when a destructuring assignment targets a member expression', () => {
    const code = "import { exec } from 'child_process'; exec(x); ({ value: target.value } = input); exec(y);";
    const { node, context } = nodeFor(code);
    const result = evaluateJavaScriptSecurity(node, context);
    expect(result.facts.filter((fact) => fact.properties.indicator === 'CHILD_PROCESS_METHOD')).toHaveLength(2);
    expect(result.facts.filter((fact) => fact.properties.indicator === 'CHILD_PROCESS_IMPORT')).toHaveLength(1);
    expect(result.diagnostics.map(({ code: diagnostic }) => diagnostic)).not.toContain('OPTIONAL_LIMIT_EXCEEDED');
  });

  it('null-shadows every local found in unsupported variable, function, and catch patterns', () => {
    const cases = [
      "const { child_process } = 'untrusted'; child_process.exec(x);",
      "const { [key]: child_process } = 'untrusted'; child_process.exec(x);",
      "function safe({ child_process }) { child_process.exec(x); }",
      "try { throw 1; } catch ({ child_process }) { child_process.exec(x); }",
    ];
    for (const code of cases) {
      const { node, context } = nodeFor(code);
      expect(evaluateJavaScriptSecurity(node, context).facts.filter((fact) => fact.properties.indicator === 'CHILD_PROCESS_METHOD'), code).toHaveLength(0);
    }
  });

  it.each([
    "import { exec as run } from 'child_process'; function safe({ run }) { run(x); } run(y);",
    "import { exec as run } from 'child_process'; try { throw 1; } catch ({ run }) { run(x); } run(y);",
    "import { exec as run } from 'child_process'; function safe({ [key]: run }) { run(x); } run(y);",
    "import { exec as run } from 'child_process'; function safe({ ...run }) { run(x); } run(y);",
    "import { exec as run } from 'child_process'; function safe({ run = fallback }) { run(x); } run(y);",
  ])('null-shadows unsupported function/catch binding patterns: %s', (code) => {
    const { node, context } = nodeFor(code);
    const result = evaluateJavaScriptSecurity(node, context);
    expect(result.facts.filter((fact) => fact.properties.indicator === 'CHILD_PROCESS_METHOD')).toHaveLength(1);
  });

  it('does not treat pattern keys or default right-hand sides as bindings', () => {
    const code = "import { exec as run, execFile as key } from 'child_process'; function safe({ key: local = run }) { run(x); key(y); } run(z); key(q);";
    const { node, context } = nodeFor(code);
    const result = evaluateJavaScriptSecurity(node, context);
    expect(result.facts.filter((fact) => fact.properties.indicator === 'CHILD_PROCESS_METHOD')).toHaveLength(4);
  });

  it('clears imported member provenance after reassignment and destructuring assignment', () => {
    const reassigned = nodeFor("import { exec as run } from 'child_process'; run(x); run = safe; run(y);");
    expect(evaluateJavaScriptSecurity(reassigned.node, reassigned.context).facts.filter((fact) => fact.properties.indicator === 'CHILD_PROCESS_METHOD')).toHaveLength(1);
    const destructured = nodeFor("import { exec } from 'child_process'; exec(x); ({ exec } = safe); exec(y);");
    expect(evaluateJavaScriptSecurity(destructured.node, destructured.context).facts.filter((fact) => fact.properties.indicator === 'CHILD_PROCESS_METHOD')).toHaveLength(1);
    const captured = nodeFor("let { exec } = require('child_process'); exec(x); ({ exec } = safe); exec(y);");
    expect(evaluateJavaScriptSecurity(captured.node, captured.context).facts.filter((fact) => fact.properties.indicator === 'CHILD_PROCESS_METHOD')).toHaveLength(1);
  });

  it('omits source facts when pattern binding analysis exhausts its node budget', () => {
    const code = `const { ${Array.from({ length: 24 }, (_, index) => `v${index}`).join(', ')} } = require('child_process'); exec(x);`;
    const limited = contextFor(JSON.stringify({ nodes: [{ type: 'n8n-nodes-base.code', parameters: { jsCode: code } }], connections: {} }), { ...DEFAULT_SCANNER_LIMITS_V2, maxCodeSyntaxNodes: 10 });
    const result = evaluateJavaScriptSecurity(limited.workflow.nodes[0]!, limited);
    expect(result.facts).toEqual([]);
    expect(result.diagnostics.map(({ code: diagnostic }) => diagnostic)).toContain('OPTIONAL_LIMIT_EXCEEDED');
  });

  it('ignores comments, template raw text, regex literals, and division while preserving UTF-16 offsets', () => {
    const { node, context } = nodeFor('😀 /* eval(x) */ const r = /eval\\(x\\)/; const n = 8 / 2; `eval(x)`; eval(x);');
    const result = evaluateJavaScriptSecurity(node, context);
    expect(result.facts.filter((fact) => fact.properties.indicator === 'EVAL')).toHaveLength(1);
    expect(result.facts[0]?.properties.start).toBe('😀 /* eval(x) */ const r = /eval\\(x\\)/; const n = 8 / 2; `eval(x)`; '.length);
  });
  it('does not recover identifiers from a malformed regular-expression body', () => {
    const { node, context } = nodeFor('const re = /eval(x/;');
    const result = evaluateJavaScriptSecurity(node, context);
    expect(result.facts.some((fact) => fact.properties.indicator === 'EVAL')).toBe(false);
    expect(result.diagnostics.map(({ code }) => code)).toContain('JAVASCRIPT_PARSE_FAILED');
  });
  it('charges the token budget before parsing and emits no partial evidence', () => {
    const fixture = nodeFor('eval(x)');
    const limited = contextFor(JSON.stringify({ nodes: [{ type: 'n8n-nodes-base.code', parameters: { jsCode: 'eval(x)' } }], connections: {} }), { ...DEFAULT_SCANNER_LIMITS_V2, maxExpressionTokens: 3 });
    expect(evaluateJavaScriptSecurity(limited.workflow.nodes[0]!, limited).facts).toEqual([]);
    expect(evaluateJavaScriptSecurity(fixture.node, fixture.context).facts).not.toEqual([]);
  });

  it('requires exact unshadowed roots and stops reporting rebound aliases', () => {
    const { node, context } = nodeFor("const fs = require('fs'); fs.readFile(x); fs = safe; fs.readFile(y); { const $env = {}; $env.KEY; } $env.KEY;");
    const result = evaluateJavaScriptSecurity(node, context);
    expect(result.facts.map((fact) => fact.properties.indicator)).toEqual(expect.arrayContaining(['FILESYSTEM_REQUIRE', 'FILESYSTEM_ACCESS', 'SECRET_ACCESS']));
    expect(result.facts.filter((fact) => fact.properties.indicator === 'FILESYSTEM_ACCESS')).toHaveLength(1);
  });
  it('does not resolve a shadowed module loader', () => {
    const { node, context } = nodeFor("const require = safe; require('fs').readFile(x);");
    expect(evaluateJavaScriptSecurity(node, context).facts).toEqual([]);
  });
  it('does not flag Python variants as unsupported in the JavaScript capability', () => {
    const context = contextFor(JSON.stringify({ nodes: [{ type: 'n8n-nodes-base.code', typeVersion: 2, parameters: { language: 'python', pythonCode: 'exec(x)' } }], connections: {} }));
    expect(evaluateJavaScriptSecurity(context.workflow.nodes[0]!, context).diagnostics).toEqual([]);
  });

  it('recognizes the exact this.getCredentials root and redacts unsafe computed members', () => {
    const credential = nodeFor('this.getCredentials();');
    expect(evaluateJavaScriptSecurity(credential.node, credential.context).facts.map((fact) => fact.properties.indicator)).toContain('SECRET_ACCESS');
    const secret = nodeFor('$env["secret-key"];');
    const result = evaluateJavaScriptSecurity(secret.node, secret.context);
    expect(result.facts.some((fact) => fact.properties.member === 'secret-key')).toBe(false);
  });

  it('treats catch bindings as shadowing n8n roots', () => {
    const { node, context } = nodeFor('try { safe(); } catch ($env) { $env.KEY; }');
    expect(evaluateJavaScriptSecurity(node, context).facts).toEqual([]);
  });

  it('retains malformed source as potential recovered evidence', () => {
    const { node, context } = nodeFor('if (true) { eval(payload);');
    const result = evaluateJavaScriptSecurity(node, context);
    expect(result.diagnostics.some((diagnostic) => diagnostic.code === 'JAVASCRIPT_PARSE_FAILED')).toBe(true);
    expect(result.facts).toEqual(expect.arrayContaining([expect.objectContaining({ properties: expect.objectContaining({ indicator: 'EVAL', parseState: 'RECOVERED' }) })]));
    expect(result.findings.every((finding) => finding.conclusion === 'POTENTIAL')).toBe(true);
  });

  it('reports unsupported variants and exact source and syntax caps', () => {
    const unsupported = contextFor(JSON.stringify({ nodes: [{ type: 'n8n-nodes-base.code', typeVersion: 2, parameters: { language: 'ruby', jsCode: 'eval(x)' } }], connections: {} }));
    expect(evaluateJavaScriptSecurity(unsupported.workflow.nodes[0]!, unsupported).diagnostics.map(({ code }) => code)).toContain('UNSUPPORTED_CODE_NODE_VARIANT');
    const capped = nodeFor('eval(x); eval(y);');
    expect(evaluateJavaScriptSecurity(capped.node, contextFor(JSON.stringify({ nodes: [{ type: 'n8n-nodes-base.code', parameters: { jsCode: 'eval(x); eval(y);' } }], connections: {} }), { ...DEFAULT_SCANNER_LIMITS_V2, maxCodeSyntaxNodes: 1 })).diagnostics.map(({ code }) => code)).toContain('OPTIONAL_LIMIT_EXCEEDED');
    const oversized = nodeFor('x'.repeat(100_001));
    expect(evaluateJavaScriptSecurity(oversized.node, oversized.context).diagnostics.map(({ code }) => code)).toContain('OPTIONAL_LIMIT_EXCEEDED');
  });
});
