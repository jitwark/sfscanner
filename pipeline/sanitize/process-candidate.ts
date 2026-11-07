import { sanitizeWorkflow } from './redact.js';
import { verifySanitizedWorkflow } from './verify.js';

export type SanitizedCandidate = {
  ok: boolean;
  workflow: unknown;
  errors: string[];
};

/**
 * Sanitize and verify a candidate in one operation. This deliberately has no
 * resume shortcut: a ledger is not a substitute for a materialized sanitized
 * output, and raw acquisition JSON must never flow to packaging.
 */
export function processCandidateWorkflow(input: unknown): SanitizedCandidate {
  const result = sanitizeWorkflow(input);
  if (!result.ok) return { ok: false, workflow: result.workflow, errors: ['sanitizer rejected the workflow'] };
  const verification = verifySanitizedWorkflow(input, result.workflow);
  return {
    ok: verification.ok,
    workflow: result.workflow,
    errors: verification.errors,
  };
}
