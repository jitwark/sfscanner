/**
 * Claims prose may not make because nothing in the workflow JSON supports them.
 *
 * This is the single largest risk in the content phase. The specimen page that
 * motivated the plan asserted a workflow "takes about twelve minutes" and that
 * "a failure on one network does not stop the others". Neither is derivable
 * from a workflow file. Both read as authoritative.
 *
 * The rule adopted in `phase-6-hardening.md` section 3: prose may assert only
 * what the analyser computed. This module enforces the three classes that rule
 * names, plus the filler blocklist.
 */

/**
 * Duration claims are banned outright rather than gated.
 *
 * There is no gate that could pass one. Runtime depends on the connected
 * accounts, the data volume, network latency, and rate limits — none of which
 * appear in the JSON. A workflow with four nodes may take 200ms or an hour.
 */
const DURATION_CLAIM =
  /\b(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|a few|several)\s*[-\s]?(?:milli)?(?:seconds?|secs?|minutes?|mins?|hours?|hrs?|days?)\b|\b(?:takes|runs in|completes in|finishes in|within)\s+(?:about\s+|around\s+|roughly\s+|under\s+|less than\s+)?\d/i;

/**
 * Cost figures are banned unless the analyser produced them, and it does not.
 * Token pricing changes, and the model behind an AI node is the reader's choice.
 */
const COST_CLAIM =
  /(?:[$£€]\s?\d|\b\d+\s*(?:cents?|dollars?|euros?)\b|\bcosts?\s+(?:about|around|roughly|approximately)?\s*[$£€]?\d|\bper\s+(?:month|run|execution)\s+(?:cost|price))/i;

/**
 * Failure-isolation and retry claims are gated, not banned: n8n records these
 * as real node settings, so prose may state them when they are actually set.
 */
const RESILIENCE_CLAIM =
  /\b(?:retr(?:y|ies|ied)|does not stop|doesn't stop|continues? (?:on|after) (?:an? )?(?:error|failure)|failure (?:on|in) one|isolat(?:ed|es|ion)|fault[- ]tolerant|automatically recovers?)\b/i;

/**
 * Phrases that say nothing. A description opening "In today's fast-paced world"
 * is filler that survives every other check because it asserts no fact at all.
 */
const FILLER = [
  "in today's fast-paced",
  'in the modern world',
  'leverage the power of',
  'game[- ]changer',
  'seamlessly integrates',
  'revolutioni[sz]e',
  'unlock the (?:full )?potential',
  'take your .{0,30} to the next level',
  'in this day and age',
  'cutting[- ]edge solution',
  'robust and scalable solution',
  'the sky is the limit',
];

const FILLER_PATTERN = new RegExp(FILLER.join('|'), 'i');

/** What the workflow actually records about its own failure handling. */
export type ResilienceFacts = {
  retryOnFail: boolean;
  continueOnFail: boolean;
  alwaysOutputData: boolean;
  hasErrorWorkflow: boolean;
};

export type ClaimViolation =
  | 'DURATION_CLAIM'
  | 'COST_CLAIM'
  | 'UNGROUNDED_RESILIENCE_CLAIM'
  | 'FILLER_PHRASE';

/**
 * Returns the first violated class, or `null`.
 *
 * `resilience` is optional so a caller that has not computed it yet fails
 * closed: with no evidence that retry or continue-on-fail is configured, a
 * resilience claim is ungrounded. Absent facts never read as permission.
 */
export function findUnverifiableClaim(
  text: string,
  resilience?: ResilienceFacts,
): ClaimViolation | null {
  if (DURATION_CLAIM.test(text)) return 'DURATION_CLAIM';
  if (COST_CLAIM.test(text)) return 'COST_CLAIM';

  if (RESILIENCE_CLAIM.test(text)) {
    const grounded =
      resilience !== undefined &&
      (resilience.retryOnFail ||
        resilience.continueOnFail ||
        resilience.alwaysOutputData ||
        resilience.hasErrorWorkflow);
    if (!grounded) return 'UNGROUNDED_RESILIENCE_CLAIM';
  }

  if (FILLER_PATTERN.test(text)) return 'FILLER_PHRASE';

  return null;
}

/**
 * Reads the resilience settings out of a workflow.
 *
 * Kept beside the rules that consume it so the gate and its evidence cannot
 * drift apart. Untrusted input: anything unexpected reads as "not configured",
 * which is the fail-closed direction.
 */
export function deriveResilience(workflow: unknown): ResilienceFacts {
  const facts: ResilienceFacts = {
    retryOnFail: false,
    continueOnFail: false,
    alwaysOutputData: false,
    hasErrorWorkflow: false,
  };

  if (!workflow || typeof workflow !== 'object') return facts;
  const record = workflow as Record<string, unknown>;

  const settings = record.settings;
  if (settings && typeof settings === 'object') {
    const errorWorkflow = (settings as Record<string, unknown>).errorWorkflow;
    facts.hasErrorWorkflow = typeof errorWorkflow === 'string' && errorWorkflow.length > 0;
  }

  const nodes = Array.isArray(record.nodes) ? record.nodes : [];
  for (const node of nodes) {
    if (!node || typeof node !== 'object') continue;
    const entry = node as Record<string, unknown>;
    if (entry.retryOnFail === true) facts.retryOnFail = true;
    if (entry.continueOnFail === true) facts.continueOnFail = true;
    if (entry.alwaysOutputData === true) facts.alwaysOutputData = true;
  }

  return facts;
}
