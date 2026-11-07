import { describe, expect, test } from 'vitest';
import { deriveResilience, findUnverifiableClaim } from './unverifiable-claims';
import { countSyllables, readability, isReadable } from './readability';

const configured = {
  retryOnFail: true,
  continueOnFail: false,
  alwaysOutputData: false,
  hasErrorWorkflow: false,
};
const none = {
  retryOnFail: false,
  continueOnFail: false,
  alwaysOutputData: false,
  hasErrorWorkflow: false,
};

describe('duration claims are banned outright', () => {
  test.each([
    'The whole run takes about twelve minutes end to end.',
    'It completes in 30 seconds once the credentials are set.',
    'Expect this to finish in 2 hours for a large sheet.',
    'Processing takes a few minutes per batch.',
    'The workflow runs in 500 milliseconds.',
  ])('rejects %j', (text) => {
    expect(findUnverifiableClaim(text)).toBe('DURATION_CLAIM');
  });

  test('does not reject a node count that happens to precede a noun', () => {
    expect(findUnverifiableClaim('The workflow has 12 nodes and 3 triggers.')).toBeNull();
  });
});

describe('cost claims are banned', () => {
  test.each([
    'Running this costs about $3 per month.',
    'Each execution costs 2 cents in tokens.',
    'Budget roughly £5 for a thousand runs.',
  ])('rejects %j', (text) => {
    expect(findUnverifiableClaim(text)).toBe('COST_CLAIM');
  });
});

describe('resilience claims are gated on workflow settings', () => {
  const claim = 'A failure on one network does not stop the others.';

  test('rejected when the workflow configures no failure handling', () => {
    expect(findUnverifiableClaim(claim, none)).toBe('UNGROUNDED_RESILIENCE_CLAIM');
  });

  test('rejected when no resilience facts were supplied at all', () => {
    // Absent evidence must never read as permission.
    expect(findUnverifiableClaim(claim)).toBe('UNGROUNDED_RESILIENCE_CLAIM');
  });

  test('allowed when the workflow actually sets retryOnFail', () => {
    expect(findUnverifiableClaim(claim, configured)).toBeNull();
  });

  test('allowed when an error workflow is configured', () => {
    expect(findUnverifiableClaim('The workflow retries failed requests.', {
      ...none,
      hasErrorWorkflow: true,
    })).toBeNull();
  });
});

describe('filler phrases', () => {
  test.each([
    "In today's fast-paced world, automation matters.",
    'This solution will revolutionize your operations.',
    'Leverage the power of AI to do more.',
    'Take your marketing to the next level.',
  ])('rejects %j', (text) => {
    expect(findUnverifiableClaim(text)).toBe('FILLER_PHRASE');
  });

  test('accepts plain grounded prose', () => {
    expect(
      findUnverifiableClaim('The workflow receives a webhook and posts a message to Slack.'),
    ).toBeNull();
  });
});

describe('deriveResilience reads the workflow rather than guessing', () => {
  test('reports nothing configured for an empty or hostile workflow', () => {
    expect(deriveResilience(null)).toEqual(none);
    expect(deriveResilience('not a workflow')).toEqual(none);
    expect(deriveResilience({})).toEqual(none);
    expect(deriveResilience({ nodes: 'not an array' })).toEqual(none);
  });

  test('detects per-node retry and continue settings', () => {
    expect(
      deriveResilience({
        nodes: [{ type: 'a', retryOnFail: true }, { type: 'b', continueOnFail: true }, null],
      }),
    ).toEqual({
      retryOnFail: true,
      continueOnFail: true,
      alwaysOutputData: false,
      hasErrorWorkflow: false,
    });
  });

  test('detects a configured error workflow, and ignores an empty one', () => {
    expect(deriveResilience({ settings: { errorWorkflow: 'wf-9' } }).hasErrorWorkflow).toBe(true);
    expect(deriveResilience({ settings: { errorWorkflow: '' } }).hasErrorWorkflow).toBe(false);
  });
});

describe('readability', () => {
  test('counts syllables with the silent-e correction', () => {
    expect(countSyllables('nine')).toBe(1);
    expect(countSyllables('automation')).toBe(4);
    expect(countSyllables('simple')).toBe(2);
    expect(countSyllables('')).toBe(0);
  });

  test('scores plain short prose below the grade ceiling', () => {
    const plain =
      'This workflow gets a web hook. It reads the data. It sends a note to Slack. You can set it up in the app.';
    expect(isReadable(plain)).toBe(true);
  });

  test('rejects dense multi-clause prose above the ceiling', () => {
    const dense =
      'Utilizing sophisticated orchestration methodologies, this comprehensive automation infrastructure systematically facilitates the interoperability of heterogeneous organizational data repositories whilst concurrently maintaining transactional integrity across asynchronous execution boundaries and distributed computational environments.';
    expect(isReadable(dense)).toBe(false);
  });

  test('does not divide by zero on empty text', () => {
    expect(readability('').grade).toBe(0);
  });

  test('is deterministic', () => {
    const text = 'The workflow reads a sheet and writes a row.';
    expect(readability(text)).toEqual(readability(text));
  });
});
