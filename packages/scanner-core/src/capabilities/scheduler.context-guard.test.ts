import { describe, expect, it } from 'vitest';
import { DEFAULT_SCANNER_LIMITS_V2 } from '@hub/contracts';
import { BETA_DEFAULT_PROFILE_MANIFEST } from './profile-manifest';
import { createCapabilityCandidateAdmissionSnapshotV2 } from '../admission/snapshot';
import { SAFE_FACT_EVIDENCE_MAPPINGS_V2 } from '../facts/safe-fact-registry';
import { betaHardenedRuleCatalog } from '../policy/rule-catalog';
import { RULE_PACK_DIGEST_V2 } from './candidate-validator';
import { normalizeSecurityWorkflow } from '../workflow-v2/normalize-security-workflow';
import { parseSourceDocument } from '../source/source-parser';
import { scheduleCapabilities, type AnalyzerContextV2, type CapabilityCandidateV2, type CapabilitySpecV2 } from './scheduler';

const emptyCandidate = (count = 1): CapabilityCandidateV2 => createCapabilityCandidateAdmissionSnapshotV2({ findings: [], diagnostics: [], facts: [], traces: [], seen: count, analyzed: count, skipped: 0, omitted: 0 });

function registryFor(run: () => CapabilityCandidateV2): Map<string, CapabilitySpecV2> {
  return new Map(BETA_DEFAULT_PROFILE_MANIFEST.capabilities.map((capability) => [capability.id, { ...capability, run }]));
}

const schedulerRules = new Map(SAFE_FACT_EVIDENCE_MAPPINGS_V2.map((mapping) => {
  const catalog = betaHardenedRuleCatalog.find((entry) => entry.policyId === mapping.ruleId)!;
  return [mapping.ruleId, {
    ruleId: mapping.ruleId, revision: '1', capabilityId: mapping.ownerCapabilityId,
    effect: mapping.ownerCapabilityId === 'structural-policies' ? 'SCORING' as const : 'REPORT_ONLY' as const,
    severity: catalog.defaultSeverity, confidence: catalog.defaultConfidence, evidenceSchemaId: mapping.evidenceSchemaId,
    remediationId: 'r', cweIds: [...catalog.cweIds], owaspAgenticIds: [...(catalog.owaspAgenticIds ?? [])], packDigest: RULE_PACK_DIGEST_V2,
  }] as const;
}));
const emptyParsedSource = parseSourceDocument(new TextEncoder().encode('{"nodes":[],"connections":{}}'), DEFAULT_SCANNER_LIMITS_V2);
if (!emptyParsedSource.ok) throw new Error('context guard fixture source must parse');
const emptyNormalizedWorkflow = normalizeSecurityWorkflow(emptyParsedSource.document, DEFAULT_SCANNER_LIMITS_V2);
if (!emptyNormalizedWorkflow.ok) throw new Error('context guard fixture workflow must normalize');
const context = { source: emptyParsedSource.document, workflow: emptyNormalizedWorkflow.workflow, limits: DEFAULT_SCANNER_LIMITS_V2, rules: { rules: schedulerRules } } as unknown as AnalyzerContextV2;

/**
 * The top-level record guard `contextView` must apply before it reads anything. Each case here
 * observes the refusal *and* that nothing was touched getting there: the old walk refused the root
 * record before reading a property, so a hostile root must not have its accessor invoked, and the
 * `{ ...input }` spread the view is built with does invoke accessors.
 */
describe('context view top-level record guard', () => {
  it('refuses an accessor-bearing context without invoking the accessor', () => {
    let invoked = false; let ran = false;
    const hostile = { ...context } as Record<string, unknown>;
    Object.defineProperty(hostile, 'priorOutcomes', { get: () => { invoked = true; return new Map(); } });
    const result = scheduleCapabilities(hostile as unknown as AnalyzerContextV2, BETA_DEFAULT_PROFILE_MANIFEST, registryFor(() => { ran = true; return emptyCandidate(); }));
    expect(invoked).toBe(false); expect(ran).toBe(false);
    expect(result.executions[0]).toMatchObject({ id: 'source-normalization', status: 'FAILED', seen: 0, analyzed: 0, skipped: 0, omitted: 1 });
    expect(result.diagnostics[0]).toMatchObject({ code: 'REQUIRED_CAPABILITY_FAILED' });
  });

  it('refuses an accessor on the limits key without reading it for the budget derivation', () => {
    let invoked = false;
    const hostile = { ...context } as Record<string, unknown>;
    Object.defineProperty(hostile, 'limits', { get: () => { invoked = true; return DEFAULT_SCANNER_LIMITS_V2; } });
    const result = scheduleCapabilities(hostile as unknown as AnalyzerContextV2, BETA_DEFAULT_PROFILE_MANIFEST, registryFor(() => emptyCandidate()));
    expect(invoked).toBe(false);
    expect(result.executions[0]).toMatchObject({ status: 'FAILED', omitted: 1 });
  });

  it('refuses an odd-prototype, symbol-bearing or over-wide top-level record', () => {
    const foreignPrototype = Object.create({ inherited: true }) as Record<string, unknown>;
    Object.assign(foreignPrototype, context);
    const symbolBearing = { ...context } as Record<string, unknown>;
    Object.defineProperty(symbolBearing, Symbol('unexpected'), { value: 'secret' });
    // The name bound is the floor item budget (4_096), the bound the old root walk applied.
    const overWide = { ...context } as Record<string, unknown>;
    for (let index = 0; index < 4_097; index += 1) Object.defineProperty(overWide, `extra-${index}`, { value: index });
    for (const hostile of [foreignPrototype, symbolBearing, overWide]) {
      const result = scheduleCapabilities(hostile as unknown as AnalyzerContextV2, BETA_DEFAULT_PROFILE_MANIFEST, registryFor(() => emptyCandidate()));
      expect(result.executions[0]).toMatchObject({ status: 'FAILED', seen: 0, analyzed: 0, skipped: 0, omitted: 1 });
    }
  });
});
