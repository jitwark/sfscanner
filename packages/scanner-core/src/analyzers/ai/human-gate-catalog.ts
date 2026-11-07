const SEND_AND_WAIT_OPERATION = 'sendAndWait';
const SEND_AND_WAIT_NODE_TYPES = new Set([
  'n8n-nodes-base.telegram', 'n8n-nodes-base.whatsApp', 'n8n-nodes-base.googleChat',
  'n8n-nodes-base.slack', 'n8n-nodes-base.discord', 'n8n-nodes-base.gmail',
  'n8n-nodes-base.microsoftTeams', 'n8n-nodes-base.microsoftOutlook',
]);
const WAIT_NODE_TYPE = 'n8n-nodes-base.wait';
const HUMAN_WAIT_RESUME_MODES = new Set(['form']);

export function isCataloguedHumanGate(node: { type: string; parameters: Record<string, unknown> }): boolean {
  if (node.type === WAIT_NODE_TYPE) {
    const resume = node.parameters.resume;
    return typeof resume === 'string' && HUMAN_WAIT_RESUME_MODES.has(resume);
  }
  return node.parameters.operation === SEND_AND_WAIT_OPERATION && SEND_AND_WAIT_NODE_TYPES.has(node.type);
}
