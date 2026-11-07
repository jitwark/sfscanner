import { describe, expect, it } from 'vitest';
import { parseWorkflowJson, type NormalizedWorkflowNode } from '../../workflow';
import { selectExecutableCode } from './embedded-code-sources';
import { analyzeWorkflowJavaScript } from './javascript-analysis';
import { analyzeWorkflowPython } from './python-analysis';

const LANGCHAIN_TOOL_CODE = '@n8n/n8n-nodes-langchain.toolCode';
const LANGCHAIN_CODE = '@n8n/n8n-nodes-langchain.code';

function node(overrides: Partial<NormalizedWorkflowNode>): NormalizedWorkflowNode {
  return {
    id: 'node-1',
    name: 'Code',
    type: 'n8n-nodes-base.code',
    parameters: {},
    sourcePath: '/nodes/0',
    ...overrides,
  };
}

/** Runs the shipped analyzers over a workflow the way a scan does: silence is the sum of both. */
function analyzeWorkflow(nodes: unknown[]) {
  const parsed = parseWorkflowJson(JSON.stringify({ nodes, connections: {} }));
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) throw new Error(parsed.message);
  const javascript = analyzeWorkflowJavaScript(parsed.workflow), python = analyzeWorkflowPython(parsed.workflow);
  return { findings: [...javascript.findings, ...python.findings], diagnostics: [...javascript.diagnostics, ...python.diagnostics] };
}

describe('scanner-core embedded code selection', () => {
  it('selects the executable JavaScript field for Code v1 and legacy Function nodes', () => {
    expect(selectExecutableCode(node({
      typeVersion: 1,
      parameters: { language: 'pythonNative', jsCode: 'eval(input)', pythonCode: 'exec(input)' },
    }))).toEqual({ kind: 'SOURCE', language: 'javascript', field: 'jsCode', source: 'eval(input)' });

    expect(selectExecutableCode(node({
      type: 'n8n-nodes-base.functionItem',
      typeVersion: 1,
      parameters: { functionCode: 'return eval(item);' },
    }))).toEqual({ kind: 'SOURCE', language: 'javascript', field: 'functionCode', source: 'return eval(item);' });
  });

  it('selects Python only for Code v2 Python languages', () => {
    expect(selectExecutableCode(node({
      typeVersion: 2,
      parameters: { language: 'pythonNative', pythonCode: 'exec(payload)' },
    }))).toEqual({ kind: 'SOURCE', language: 'python', field: 'pythonCode', source: 'exec(payload)' });

    expect(selectExecutableCode(node({
      typeVersion: 2,
      parameters: { language: 'ruby', jsCode: 'eval(input)' },
    }))).toEqual({ kind: 'UNSUPPORTED_VARIANT' });
  });

  it('reports unavailable executable fields and ignores non-code nodes', () => {
    expect(selectExecutableCode(node({ typeVersion: 2, parameters: {} }))).toEqual({
      kind: 'SOURCE_UNAVAILABLE', language: 'javascript', field: 'jsCode',
    });
    expect(selectExecutableCode(node({ type: 'n8n-nodes-base.httpRequest' }))).toEqual({ kind: 'NOT_A_CODE_NODE' });
  });

  it('accepts the normalized package workflow shape', () => {
    const parsed = parseWorkflowJson(JSON.stringify({
      nodes: [{ name: 'Code', type: 'n8n-nodes-base.code', typeVersion: 2, parameters: { jsCode: '' } }],
      connections: {},
    }));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(selectExecutableCode(parsed.workflow.nodes[0]!)).toMatchObject({ kind: 'SOURCE' });
  });
});

