/** JSON Schema consumed by structured-output adapters and prompt tests. */
export const DESCRIPTION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['headline', 'summary', 'outcome', 'beforeAfter', 'exampleScenario', 'howItWorks', 'limitations', 'audience'],
  properties: {
    headline: { type: 'string' },
    summary: { type: 'string' },
    outcome: { type: 'string' },
    beforeAfter: {
      type: 'object',
      additionalProperties: false,
      required: ['before', 'after'],
      properties: { before: { type: 'string' }, after: { type: 'string' } },
    },
    exampleScenario: { type: 'string' },
    howItWorks: { type: 'array', items: { type: 'string' } },
    limitations: { type: 'array', items: { type: 'string' } },
    audience: { type: 'string' },
  },
} as const;
