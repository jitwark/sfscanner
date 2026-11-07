import { readFieldFlowPropertiesV1, validateFieldFlowSubject } from '../../../../../contracts/scanner-v2-field-flow-validation';
import { validateFieldFlowCoherenceV1 } from '../../../../../contracts/scanner-v2-field-flow-coherence';
import type { SafeFactV2 } from '../../../../../contracts/scanner-v2-evidence';
import { createFactId } from '../../result-v2/identities';
import type { FlowCoverageDerivationV1 } from './flow-coverage-derivation';
import {
  meterFlowCoveragePublicationV1, type FlowCoveragePublicationFailureReasonV1,
} from './flow-coverage-publication-budget';
import type { ScanLocalChargeV1 } from './scan-local-state';

export type FlowCoveragePublicationV1 =
  | Readonly<{ ok: true; fact: SafeFactV2; facts: readonly SafeFactV2[] }>
  | Readonly<{ ok: false; reason: FlowCoveragePublicationFailureReasonV1 }>;

const fail = (reason: FlowCoveragePublicationFailureReasonV1): FlowCoveragePublicationV1 => Object.freeze({ ok: false, reason });

export function publishFlowCoverageV1(input: Readonly<{
  coverage: FlowCoverageDerivationV1; existingFacts: readonly SafeFactV2[]; semanticSha256: string;
}>, charge: ScanLocalChargeV1): FlowCoveragePublicationV1 {
  const metered = meterFlowCoveragePublicationV1(input, charge);
  if (!metered.ok) return metered;
  if (metered.hasCoverage) return fail('INCOHERENT_EVIDENCE');
  const properties = readFieldFlowPropertiesV1('dataflow.coverage.v1', metered.properties);
  if (properties === undefined) return fail('INVALID_PROPERTY');
  if (properties.capabilityId !== 'taint-integrity') return fail('INCOHERENT_EVIDENCE');
  const subject = Object.freeze({ kind: 'WORKFLOW' as const });
  if (!validateFieldFlowSubject('dataflow.coverage.v1', subject, properties)) return fail('INVALID_SUBJECT');
  const draft = Object.freeze({ kind: 'dataflow.coverage.v1' as const, subject, properties });
  try {
    const factId = createFactId(draft, { semanticSha256: input.semanticSha256 });
    const fact: SafeFactV2 = Object.freeze({ ...draft, factId });
    const facts = Object.freeze([...metered.facts, fact]);
    return validateFieldFlowCoherenceV1(facts, 'taint-integrity')
      ? Object.freeze({ ok: true, fact, facts }) : fail('INCOHERENT_EVIDENCE');
  } catch { return fail('INCOHERENT_EVIDENCE'); }
}