describe('scanner-core LangChain code-node coverage', () => {
  it('selects the executable field of a Code Tool for both languages', () => {
    expect(selectExecutableCode(node({
      type: LANGCHAIN_TOOL_CODE,
      typeVersion: 1.3,
      parameters: { language: 'javaScript', jsCode: 'eval(input)', pythonCode: 'exec(payload)' },
    }))).toEqual({ kind: 'SOURCE', language: 'javascript', field: 'jsCode', source: 'eval(input)' });

    expect(selectExecutableCode(node({
      type: LANGCHAIN_TOOL_CODE,
      typeVersion: 1.3,
      parameters: { language: 'python', jsCode: 'eval(input)', pythonCode: 'exec(payload)' },
    }))).toEqual({ kind: 'SOURCE', language: 'python', field: 'pythonCode', source: 'exec(payload)' });

    expect(selectExecutableCode(node({
      type: LANGCHAIN_TOOL_CODE,
      parameters: { jsCode: 'eval(input)' },
    }))).toEqual({ kind: 'SOURCE', language: 'javascript', field: 'jsCode', source: 'eval(input)' });
  });

  it('reports an unrecognized Code Tool language instead of ignoring the node', () => {
    expect(selectExecutableCode(node({
      type: LANGCHAIN_TOOL_CODE,
      parameters: { language: 'ruby', jsCode: 'eval(input)' },
    }))).toEqual({ kind: 'UNSUPPORTED_VARIANT' });

    expect(selectExecutableCode(node({
      type: LANGCHAIN_TOOL_CODE,
      parameters: { language: 7, jsCode: 'eval(input)' },
    }))).toEqual({ kind: 'UNSUPPORTED_VARIANT' });
  });

  it('selects the configured LangChain Code islands and diagnoses shapes it cannot select', () => {
    expect(selectExecutableCode(node({
      type: LANGCHAIN_CODE,
      typeVersion: 1,
      parameters: { code: { execute: { code: 'eval(input)' } } },
    }))).toEqual({ kind: 'SOURCE', language: 'javascript', field: '/code/execute/code', source: 'eval(input)' });

    expect(selectExecutableCode(node({
      type: LANGCHAIN_CODE,
      typeVersion: 1,
      parameters: { code: { supplyData: { code: 'eval(payload)' } } },
    }))).toEqual({ kind: 'SOURCE', language: 'javascript', field: '/code/supplyData/code', source: 'eval(payload)' });

    // Two executable islands cannot both be selected, so the node degrades loudly instead of dropping one.
    expect(selectExecutableCode(node({
      type: LANGCHAIN_CODE,
      typeVersion: 1,
      parameters: { code: { execute: { code: 'eval(input)' }, supplyData: { code: 'eval(payload)' } } },
    }))).toEqual({ kind: 'UNSUPPORTED_VARIANT' });

    for (const code of ['eval(input)', { execute: { code: 42 } }, { execute: [] }]) {
      expect(selectExecutableCode(node({ type: LANGCHAIN_CODE, typeVersion: 1, parameters: { code } })))
        .toEqual({ kind: 'UNSUPPORTED_VARIANT' });
    }

    expect(selectExecutableCode(node({ type: LANGCHAIN_CODE, typeVersion: 1, parameters: { code: {} } })))
      .toEqual({ kind: 'SOURCE_UNAVAILABLE', language: 'javascript', field: '/code' });
  });

  it('leaves LangChain nodes that execute no code alone', () => {
    expect(selectExecutableCode(node({ type: '@n8n/n8n-nodes-langchain.toolWorkflow' })))
      .toEqual({ kind: 'NOT_A_CODE_NODE' });
  });

  it('analyzes Code Tool workflows instead of reporting them COMPLETE', () => {
    const javascript = analyzeWorkflow([{
      id: 'tool-js', name: 'Code Tool', type: LANGCHAIN_TOOL_CODE, typeVersion: 1.3,
      parameters: { language: 'javaScript', jsCode: "require('child_process').execSync('id')" },
    }]);
    expect(javascript.findings.map((finding) => finding.evidence.indicator).sort())
      .toEqual(['CHILD_PROCESS_METHOD', 'CHILD_PROCESS_REQUIRE']);

    const python = analyzeWorkflow([{
      id: 'tool-py', name: 'Code Tool', type: LANGCHAIN_TOOL_CODE, typeVersion: 1.3,
      parameters: { language: 'python', pythonCode: 'import subprocess\nsubprocess.run(command)' },
    }]);
    expect(python.findings.map((finding) => [finding.evidence.indicator, finding.evidence.member]))
      .toEqual([['SHELL_SUBPROCESS', 'run']]);
  });

  it('does not invent findings for LangChain code nodes that execute benign code', () => {
    const result = analyzeWorkflow([{
      id: 'tool-benign', name: 'Code Tool', type: LANGCHAIN_TOOL_CODE, typeVersion: 1.3,
      parameters: { language: 'javaScript', jsCode: 'return query.toUpperCase()' },
    }]);
    expect(result).toEqual({ findings: [], diagnostics: [] });
  });

  it('analyzes LangChain Code workflows and diagnoses the shapes it cannot analyze', () => {
    const execute = analyzeWorkflow([{
      id: 'code-execute', name: 'LangChain Code', type: LANGCHAIN_CODE, typeVersion: 1,
      parameters: { code: { execute: { code: "require('child_process').execSync('id')" } } },
    }]);
    expect(execute.findings.map((finding) => finding.evidence.indicator).sort())
      .toEqual(['CHILD_PROCESS_METHOD', 'CHILD_PROCESS_REQUIRE']);

    const supplyData = analyzeWorkflow([{
      id: 'code-supply', name: 'LangChain Code', type: LANGCHAIN_CODE, typeVersion: 1,
      parameters: { code: { supplyData: { code: "require('child_process').execSync('id')" } } },
    }]);
    expect(supplyData.findings.map((finding) => finding.evidence.indicator).sort())
      .toEqual(['CHILD_PROCESS_METHOD', 'CHILD_PROCESS_REQUIRE']);

    const both = analyzeWorkflow([{
      id: 'code-both', name: 'LangChain Code', type: LANGCHAIN_CODE, typeVersion: 1,
      parameters: { code: { execute: { code: 'eval(input)' }, supplyData: { code: 'eval(payload)' } } },
    }]);
    expect(both).toEqual({
      findings: [],
      diagnostics: [{ code: 'UNSUPPORTED_CODE_NODE_VARIANT', category: 'SOURCE', location: { path: '/nodes/0' } }],
    });
  });
});
