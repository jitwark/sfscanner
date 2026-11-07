import { describe, expect, it } from 'vitest';
import { DEFAULT_SCANNER_LIMITS_V2 } from '@hub/contracts';
import { parseSourceDocument } from '../source/source-parser';
import { normalizeSecurityWorkflow } from '../workflow-v2/normalize-security-workflow';
import type { AnalyzerContextV2 } from './scheduler';
import { evaluatePythonSecurity } from './python-security';
import { evaluateJavaScriptSecurity } from './javascript-security';

const encoder = new TextEncoder();
function contextFor(text: string, limits = DEFAULT_SCANNER_LIMITS_V2): AnalyzerContextV2 {
  const parsed = parseSourceDocument(encoder.encode(text), limits);
  if (!parsed.ok) throw new Error('source fixture failed');
  const normalized = normalizeSecurityWorkflow(parsed.document, limits);
  if (!normalized.ok) throw new Error('workflow fixture failed');
  return { source: parsed.document, workflow: normalized.workflow, target: { schemaVersion: 'scanner-target-v3', edition: 'COMMUNITY', deployment: 'SELF_HOSTED', role: 'OWNER', taskRunner: 'NATIVE', communityPackages: [], configuration: [], contextDigest: 'c'.repeat(64) }, limits, semantics: { id: 's', version: '1', digest: 's'.repeat(64), resolvedNodeSemantics: new Map() }, rules: { id: 'r', version: '1', digest: 'r'.repeat(64), rules: new Map() }, priorOutcomes: new Map() };
}
function nodeFor(code: string, limits = DEFAULT_SCANNER_LIMITS_V2) {
  const context = contextFor(JSON.stringify({ nodes: [{ id: 'code', name: 'Code', type: 'n8n-nodes-base.code', typeVersion: 2, parameters: { language: 'python', pythonCode: code } }], connections: {} }), limits);
  const node = context.workflow.nodes[0];
  if (!node) throw new Error('node fixture failed');
  return { context, node };
}

