import { createHash } from 'node:crypto';
import { projectWorkflowForGemini } from './model-safe-workflow';
import { compareCanonicalStrings } from '@hub/contracts/stable-order';

export const MODEL_INPUT_SANITIZER_VERSION = 'model-safe-workflow-v1';
export const DESCRIPTION_SCHEMA_VERSION = 'description-v1';

export type EnrichmentIdentity = {
  workflowHash: string;
  sanitizerVersion: string;
  promptVersion: string;
  promptHash: string;
  schemaVersion: string;
  model: string;
};

export type IdentityOptions = {
  promptText: string;
  promptVersion: string;
  model: string;
  sanitizerVersion?: string;
  schemaVersion?: string;
};

function canonicalize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => compareCanonicalStrings(a, b))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalize(child)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function hash(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export function buildEnrichmentIdentity(workflow: unknown, options: IdentityOptions): EnrichmentIdentity {
  const projected = projectWorkflowForGemini(workflow);
  return {
    workflowHash: hash(canonicalize(projected)),
    sanitizerVersion: options.sanitizerVersion ?? MODEL_INPUT_SANITIZER_VERSION,
    promptVersion: options.promptVersion,
    promptHash: hash(options.promptText),
    schemaVersion: options.schemaVersion ?? DESCRIPTION_SCHEMA_VERSION,
    model: options.model,
  };
}

export function isCheckpointCompatible(
  checkpoint: { identity?: EnrichmentIdentity },
  identity: EnrichmentIdentity,
): boolean {
  if (!checkpoint.identity) return false;
  return canonicalize(checkpoint.identity) === canonicalize(identity);
}
