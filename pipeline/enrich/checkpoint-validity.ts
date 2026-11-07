import type { Entry } from '@hub/contracts';
import type { DescriptionEvidence } from './description-evidence.js';
import { buildDescriptionEvidence } from './description-evidence.js';
import { validateGeneratedDescription } from './description-contract.js';

export function isCompleteGeneratedCheckpoint(entry: Entry, checkpoint: {
  descriptionSource: Entry['descriptionSource'];
  descriptionProvenance?: Entry['descriptionProvenance'];
  descriptionContent?: Entry['descriptionContent'];
}, workflow?: unknown): boolean {
  const provenance = checkpoint.descriptionProvenance;
  if (!isValidGeneratedContent(entry, checkpoint, workflow)) return false;
  if (!(provenance?.source === 'gemini' && provenance.model && provenance.promptVersion && provenance.promptHash && provenance.schemaVersion && provenance.workflowHash && provenance.generatedAt)) return false;
  return validateGeneratedDescription(checkpoint.descriptionContent, evidenceFor(entry, workflow)).valid;
}

export function isValidGeneratedContent(entry: Entry, checkpoint: {
  descriptionSource: Entry['descriptionSource'];
  descriptionContent?: Entry['descriptionContent'];
}, workflow?: unknown): boolean {
  return checkpoint.descriptionSource === 'generated' && Boolean(checkpoint.descriptionContent) &&
    validateGeneratedDescription(checkpoint.descriptionContent!, evidenceFor(entry, workflow)).valid;
}

function evidenceFor(entry: Entry, workflow?: unknown): DescriptionEvidence {
  if (workflow !== undefined) return buildDescriptionEvidence(workflow);
  const structure = entry.structure;
  return {
    nodeCount: structure?.nodeCount ?? 0, nodeNames: [], nodeTypes: structure?.nodeTypes ?? [],
    integrations: structure?.integrations ?? [], trigger: structure?.trigger ?? 'manual',
    hasCode: structure?.hasCode ?? false, hasAI: structure?.hasAI ?? false,
    hasWebhook: structure?.hasWebhook ?? false,
  };
}
