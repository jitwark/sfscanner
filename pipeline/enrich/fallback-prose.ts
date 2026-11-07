import type { FactPacket } from './facts';

/**
 * The deterministic description used when the model is unavailable or its
 * output is rejected.
 *
 * Rewritten in phase 6.6 for the readability gate. The previous wording —
 * "initiates the sequence to process payload details efficiently", "a simple
 * complexity profile spanning 3 node steps" — read at Flesch-Kincaid grade
 * 14.3 and therefore **failed the validator it exists to satisfy**. That
 * matters more than it looks: this is the safety net. If every fallback is
 * invalid, a run that falls back at all trips the circuit breaker instead of
 * degrading.
 *
 * The rules are the same ones the model prompt is held to: short sentences,
 * common words, active voice, and nothing asserted that the fact packet does
 * not contain. No timings, no costs, no reliability claims.
 */

function formatIntegrations(integrations: string[]): string {
  if (!integrations || integrations.length === 0) {
    return 'the tools it is set up with';
  }
  if (integrations.length === 1) {
    return `${integrations[0]}`;
  }
  if (integrations.length === 2) {
    return `${integrations[0]} and ${integrations[1]}`;
  }
  return `${integrations.slice(0, -1).join(', ')}, and ${integrations[integrations.length - 1]}`;
}

/** How the workflow starts, in one short sentence pair. */
function openingFor(trigger: string, services: string): { summary: string; opening: string } {
  const lower = (trigger || '').toLowerCase();

  if (lower.includes('webhook')) {
    return {
      summary: `This workflow runs when a web hook gets new data, then works with ${services}.`,
      opening: 'This workflow waits for a web hook. It starts each time new data is sent to it. It reads the data that comes in.',
    };
  }
  if (lower.includes('schedule') || lower.includes('cron')) {
    return {
      summary: `This workflow runs on a set schedule and works with ${services}.`,
      opening: 'This workflow runs on a timer. It starts again at each set time. It looks for new items to work on.',
    };
  }
  if (lower.includes('chat')) {
    return {
      summary: `This workflow replies to chat messages and works with ${services}.`,
      opening: 'This workflow starts when someone sends a chat message. It reads what they wrote. Then it passes it on to the next step.',
    };
  }
  if (lower.includes('email') || lower.includes('mail')) {
    return {
      summary: `This workflow starts from a new email and works with ${services}.`,
      opening: 'This workflow starts when a new email arrives. It reads the email and pulls out the parts it needs.',
    };
  }
  if (lower.includes('form')) {
    return {
      summary: `This workflow runs when someone fills in a form, then works with ${services}.`,
      opening: 'This workflow starts when someone fills in a form. It reads the answers they gave.',
    };
  }
  return {
    summary: `This workflow moves data between steps and works with ${services}.`,
    opening: 'You start this workflow yourself. It then runs its steps in order.',
  };
}

/** What it does in the middle, gated on what the fact packet actually records. */
function middleFor(facts: FactPacket, services: string): string {
  if (facts.capabilities.hasAI) {
    return `It sends the data to an AI model. The model reads it and gives back a result. That result is then used with ${services}.`;
  }
  if (facts.capabilities.hasCode) {
    return `It runs a small piece of code to change the data. The new data is then used with ${services}.`;
  }
  return `It passes the data through ${services}. Each step takes the data from the step before it.`;
}

export function fallbackDescription(facts: FactPacket): { summary: string; description: string } {
  const services = formatIntegrations(facts.integrations);
  const { summary, opening } = openingFor(facts.trigger, services);

  // Node count only. No claim about how long it takes or how well it copes with
  // failure: the fact packet records neither.
  const closing =
    facts.nodeCount === 1
      ? 'It has one step in total. You can open it in n8n to see what it does.'
      : `It has ${facts.nodeCount} steps in total. You can open it in n8n to see each one.`;

  return { summary, description: `${opening}\n\n${middleFor(facts, services)}\n\n${closing}` };
}
