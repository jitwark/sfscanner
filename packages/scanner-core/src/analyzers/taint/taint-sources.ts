import type { NormalizedWorkflow } from '../../workflow';
import { bottomTaintState, createTaintState, isTainted, type TaintLabel, type TaintState } from './taint-lattice';

const TAINT_SOURCE_RULES: ReadonlyMap<string, readonly TaintLabel[]> = new Map([
  ['n8n-nodes-base.webhook', ['WEBHOOK_BODY', 'WEBHOOK_QUERY', 'WEBHOOK_HEADER']],
  ['n8n-nodes-base.formTrigger', ['WEBHOOK_BODY']],
  ['n8n-nodes-base.emailReadImap', ['INBOUND_MESSAGE']],
  ['n8n-nodes-base.telegramTrigger', ['INBOUND_MESSAGE']],
  ['@n8n/n8n-nodes-langchain.chatTrigger', ['INBOUND_MESSAGE']],
  ['n8n-nodes-base.httpRequest', ['EXTERNAL_HTTP_RESPONSE']],
  ['n8n-nodes-base.extractFromFile', ['EXTERNAL_FILE']],
  ['n8n-nodes-base.readWriteFile', ['EXTERNAL_FILE']],
  ['n8n-nodes-base.readBinaryFile', ['EXTERNAL_FILE']],
]);

const NON_DATA_TRIGGER_TYPES = new Set([
  'n8n-nodes-base.manualTrigger',
  'n8n-nodes-base.scheduleTrigger',
  'n8n-nodes-base.n8nTrigger',
]);

const AI_OUTPUT_NODE_TYPES = new Set([
  '@n8n/n8n-nodes-langchain.agent', '@n8n/n8n-nodes-langchain.chainLlm',
]);

export function seedTaintStates(workflow: NormalizedWorkflow): TaintState[] {
  return workflow.nodes.map((node) => {
    const labels = TAINT_SOURCE_RULES.get(node.type);
    return labels === undefined ? bottomTaintState : createTaintState(labels, []);
  });
}

export function isTaintSourceType(nodeType: string): boolean {
  return TAINT_SOURCE_RULES.has(nodeType);
}

/** Returns a frozen snapshot from the existing source registry; absent types remain unknown. */
export function taintSourceLabelsFor(nodeType: string): readonly TaintLabel[] | undefined {
  const labels = TAINT_SOURCE_RULES.get(nodeType);
  return labels === undefined ? undefined : Object.freeze([...labels]);
}

export function isUnsupportedTaintTriggerType(nodeType: string): boolean {
  return nodeType.toLowerCase().endsWith('trigger')
    && !TAINT_SOURCE_RULES.has(nodeType)
    && !NON_DATA_TRIGGER_TYPES.has(nodeType);
}

export function amplifyTaint(nodeType: string, state: TaintState): TaintState {
  if (!AI_OUTPUT_NODE_TYPES.has(nodeType) || !isTainted(state)) return state;
  return createTaintState([...state.labels, 'AI_MODEL_OUTPUT'], state.sanitizedFor);
}
