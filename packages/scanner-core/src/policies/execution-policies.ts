import type { ScanPolicy } from '../policy/policy';
import { nodeFinding } from '../policy/policy-helpers';

export const executeCommandPolicy: ScanPolicy = {
  id: 'N8N_EXECUTE_COMMAND',
  name: 'Execute Command node',
  description: 'Flags shell command execution from n8n workflows.',
  evaluate(workflow) {
    return workflow.nodes
      .filter((node) => node.type === 'n8n-nodes-base.executeCommand')
      .map((node) => nodeFinding({
        policyId: 'N8N_EXECUTE_COMMAND',
        title: 'Execute Command node can run shell commands',
        severity: 'CRITICAL',
        node,
        evidence: { nodeType: node.type },
        message: 'This workflow can execute shell commands.',
        explanation:
          'The Execute Command node allows the workflow to launch shell commands from the n8n runtime environment.',
        whyItMatters:
          'Shell command access can cross from workflow automation into the host or worker environment that runs n8n.',
        possibleImpact:
          'A malicious or compromised workflow path could lead to command execution, file access, lateral movement, or service disruption.',
        remediation: 'Remove the Execute Command node or isolate it behind strict approval.',
        remediationSteps: [
          'Remove the Execute Command node when shell access is not explicitly required.',
          'Replace shell logic with a narrow, reviewed integration or managed service call.',
          'If it must remain, isolate the workflow runner and require manual approval before execution.',
        ],
        confidence: 'HIGH',
      }));
  },
};

const codeNodeTypes = new Set([
  'n8n-nodes-base.code',
  'n8n-nodes-base.function',
  'n8n-nodes-base.functionItem',
  '@n8n/n8n-nodes-langchain.code',
  '@n8n/n8n-nodes-langchain.toolCode',
]);

export const codeNodePolicy: ScanPolicy = {
  id: 'N8N_CODE_NODE',
  name: 'Code node',
  description: 'Flags JavaScript, legacy Function, and LangChain code nodes.',
  evaluate(workflow) {
    return workflow.nodes
      .filter((node) => codeNodeTypes.has(node.type))
      .map((node) => nodeFinding({
        policyId: 'N8N_CODE_NODE',
        title: 'Custom code node requires security review',
        severity: 'LOW',
        node,
        evidence: { nodeType: node.type },
        message: 'This workflow contains custom script execution.',
        explanation:
          'Code and legacy Function nodes can transform data with arbitrary JavaScript inside the workflow runtime.',
        whyItMatters:
          'Custom code is harder to audit than declarative node configuration and may handle secrets or external data.',
        possibleImpact:
          'Unsafe code can leak data, mishandle credentials, or create behavior that reviewers cannot understand from node settings alone.',
        remediation: 'Review the code path, remove unnecessary scripting, and require approval.',
        remediationSteps: [
          'Review the node source code for secret access, outbound requests, and unsafe parsing.',
          'Move repeatable logic into a reviewed service or reusable library when possible.',
          'Require approval for changes to custom code nodes in production workflows.',
        ],
        confidence: 'HIGH',
      }));
  },
};
