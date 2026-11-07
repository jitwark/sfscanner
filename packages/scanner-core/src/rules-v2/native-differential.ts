import type { SafeFactV2 } from '../capabilities/scheduler';
import type { ReadonlySourceDocumentV2 } from '../source/source-types';
import type { TriState } from './tri-state';

export type DifferentialResultV2 =
  | Readonly<{ status: 'NOT_ELIGIBLE'; ruleId: 'UNAPPROVED_DOMAIN'; reason: 'SCORING_AUTHORITY' }>
  | Readonly<{ status: 'EQUAL'; ruleId: 'UNAPPROVED_DOMAIN'; native: TriState; declarative: TriState; differences: readonly string[] }>
  | Readonly<{ status: 'DIFFERENT'; ruleId: 'UNAPPROVED_DOMAIN'; native: TriState; declarative: TriState; differences: readonly string[] }>;

export function compareNativeAndDeclarative(
  ruleId: 'UNAPPROVED_DOMAIN',
  _workflow: ReadonlySourceDocumentV2,
  _facts: readonly SafeFactV2[],
): DifferentialResultV2 {
  return Object.freeze({ status: 'NOT_ELIGIBLE', ruleId, reason: 'SCORING_AUTHORITY' });
}
