import { describe, test, expect } from 'vitest';
import { validateDescription } from './validate-description';
import type { FactPacket } from './facts';

const validFacts: FactPacket = {
  id: 'e1',
  title: 'Slack Sync Workflow',
  trigger: 'webhook',
  nodeCount: 3,
  integrations: ['slack'],
  capabilities: { hasCode: false, hasAI: false, hasWebhook: true },
  complexity: 'simple',
  nodeNames: ['slack', 'webhook'],
};

// These fixtures were rewritten when the readability gate landed. The previous
// pair read at Flesch-Kincaid grade 17.8, and this file is where "a valid
// description" is defined, so leaving prose here that the contract rejects would
// have made the fixture lie. Measured across the 2,155 descriptions in the
// current corpus, 99.4% read above grade 9 and every one of the 826 Gemini
// descriptions does, so the describe prompt has to change before the canary —
// recorded in STATUS.md rather than worked around here.
const validSummary = 'This workflow sends a Slack note each time a web hook gets new data from another app.';
const validDescription = `This workflow waits for a web hook to fire. It reads the data that comes in. It checks that the fields it needs are there. Then it builds a short message and sends it to a Slack channel.

You do not need to start it by hand. It runs each time new data arrives. If a field is missing, the run stops and you see why.`;

describe('validateDescription', () => {
  test('passes for valid summary and description', () => {
    const res = validateDescription(validSummary, validDescription, validFacts);
    expect(res).toEqual({ valid: true });
  });

  test('rejects summary shorter than 40 chars', () => {
    const res = validateDescription('Too short summary.', validDescription, validFacts);
    expect(res).toEqual({
      valid: false,
      reason: expect.stringContaining('Summary length'),
      code: 'SUMMARY_LENGTH_INVALID',
    });
  });

  test('rejects summary longer than 280 chars', () => {
    const res = validateDescription('a'.repeat(281), validDescription, validFacts);
    expect(res).toEqual({
      valid: false,
      reason: expect.stringContaining('Summary length'),
      code: 'SUMMARY_LENGTH_INVALID',
    });
  });

  test('rejects description shorter than 200 chars', () => {
    const res = validateDescription(validSummary, 'Too short description.', validFacts);
    expect(res).toEqual({
      valid: false,
      reason: expect.stringContaining('Description length'),
      code: 'DESCRIPTION_LENGTH_INVALID',
    });
  });

  test('rejects description longer than 1600 chars', () => {
    const res = validateDescription(validSummary, 'a'.repeat(1601), validFacts);
    expect(res).toEqual({
      valid: false,
      reason: expect.stringContaining('Description length'),
      code: 'DESCRIPTION_LENGTH_INVALID',
    });
  });

  test('rejects URL in prose', () => {
    const desc = `${validDescription} Visit https://example.com for details.`;
    const res = validateDescription(validSummary, desc, validFacts);
    expect(res).toEqual({
      valid: false,
      reason: 'Text contains forbidden URL',
      code: 'CONTAINS_URL',
    });
  });

  test('rejects licence identifier', () => {
    const desc = `${validDescription} Distributed under the MIT licence terms.`;
    const res = validateDescription(validSummary, desc, validFacts);
    expect(res).toEqual({
      valid: false,
      reason: 'Text contains forbidden licence identifier',
      code: 'CONTAINS_LICENCE',
    });
  });

  test('rejects security verdict word', () => {
    const desc = `${validDescription} This ensures execution is completely secure and audited.`;
    const res = validateDescription(validSummary, desc, validFacts);
    expect(res).toEqual({
      valid: false,
      reason: 'Text contains forbidden security verdict',
      code: 'CONTAINS_SECURITY_VERDICT',
    });
  });

  test('rejects markdown formatting', () => {
    const desc = `${validDescription}\n\n**Note**: Important step details.`;
    const res = validateDescription(validSummary, desc, validFacts);
    expect(res).toEqual({
      valid: false,
      reason: 'Text contains forbidden markdown formatting',
      code: 'CONTAINS_MARKDOWN',
    });
  });

  test('rejects unauthorized integration name', () => {
    const desc = `${validDescription} Integrates directly with Discord for messaging.`;
    const res = validateDescription(validSummary, desc, validFacts);
    expect(res).toEqual({
      valid: false,
      reason: 'Text mentions unauthorized integration: discord',
      code: 'UNAUTHORIZED_INTEGRATION',
    });
  });

  test('accepts the generic noun box', () => {
    const desc = `${validDescription} It puts each value in a box before it sends the note.`;
    expect(validateDescription(validSummary, desc, validFacts)).toEqual({ valid: true });
  });

  test('rejects the branded Box integration when the workflow does not use it', () => {
    const desc = `${validDescription} It sends each file to Box after the checks finish.`;
    expect(validateDescription(validSummary, desc, validFacts)).toEqual({
      valid: false,
      reason: 'Text mentions unauthorized integration: box',
      code: 'UNAUTHORIZED_INTEGRATION',
    });
  });

  test('accepts a product name whose node token has no separator', () => {
    // `googlesheets` is how the workflow records the node; prose has to write
    // "Google Sheets". Comparing the two raw rejected accurate descriptions.
    const facts = { ...validFacts, integrations: ['googlesheets', 'slack'] };
    const desc = `${validDescription} Rows are appended to Google Sheets after each run.`;
    expect(validateDescription(validSummary, desc, facts)).toEqual({ valid: true });
  });

  test('still rejects a product name absent from the workflow', () => {
    const facts = { ...validFacts, integrations: ['googlesheets'] };
    const desc = `${validDescription} Rows are also mirrored into Airtable for review.`;
    expect(validateDescription(validSummary, desc, facts)).toEqual({
      valid: false,
      reason: 'Text mentions unauthorized integration: airtable',
      code: 'UNAUTHORIZED_INTEGRATION',
    });
  });
});
