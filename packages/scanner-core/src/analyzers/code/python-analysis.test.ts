import { describe, expect, it } from 'vitest';
import { parseWorkflowJson } from '../../workflow';
import { MAX_PYTHON_SOURCE_BYTES, analyzeWorkflowPython } from './python-analysis';

function analyzeNodes(nodes: unknown[]) {
  const parsed = parseWorkflowJson(JSON.stringify({ nodes, connections: {} }));
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) throw new Error(parsed.message);
  return analyzeWorkflowPython(parsed.workflow);
}

function analyzeCode(source: string, parameters: Record<string, unknown> = {}) {
  return analyzeNodes([{
    id: 'py-1', name: 'Python', type: 'n8n-nodes-base.code', typeVersion: 2,
    parameters: { language: 'pythonNative', pythonCode: source, ...parameters },
  }]);
}

describe('scanner-core Python analyzer', () => {
  it('detects dynamic execution and subprocess indicators in source order', () => {
    const source = 'exec(payload)\neval(payload)\n__import__("os")\nsubprocess.run(command)';
    const result = analyzeCode(source);

    expect(result.findings.map((finding) => finding.evidence.indicator)).toEqual([
      'EXEC', 'EVAL', 'DYNAMIC_IMPORT', 'SHELL_SUBPROCESS',
    ]);
    expect(result.findings.map((finding) => finding.evidence.member)).toEqual([
      undefined, undefined, undefined, 'run',
    ]);
    expect(result.findings[3]?.evidence).toMatchObject({
      start: source.indexOf('subprocess.run'),
      end: source.length,
    });
    expect(result.findings.every((finding) => finding.policyId === 'PYTHON_DYNAMIC_EXECUTION')).toBe(true);
  });

  it('only analyzes explicitly selected Python source', () => {
    expect(analyzeCode('exec(payload)', { language: 'javaScript' })).toEqual({ findings: [], diagnostics: [] });
    expect(analyzeNodes([{
      id: 'py-1', name: 'Python', type: 'n8n-nodes-base.code', typeVersion: 1,
      parameters: { language: 'pythonNative', pythonCode: 'exec(payload)' },
    }])).toEqual({ findings: [], diagnostics: [] });
  });

  it('does not treat comments or strings as executable indicators', () => {
    expect(analyzeCode('# exec(payload)\nlabel = "eval(value)"')).toMatchObject({ findings: [], diagnostics: [] });
  });

  it('reports malformed and unavailable source diagnostics without source text', () => {
    const source = 'def broken(: secret-value';
    const malformed = analyzeCode(source, { language: 'python' });
    expect(malformed).toEqual({ findings: [], diagnostics: [{
      code: 'PYTHON_PARSE_FAILED', category: 'PARSER', location: { path: '/nodes/0' },
    }] });
    expect(JSON.stringify(malformed)).not.toContain(source);

    expect(analyzeCode('', { language: 'python', pythonCode: undefined })).toEqual({ findings: [], diagnostics: [{
      code: 'PYTHON_SOURCE_UNAVAILABLE', category: 'SOURCE', location: { path: '/nodes/0' },
    }] });
  });

  it('retains findings produced before a later syntax error', () => {
    // Runtime verification 12: scanner-core flags `subprocess.run` regardless of shell=True;
    // the root duplicate only flags shell=True, so its shell=False control is a different contract.
    const result = analyzeCode('subprocess.run(["ls"])\ndef broken(:');
    expect(result.findings.map((finding) => finding.evidence.indicator)).toContain('SHELL_SUBPROCESS');
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain('PYTHON_PARSE_FAILED');
  });

  it('enforces source and finding limits with redacted diagnostics', () => {
    expect(analyzeCode('x'.repeat(MAX_PYTHON_SOURCE_BYTES + 1))).toEqual({ findings: [], diagnostics: [{
      code: 'ANALYSIS_LIMIT_EXCEEDED', category: 'LIMIT', location: { path: '/nodes/0' },
    }] });

    const result = analyzeCode('exec(payload)\n'.repeat(11));
    expect(result.findings).toHaveLength(10);
    expect(result.diagnostics).toEqual([{ code: 'ANALYSIS_LIMIT_EXCEEDED', category: 'LIMIT', location: { path: '/nodes/0' } }]);
    expect(JSON.stringify(result.diagnostics)).not.toContain('exec');
  });

  it('produces byte-identical output for repeated analysis', () => {
    const source = 'import subprocess as sp\nsp.Popen(command)';
    expect(JSON.stringify(analyzeCode(source))).toBe(JSON.stringify(analyzeCode(source)));
  });
});
