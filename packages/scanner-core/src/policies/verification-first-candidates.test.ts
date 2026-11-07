import { describe, expect, it } from 'vitest';
import { analyzeWorkflowJavaScript } from '../analyzers/code/javascript-analysis';
import { analyzeWorkflowPython } from '../analyzers/code/python-analysis';
import { redactText } from '../redaction/redaction';
import { parseWorkflowJson } from '../workflow';
import { unknownNodePackagePolicy } from './package-and-webhook-policies';

function workflow(type: string, parameters: Record<string, unknown> = {}) {
  const parsed = parseWorkflowJson(JSON.stringify({
    nodes: [{ id: 'n', name: 'N', type, typeVersion: 2, parameters }],
    connections: {},
  }));
  if (!parsed.ok) throw new Error(parsed.message);
  return parsed.workflow;
}

describe('verification-first candidates (known gaps, not defects)', () => {
  it('C-064: the package policy is a prefix rule, not an authenticity registry', () => {
    // A lookalike that borrows the official namespace is reported as official today. Authenticity
    // needs a pinned official-node registry; the prefix heuristic must not be read as proof.
    expect(unknownNodePackagePolicy.evaluate(workflow('n8n-nodes-base.evilLookalike'))).toEqual([]);
    expect(
      unknownNodePackagePolicy.evaluate(workflow('community.alpha.node'))
        .map((finding) => finding.evidence.nodePackage),
    ).toEqual(['community']);
  });

  it('C-070: encoded tokens are not decoded by redaction', () => {
    const encoded = btoa('sk_live_SYNTHETIC_1234');

    expect(redactText('sk_live_SYNTHETIC_1234')).toBe('[REDACTED]');
    expect(redactText(encoded)).toBe(encoded);
    expect(redactText(encoded)).not.toContain('sk_live_SYNTHETIC_1234');
  });

  it('C-074/C-075: unmodelled JS and Python indicators are not guessed', () => {
    const js = analyzeWorkflowJavaScript(workflow('n8n-nodes-base.code', {
      jsCode: 'const x = Buffer.from(input).toString();',
    }));
    const evalJs = analyzeWorkflowJavaScript(workflow('n8n-nodes-base.code', { jsCode: 'eval(userInput);' }));
    const py = analyzeWorkflowPython(workflow('n8n-nodes-base.code', {
      language: 'python',
      pythonCode: 'os.system("id")',
    }));
    const envPy = analyzeWorkflowPython(workflow('n8n-nodes-base.code', {
      language: 'python',
      pythonCode: "os.environ.get('TOKEN')",
    }));

    // The analyzers are live for the indicators they define, so these are false-negative pins.
    expect(evalJs.findings.map((finding) => finding.evidence.indicator)).toContain('EVAL');
    expect(py.findings.map((finding) => finding.evidence.indicator)).toContain('SHELL_SUBPROCESS');
    // Encoding decode and a Python environment read have no indicator, and none is invented.
    expect(js.findings.map((finding) => finding.evidence.indicator)).not.toContain('BUFFER_DECODE');
    expect(py.findings.map((finding) => finding.evidence.indicator)).not.toContain('OS_SYSTEM');
    expect(envPy.findings.map((finding) => finding.evidence.indicator)).not.toContain('SECRET_ACCESS');
  });
});
