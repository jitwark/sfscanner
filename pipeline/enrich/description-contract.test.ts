import { describe, expect, test } from 'vitest';
import { buildDescriptionEvidence } from './description-evidence';
import { validateGeneratedDescription } from './description-contract';

const workflow = {
  nodes: [
    { name: 'Receive form', type: 'n8n-nodes-base.webhook', parameters: {} },
    { name: 'Send Slack note', type: 'n8n-nodes-base.slack', parameters: {} },
  ],
  connections: {},
};

const valid = {
  headline: 'Send new form details to your team',
  summary: 'This workflow receives a form event, checks the data, and sends a clear Slack note so a team can act on it.',
  outcome: 'The person who fills in the form gets a quick handoff from the form to the team channel. The note keeps the useful fields together, so the next person can see what needs attention without opening the workflow first.',
  beforeAfter: {
    before: 'Form answers sit in the incoming event and can be easy to miss when nobody watches the form at the right time.',
    after: 'The workflow turns each event into a Slack note with the fields that the next person needs to read and act on.',
  },
  exampleScenario: 'Example: imagine a visitor fills in a request form. The webhook receives the answers, and the Slack step posts a note for the team. This is a teaching example; the exact field names depend on the workflow file.',
  howItWorks: [
    'The webhook waits for a new form event and starts the workflow when data arrives.',
    'The workflow passes the incoming fields to the next step without inventing new values.',
    'The Slack step turns the useful fields into a message for the team channel.',
    'The run ends after the message is ready for the team to read and follow up on.',
  ],
  limitations: [
    'The workflow file does not show who should read the Slack channel or how they should reply.',
    'The example names a possible form request; it does not claim that this exact request exists in your data.',
  ],
  audience: 'This is for a person who wants a plain view of how form data reaches a team message before importing it into n8n. Read the sections in order if you are new to automation. Start with the outcome, then compare the before and after view. Use the example only as a simple picture of the data path. The actual fields, channel names, and team rules still come from the workflow and your own setup. The page explains what can be seen in the file, while the readiness panel lists the changes you may need to make before a real run.',
};

describe('validateGeneratedDescription', () => {
  test('accepts a verbose, structured, grounded description', () => {
    expect(validateGeneratedDescription(valid, buildDescriptionEvidence(workflow))).toEqual({ valid: true, value: valid });
  });

  test('rejects missing sections and thin output', () => {
    const result = validateGeneratedDescription({ summary: 'Too short.' }, buildDescriptionEvidence(workflow));
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.errors.join(' ')).toMatch(/headline|outcome|300 words/i);
  });

  test('rejects an unlabeled invented example and an unsupported integration', () => {
    const result = validateGeneratedDescription({
      ...valid,
      exampleScenario: 'A customer sends a request and it is handled.',
      howItWorks: [...valid.howItWorks, 'The workflow also sends the data to Airtable for review.'],
    }, buildDescriptionEvidence(workflow));
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.errors.join(' ')).toMatch(/example|Airtable/i);
  });

  test('allows a standalone time unit but rejects a concrete timing promise', () => {
    const neutral = validateGeneratedDescription({
      ...valid,
      audience: `${valid.audience} The file names seconds as a unit but gives no timing value.`,
    }, buildDescriptionEvidence(workflow));
    expect(neutral.valid).toBe(true);
    const concrete = validateGeneratedDescription({
      ...valid,
      outcome: `${valid.outcome} The workflow completes in 30 seconds.`,
    }, buildDescriptionEvidence(workflow));
    expect(concrete.valid).toBe(false);
  });

  test('allows a visible proper name that contains a licence token but rejects a licence claim', () => {
    const properName = validateGeneratedDescription({
      ...valid,
      outcome: `${valid.outcome} The visible RSS label is MIT Tech Review; this is a node name, not a rights statement.`,
    }, buildDescriptionEvidence(workflow));
    expect(properName.valid).toBe(true);
    const licenceClaim = validateGeneratedDescription({
      ...valid,
      outcome: `${valid.outcome} The workflow is distributed under the MIT licence.`,
    }, buildDescriptionEvidence(workflow));
    expect(licenceClaim.valid).toBe(false);
  });

  test('does not reject an ordinary noun that matches an integration name', () => {
    const result = validateGeneratedDescription({
      ...valid,
      outcome: `${valid.outcome} The example keeps the visible fields together in a box for the next person to inspect.`,
    }, buildDescriptionEvidence(workflow));
    expect(result.valid).toBe(true);
  });
});
