import { describe, expect, it } from 'vitest';
import { parseWorkflowJson } from '@hub/scanner-core/workflow';
import {
  MAX_PYTHON_SOURCE_BYTES,
  analyzeWorkflowPython,
} from '@hub/scanner-core/analyzers/code/python-analysis';

function analyzeNodes(nodes: unknown[]) {
  const parsed = parseWorkflowJson(JSON.stringify({ nodes, connections: {} }));
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) throw new Error(parsed.message);
  return analyzeWorkflowPython(parsed.workflow);
}

// Only Code v2 exposes the language selector, so Python analysis requires it.
function analyzeCode(parameters: Record<string, unknown>) {
  return analyzeNodes([
    { id: 'python-1', name: 'Python logic', type: 'n8n-nodes-base.code', typeVersion: 2, parameters },
  ]);
}

describe('analyzeWorkflowPython', () => {
  it('recognizes direct dynamic execution structures in source order', () => {
    const result = analyzeCode({
      language: 'pythonNative',
      pythonCode: 'exec(payload)\neval(payload)\n__import__("os")\nsubprocess.run("x", shell=True)',
    });

    expect(result.findings.map((finding) => finding.evidence.indicator)).toEqual([
      'EXEC', 'EVAL', 'DYNAMIC_IMPORT', 'SHELL_SUBPROCESS',
    ]);
  });
  it('only analyzes explicitly selected Python source fields', () => {
    expect(analyzeCode({ language: 'javaScript', pythonCode: 'exec(payload)' }).findings).toEqual([]);
    expect(analyzeCode({ language: 'python', pythonCode: 'exec(payload)' }).findings).toEqual([
      expect.objectContaining({ evidence: expect.objectContaining({ indicator: 'EXEC' }) }),
    ]);
  });
  it('does not analyze Python on a node version that has no language selector', () => {
    // JSON.stringify drops an undefined typeVersion, covering the absent case.
    for (const typeVersion of [1, '2', undefined]) {
      const result = analyzeNodes([{
        id: 'python-1', name: 'Python logic', type: 'n8n-nodes-base.code', typeVersion,
        parameters: { language: 'pythonNative', pythonCode: 'exec(payload)' },
      }]);

      expect(result.findings).toEqual([]);
      expect(result.diagnostics).toEqual([]);
    }
  });
  it('does not treat comments or strings as executable indicators', () => {
    const result = analyzeCode({
      language: 'pythonNative',
      pythonCode: '# exec(payload)\nlabel = "eval(value)"',
    });

    expect(result.findings).toEqual([]);
  });
  it('matches only supported subprocess entry points', () => {
    for (const method of ['run', 'Popen', 'call', 'check_call', 'check_output']) {
      const result = analyzeCode({
        language: 'pythonNative',
        pythonCode: `subprocess.${method}(cmd, shell=True)`,
      });

      expect(result.findings).toHaveLength(1);
      expect(result.findings[0].evidence).toMatchObject({ indicator: 'SHELL_SUBPROCESS', member: method });
    }
  });
  it('reports process execution without requiring shell=True', () => {
    const result = analyzeCode({
      language: 'pythonNative',
      pythonCode: 'subprocess.run(["echo", value])\nsubprocess.call(command, shell=False)\nos.system(command)',
    });

    expect(result.findings.map((finding) => finding.evidence)).toEqual([
      expect.objectContaining({ indicator: 'SHELL_SUBPROCESS', member: 'run' }),
      expect.objectContaining({ indicator: 'SHELL_SUBPROCESS', member: 'call' }),
      expect.objectContaining({ indicator: 'SHELL_SUBPROCESS', member: 'system' }),
    ]);
  });
  it('resolves imported aliases across subprocess and OS process APIs', () => {
    const result = analyzeCode({
      language: 'pythonNative',
      pythonCode: [
        'import subprocess as sp, os as posix',
        'from subprocess import run as execute, Popen',
        'from os import system as shell, execv, spawnv',
        'sp.run([command])', 'posix.popen(command)', 'execute(command)', 'Popen(command, shell=True)',
        'shell(command)', 'execv(path, args)', 'spawnv(posix.P_WAIT, path, args)',
      ].join('\n'),
    });

    expect(result.findings.map((finding) => finding.evidence)).toEqual([
      ...['run', 'popen', 'run', 'Popen', 'system', 'execv', 'spawnv'].map((member) =>
        expect.objectContaining({ indicator: 'SHELL_SUBPROCESS', member })),
    ]);
  });
  it('does not infer canonical modules from unsupported import aliases', () => {
    const result = analyzeCode({ language: 'pythonNative', pythonCode: 'import safe as subprocess\nsubprocess.run(cmd)\nimport safe as os\nos.system(cmd)\nfrom safe import exec\nexec(payload)' });

    expect(result.findings).toEqual([]);
  });
  it('reports bounded static and dynamic import APIs without source evidence', () => {
    const result = analyzeCode({
      language: 'pythonNative',
      pythonCode: 'import importlib as loader\nfrom importlib import import_module as load\nloader.import_module(module_name)\nload("os")\n__import__("sub" + "process")',
    });

    expect(result.findings.map((finding) => finding.evidence.indicator)).toEqual([
      'DYNAMIC_IMPORT', 'DYNAMIC_IMPORT', 'DYNAMIC_IMPORT',
    ]);
    expect(JSON.stringify(result)).not.toContain('module_name');
  });
  it('does not follow later shadowing or function parameters', () => {
    const result = analyzeCode({
      language: 'pythonNative',
      pythonCode: 'import subprocess as sp\nsp.run(command)\ndef sp():\n  return safe\nsp.run(command)\nfrom subprocess import run as execute\nexecute(command)\nexecute = safe\nexecute(command)\ndef local(subprocess, execute):\n  subprocess.run(command)\n  execute(command)',
    });

    expect(result.findings.map((finding) => finding.evidence.member)).toEqual(['run', 'run']);
  });
  it('keeps function-local bindings out of the module scope', () => {
    const result = analyzeCode({ language: 'pythonNative', pythonCode: 'import subprocess as sp\ndef parameter_shadow(sp):\n  sp.run(cmd)\nsp.run(cmd)\ndef assignment_shadow():\n  sp = safe\n  sp.run(cmd)\nsp.run(cmd)' });

    expect(result.findings.map((finding) => finding.evidence.member)).toEqual(['run', 'run']);
  });
  it('follows only bounded static getattr process names', () => {
    const result = analyzeCode({
      language: 'pythonNative',
      pythonCode: 'getattr(subprocess, "run")(command)\ngetattr(os, "system")(command)\ngetattr(subprocess, method)(command)',
    });

    expect(result.findings.map((finding) => finding.evidence.member)).toEqual(['run', 'system']);
  });
  it('does not treat an arbitrary subprocess attribute as a shell entry point', () => {
    const result = analyzeCode({
      language: 'pythonNative',
      pythonCode: 'subprocess.nonsense(cmd, shell=True)',
    });

    expect(result.findings).toEqual([]);
  });
  it('does not attach a member to non-subprocess dynamic execution evidence', () => {
    const result = analyzeCode({ language: 'pythonNative', pythonCode: 'exec(payload)' });

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].evidence).not.toHaveProperty('member');
  });

  it('reports a redacted source diagnostic when selected Python code is absent', () => {
    const result = analyzeCode({ language: 'pythonNative' });

    expect(result.diagnostics).toEqual([
      { code: 'PYTHON_SOURCE_UNAVAILABLE', category: 'SOURCE', location: { path: '/nodes/0' } },
    ]);
  });

  it('reports a safe parser diagnostic without returning malformed source', () => {
    const source = 'def broken(: secret-value';
    const result = analyzeCode({ language: 'python', pythonCode: source });

    expect(result.findings).toEqual([]);
    expect(result.diagnostics).toEqual([
      { code: 'PYTHON_PARSE_FAILED', category: 'PARSER', location: { path: '/nodes/0' } },
    ]);
    expect(JSON.stringify(result)).not.toContain(source);
  });

  it('stops before parsing source above the byte budget', () => {
    const result = analyzeCode({ language: 'pythonNative', pythonCode: 'x'.repeat(MAX_PYTHON_SOURCE_BYTES + 1) });

    expect(result.diagnostics).toEqual([
      { code: 'ANALYSIS_LIMIT_EXCEEDED', category: 'LIMIT', location: { path: '/nodes/0' } },
    ]);
  });

  it('returns exactly ten findings and no limit diagnostic at the per-source cap', () => {
    const result = analyzeCode({ language: 'pythonNative', pythonCode: 'exec(a)\n'.repeat(10) });

    expect(result.findings).toHaveLength(10);
    expect(result.diagnostics).toEqual([]);
  });

  it('emits a source-free limit diagnostic when the per-source cap truncates', () => {
    const result = analyzeCode({ language: 'pythonNative', pythonCode: 'exec(a)\n'.repeat(11) });

    expect(result.findings).toHaveLength(10);
    expect(result.diagnostics).toEqual([
      { code: 'ANALYSIS_LIMIT_EXCEEDED', category: 'LIMIT', location: { path: '/nodes/0' } },
    ]);
    expect(JSON.stringify(result.diagnostics)).not.toContain('exec');
  });

  it('stops CST traversal at the configured node budget', () => {
    const result = analyzeCode({ language: 'pythonNative', pythonCode: 'value\n'.repeat(10_001) });

    expect(result.diagnostics).toContainEqual({
      code: 'ANALYSIS_LIMIT_EXCEEDED', category: 'LIMIT', location: { path: '/nodes/0' },
    });
  });
});
