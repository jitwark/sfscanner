import type { Entry } from '@hub/contracts';
import type { EnrichmentIdentity } from './enrichment-identity.js';
import { validateGeneratedDescription } from './description-contract.js';
import { buildDescriptionEvidence } from './description-evidence.js';

export type BatchVerification = {
  ok: boolean;
  errors: Array<{ id?: string; code: string; message: string }>;
  accepted: string[];
};

function error(code: string, message: string, id?: string) {
  return id ? { id, code, message } : { code, message };
}

function sameIdentity(entry: Entry, expected: EnrichmentIdentity): boolean {
  const provenance = entry.descriptionProvenance;
  return Boolean(
    provenance?.source === 'gemini' &&
    provenance.model === expected.model &&
    provenance.promptVersion === expected.promptVersion &&
    provenance.promptHash === expected.promptHash &&
    provenance.schemaVersion === expected.schemaVersion &&
    provenance.workflowHash === expected.workflowHash &&
    provenance.generatedAt,
  );
}

function evidenceFor(entry: Entry, workflow?: unknown) {
  if (workflow !== undefined) return buildDescriptionEvidence(workflow);
  const structure = entry.structure;
  return {
    nodeCount: structure?.nodeCount ?? 0,
    nodeNames: [],
    nodeTypes: structure?.nodeTypes ?? [],
    integrations: structure?.integrations ?? [],
    trigger: structure?.trigger ?? 'manual',
    hasCode: structure?.hasCode ?? false,
    hasAI: structure?.hasAI ?? false,
    hasWebhook: structure?.hasWebhook ?? false,
  };
}

export function verifyEnrichmentBatch(input: {
  entries: Entry[];
  results: Entry[];
  identities: ReadonlyMap<string, EnrichmentIdentity>;
  workflowsById?: ReadonlyMap<string, unknown>;
}): BatchVerification {
  const errors: BatchVerification['errors'] = [];
  const accepted: string[] = [];
  const expectedIds = input.entries.map((entry) => entry.id);
  const seen = new Set<string>();

  for (const result of input.results) {
    if (seen.has(result.id)) errors.push(error('duplicate_id', 'The model result contains a duplicate entry ID.', result.id));
    seen.add(result.id);
  }
  if (input.results.length !== input.entries.length) errors.push(error('count_mismatch', `Expected ${input.entries.length} results but received ${input.results.length}.`));
  for (let index = 0; index < expectedIds.length; index++) {
    const expectedId = expectedIds[index];
    const result = input.results[index];
    if (!result) {
      errors.push(error('missing_result', 'The batch result is missing.', expectedId));
      continue;
    }
    if (result.id !== expectedId) errors.push(error('order_mismatch', `Expected result ${expectedId} at ordinal ${index}.`, result.id));
    const expectedIdentity = input.identities.get(expectedId);
    if (!expectedIdentity || !sameIdentity(result, expectedIdentity)) {
      errors.push(error('identity_mismatch', 'Generated provenance does not match the workflow and prompt identity.', expectedId));
    }
    if (result.descriptionSource === 'fallback') errors.push(error('fallback_output', 'Fallback output is never accepted in an enrichment batch.', expectedId));
    if (result.descriptionSource !== 'generated' || !result.descriptionContent) {
      errors.push(error('missing_structured_content', 'The result does not contain structured generated content.', expectedId));
      continue;
    }
    const validation = validateGeneratedDescription(
      result.descriptionContent,
      evidenceFor(result, input.workflowsById?.get(result.id)),
    );
    if (!validation.valid) errors.push(error('description_validation', validation.errors.join('; '), expectedId));
    if (!errors.some((item) => item.id === expectedId)) accepted.push(expectedId);
  }
  return { ok: errors.length === 0, errors, accepted };
}