describe('Python security capability', () => {
  it('reports execution, subprocess, filesystem, network, and environment families', () => {
    const { node, context } = nodeFor("exec(x)\nsubprocess.run(x)\nopen(path)\nos.environ['KEY']\nrequests.get(url)\n__import__('os')");
    const result = evaluatePythonSecurity(node, context);
    expect(result.facts.map((fact) => fact.properties.indicator)).toEqual(expect.arrayContaining(['EXEC', 'SHELL_SUBPROCESS', 'FILESYSTEM_ACCESS', 'ENVIRONMENT_ACCESS', 'NETWORK_ACCESS', 'DYNAMIC_IMPORT']));
    expect(result.findings.every((finding) => finding.ruleId === 'PYTHON_DYNAMIC_EXECUTION')).toBe(true);
    expect(JSON.stringify(result)).not.toContain('KEY');
  });
  it('resolves imported member aliases but not later rebinding', () => {
    const { node, context } = nodeFor('from subprocess import run\nrun(x)\nrun = safe\nrun(y)');
    const result = evaluatePythonSecurity(node, context);
    expect(result.facts.filter((fact) => fact.properties.indicator === 'SHELL_SUBPROCESS')).toHaveLength(1);
  });
  it.each([
    'import math, subprocess\nsubprocess.run(x)',
    'import subprocess, math\nsubprocess.run(x)',
    'import math, subprocess as sp\nsp.run(x)',
    'import subprocess as sp, math\nsp.run(x)',
  ])('retains the independent subprocess binding: %s', (code) => {
    const { node, context } = nodeFor(code);
    const result = evaluatePythonSecurity(node, context);
    expect(result.facts.filter((fact) => fact.properties.indicator === 'SHELL_SUBPROCESS')).toHaveLength(1);
  });
  it('does not propagate the first module to unrelated later modules', () => {
    const { node, context } = nodeFor('import subprocess, math\nmath.run(x)');
    expect(evaluatePythonSecurity(node, context).facts.filter(
      (fact) => fact.properties.indicator === 'SHELL_SUBPROCESS',
    )).toHaveLength(0);
  });
  it('honours reassignment and local shadowing after an aliased multi-import', () => {
    const { node, context } = nodeFor('import math, subprocess as sp\nsp.run(x)\nsp = safe\nsp.run(y)\ndef f(sp):\n  sp.run(z)');
    expect(evaluatePythonSecurity(node, context).facts.filter(
      (fact) => fact.properties.indicator === 'SHELL_SUBPROCESS',
    )).toHaveLength(1);
  });
  it('keeps unaliased dotted imports bound to their top-level module', () => {
    const { node, context } = nodeFor('import os.path\nos.system(x)');
    expect(evaluatePythonSecurity(node, context).facts.filter(
      (fact) => fact.properties.indicator === 'SHELL_SUBPROCESS',
    )).toHaveLength(1);
  });
  it('retains the full module for explicitly aliased dotted imports', () => {
    const { node, context } = nodeFor('import os.path as p\np.system(x)');
    expect(evaluatePythonSecurity(node, context).facts.filter(
      (fact) => fact.properties.indicator === 'SHELL_SUBPROCESS',
    )).toHaveLength(0);
  });
  it('binds from-import aliases and function/class declarations in their parent scope', () => {
    const { node, context } = nodeFor('from subprocess import run as go\ngo(x)\ndef subprocess():\n  return 1\nsubprocess.run(y)\nclass os:\n  pass\nos.system(z)');
    const result = evaluatePythonSecurity(node, context);
    expect(result.facts.filter((fact) => fact.properties.indicator === 'SHELL_SUBPROCESS')).toHaveLength(1);
  });
  it('does not analyze stale Python fields on version-one JavaScript nodes', () => {
    const context = contextFor(JSON.stringify({ nodes: [{ type: 'n8n-nodes-base.code', parameters: { pythonCode: 'exec(x)' } }], connections: {} }));
    const result = evaluatePythonSecurity(context.workflow.nodes[0]!, context);
    expect(result.facts).toEqual([]);
    expect(result.diagnostics).toEqual([]);
  });

  it('ignores comments and strings, and preserves UTF-16 offsets', () => {
    const { node, context } = nodeFor('# exec(x)\n"exec(x)"\n😀\nexec(x)');
    const result = evaluatePythonSecurity(node, context);
    expect(result.facts.filter((fact) => fact.properties.indicator === 'EXEC')).toHaveLength(1);
    expect(result.facts[0]?.properties.start).toBe('# exec(x)\n"exec(x)"\n😀\n'.length);
  });

  it('retains recovered syntax as potential evidence and reports parser availability separately', () => {
    const { node, context } = nodeFor('if True:\n  exec(payload)\n  broken =');
    const result = evaluatePythonSecurity(node, context);
    expect(result.facts).toEqual(expect.arrayContaining([expect.objectContaining({ properties: expect.objectContaining({ indicator: 'EXEC', parseState: 'RECOVERED' }) })]));
    expect(result.findings.every((finding) => finding.conclusion === 'POTENTIAL')).toBe(true);
    expect(result.diagnostics.map(({ code }) => code)).not.toContain('PYTHON_PARSER_UNAVAILABLE');
  });

  it('does not treat rebound imports as subprocess capabilities and emits bounded diagnostics', () => {
    const { node, context } = nodeFor('import subprocess\nsubprocess = safe\nsubprocess.run(x)', { ...DEFAULT_SCANNER_LIMITS_V2, maxCodeSyntaxNodes: 2 });
    const result = evaluatePythonSecurity(node, context);
    expect(result.facts.some((fact) => fact.properties.indicator === 'SHELL_SUBPROCESS')).toBe(false);
    expect(result.diagnostics.map(({ code }) => code)).toContain('OPTIONAL_LIMIT_EXCEEDED');
    const oversized = nodeFor('x'.repeat(100_001));
    expect(evaluatePythonSecurity(oversized.node, oversized.context).diagnostics.map(({ code }) => code)).toContain('OPTIONAL_LIMIT_EXCEEDED');
  });

  it('routes all equivalent admitted versions to Python without parsing pythonCode as JS', () => {
    const observations = [2, '2', '2.0', '2.0.0'].map((typeVersion) => {
      const context = contextFor(JSON.stringify({ nodes: [{ id: 'code', name: 'Code',
        type: 'n8n-nodes-base.code', typeVersion,
        parameters: { language: 'python', pythonCode: 'exec(x)' } }], connections: {} }));
      const node = context.workflow.nodes[0]!;
      const python = evaluatePythonSecurity(node, context);
      const javascript = evaluateJavaScriptSecurity(node, context);
      const indicators = python.facts.map((fact) => fact.properties.indicator);
      expect(indicators).toContain('EXEC');
      expect(javascript.facts).toEqual([]);
      expect(javascript.diagnostics.map((item) => item.code)).not.toContain('JAVASCRIPT_PARSE_FAILED');
      return { indicators, diagnostics: python.diagnostics.map((item) => item.code) };
    });
    for (const observation of observations) expect(observation).toEqual(observations[0]);
  });
});
