import type { DescriptionProvenance } from '@hub/contracts';
import type { EnrichmentIdentity } from './enrichment-identity';

export function buildDescriptionProvenance(
  source: 'gemini' | 'upstream' | 'fallback',
  options: { model: string; promptVersion: string; generatedAt: string; identity?: EnrichmentIdentity },
): DescriptionProvenance {
  if (source !== 'gemini') return { source, ...(source === 'fallback' ? { generatedAt: options.generatedAt } : {}) };
  return {
    source,
    model: options.model,
    promptVersion: options.promptVersion,
    generatedAt: options.generatedAt,
    ...(options.identity ? {
      promptHash: options.identity.promptHash,
      schemaVersion: options.identity.schemaVersion,
      workflowHash: options.identity.workflowHash,
    } : {}),
  };
}
