import { describe, expect, it } from 'vitest';
import type { NormalizedWorkflow, NormalizedWorkflowNode } from '../workflow';
import { codeNodePolicy } from './execution-policies';

function node(id: string, type: string, parameters: Record<string, unknown> = {}): NormalizedWorkflowNode {
  return { id, name: id, type, parameters, sourcePath: `/nodes/${id}` };
}

describe('scanner-core code-node execution policy', () => {
  it('flags both LangChain code-executing node types as review signals', () => {
    const findings = codeNodePolicy.evaluate({
      nodes: [
        node('tool-code', '@n8n/n8n-nodes-langchain.toolCode', { language: 'javaScript', jsCode: 'return query' }),
        node('langchain-code', '@n8n/n8n-nodes-langchain.code', { code: { execute: { code: 'return []' } } }),
      ],
    } as NormalizedWorkflow);

    expect(findings.map((finding) => [finding.severity, finding.evidence.nodeType])).toEqual([
      ['LOW', '@n8n/n8n-nodes-langchain.toolCode'],
      ['LOW', '@n8n/n8n-nodes-langchain.code'],
    ]);
  });

  it('leaves LangChain nodes that execute no code unflagged', () => {
    const findings = codeNodePolicy.evaluate({
      nodes: [
        node('tool-workflow', '@n8n/n8n-nodes-langchain.toolWorkflow'),
        node('manual', 'n8n-nodes-base.manualTrigger'),
      ],
    } as NormalizedWorkflow);

    expect(findings).toHaveLength(0);
  });
});
