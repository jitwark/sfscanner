import type { FieldFlowPropertiesV1 } from '../../../../../contracts/scanner-v2-field-flow-validation';
import type { ScanLocalWitnessChannelV1 } from './scan-local-flows';
import type { TaintChannelV1 } from './scan-local-state';

export const PROVENANCE_KEYS = Object.freeze(['sourceNodeOrdinal', 'sourceNodeDigest', 'sourceFieldPath', 'taintChannel', 'taintLabels'] as const);
type ActiveTaintChannelV1 = Exclude<TaintChannelV1, 'CONTROL'>;

export function isScanLocalWitnessChannel(value: string): value is ScanLocalWitnessChannelV1 {
  return value === 'DATA' || value === 'CONTROL' || value === 'ERROR'
    || value === 'MODEL' || value === 'TOOL' || value === 'CONTEXT';
}

export function matchingActiveTaintChannel(atom: string, provenance: FieldFlowPropertiesV1,
  summary: FieldFlowPropertiesV1): ActiveTaintChannelV1 | undefined {
  if (atom !== 'CONFIDENTIALITY' && atom !== 'INTEGRITY') return;
  return provenance.taintChannel === atom && summary.taintChannel === atom ? atom : undefined;
}

export function sameOrigin(left: FieldFlowPropertiesV1, right: FieldFlowPropertiesV1): boolean {
  return PROVENANCE_KEYS.every((key) => { const a = left[key], b = right[key];
    return Array.isArray(a) && Array.isArray(b) ? a.length === b.length && a.every((item, index) => item === b[index]) : a === b; });
}
