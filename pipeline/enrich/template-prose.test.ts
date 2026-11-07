import { describe, expect, test } from 'vitest';
import { isTemplateProse } from './describe';

describe('isTemplateProse', () => {
  test('refuses the aggregator template shapes seen in the production corpus', () => {
    const templated = [
      'Automated workflow: Receive updates when a new account is added by an admin.',
      'Production-ready workflow: Send a cocktail recipe every day via a Telegram',
      'n8n workflow: Stickynote Workflow. This workflow integrates 11 different services.',
      'Workflow: Acuityschedulingtrigger Workflow.',
      'A tidy summary sentence. This workflow processes data and performs automated tasks.',
    ];
    for (const text of templated) {
      expect(isTemplateProse(text), text).toBe(true);
    }
  });

  test('accepts prose that describes what the workflow actually does', () => {
    const written = [
      'Triggered by form events, this integration routes incoming lead details into Pipedrive CRM.',
      'Monitors an inbox and files attachments into Google Drive, grouped by sender.',
      'Runs nightly, reads rows from Postgres, and posts a digest to Slack.',
    ];
    for (const text of written) {
      expect(isTemplateProse(text), text).toBe(false);
    }
  });
});
