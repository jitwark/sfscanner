import type { SafeFactV2 } from '../../../../contracts/scanner-v2-evidence';
import { isFieldFlowFactKindV1 } from '../../../../contracts/scanner-v2-field-flow';
import { readFieldFlowPropertiesV1, validateFieldFlowSubject } from '../../../../contracts/scanner-v2-field-flow-validation';
import { validateFieldFlowCoherenceV1 } from '../../../../contracts/scanner-v2-field-flow-coherence';
import { readPlainRecord } from '../facts/safe-fact-validator';
import { createFactId, type IdentityContextV2 } from './identities';

/** Admit once before merging; embedded properties must not be read from caller accessors. */
export function admitCompositionFactsV1(values: readonly unknown[], context: IdentityContextV2): SafeFactV2[] {
  return values.map((raw) => {
    const item = readPlainRecord(raw, ['factId', 'kind', 'subject', 'properties'], ['factId', 'kind', 'subject', 'properties'], true);
    const fieldFlow = isFieldFlowFactKindV1(item.kind);
    const properties = fieldFlow ? readFieldFlowPropertiesV1(item.kind, item.properties) : item.properties;
    if (fieldFlow && (properties === undefined || !validateFieldFlowSubject(item.kind, item.subject, properties))) {
      throw new TypeError('Invalid field-flow evidence');
    }
    const fact = Object.freeze({ ...item, properties }) as unknown as SafeFactV2;
    if (createFactId(fact, context) !== fact.factId) throw new TypeError('Fact identity mismatch');
    return fact;
  });
}

/** Candidate coverage totals precede result-wide canonical fact deduplication. */
export function admitCandidateCompositionFactsV1(values: readonly unknown[], context: IdentityContextV2): SafeFactV2[] {
  const facts = admitCompositionFactsV1(values, context);
  let coverageCount = 0;
  let capabilityId: string | undefined;
  for (const fact of facts) {
    if (fact.kind !== 'dataflow.coverage.v1') continue;
    coverageCount += 1;
    if (typeof fact.properties.capabilityId !== 'string') throw new TypeError('Invalid field-flow coverage');
    capabilityId = fact.properties.capabilityId;
  }
  if (coverageCount > 1 || !validateFieldFlowCoherenceV1(facts, capabilityId)) throw new TypeError('Incoherent candidate field-flow evidence');
  return facts;
}
