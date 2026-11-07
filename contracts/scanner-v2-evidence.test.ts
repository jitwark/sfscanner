import { describe, expect, it } from 'vitest';
import type {
  AnalysisDiagnosticV2,
  CapabilityExecutionV2,
  FindingV2,
  SafeFactV2,
  TraceV2,
} from './scanner-v2-evidence';
import type { SubjectV2 } from './scanner-v2-source';

const subject: SubjectV2 = { kind: 'WORKFLOW' };

describe('scanner v2 evidence contract', () => {
  it('represents safe scalar facts and ordered traces', () => {
    const fact: SafeFactV2 = {
      factId: 'a'.repeat(64), kind: 'workflow.summary.v1', subject,
      properties: { count: 1, safe: true, label: null, tags: ['metadata'] },
    };
    const trace: TraceV2 = {
      traceId: 'b'.repeat(64), kind: 'CONTROL',
      steps: [{ ordinal: 0, kind: 'SOURCE', subject, factRefs: [fact.factId] }],
    };
    expect(trace.steps[0]?.factRefs).toContain(fact.factId);
  });

  it('keeps diagnostics, execution, and findings closed by discriminants', () => {
    const diagnostic: AnalysisDiagnosticV2 = {
      id: 'c'.repeat(64), code: 'SOURCE_SPAN_UNAVAILABLE', category: 'SOURCE',
      capabilityId: 'source-normalization', aggregateEffect: 'DEGRADED', assessmentEligible: true,
    };
    const execution: CapabilityExecutionV2 = {
      id: 'source-normalization', version: '2.0.0', required: true, status: 'COMPLETED',
      seen: 1, analyzed: 1, skipped: 0, omitted: 0, diagnosticIds: [diagnostic.id],
    };
    const finding: FindingV2 = {
      findingId: 'd'.repeat(64), ruleId: 'RULE', ruleRevision: '1', effect: 'REPORT_ONLY',
      severity: 'INFO', confidence: 'HIGH', evidenceClass: 'CAPABILITY', conclusion: 'OBSERVED',
      applicability: 'APPLICABLE', subject, factRefs: [], traceRefs: [], remediationId: 'remediation',
    };
    expect([execution, finding, diagnostic]).toHaveLength(3);
  });
});
