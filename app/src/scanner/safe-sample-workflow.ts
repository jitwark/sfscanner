/** A small, synthetic workflow for trying the scanner without sharing a file. */
export const SAFE_SAMPLE_WORKFLOW = JSON.stringify({
  name: 'SecureFlow safe sample',
  nodes: [
    {
      id: 'sample-trigger',
      name: 'Manual Trigger',
      type: 'n8n-nodes-base.manualTrigger',
      typeVersion: 1,
      position: [0, 0],
      parameters: {},
    },
    {
      id: 'sample-finish',
      name: 'Finish',
      type: 'n8n-nodes-base.noOp',
      typeVersion: 1,
      position: [240, 0],
      parameters: {},
    },
  ],
  connections: {
    'Manual Trigger': {
      main: [[{ node: 'Finish', type: 'main', index: 0 }]],
    },
  },
}, null, 2);
