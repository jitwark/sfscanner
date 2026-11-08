import { describe, expect, it } from 'vitest';
import {
  analysisStatusLabel,
  analysisPresentation,
  corpusCoverageLabel,
  scanAnalysisPresentation,
  type AnalysisPresentationInput,
} from './analysis-language';

const base: AnalysisPresentationInput = {
  status: 'DEGRADED',
  assessment: 'present',
  evidenceComplete: true,
  diagnostics: [{
    id: 'model-diagnostic',
    code: 'SEMANTIC_CATALOGUE_MISS',
    capabilityId: 'workflow-insights',
    aggregateEffect: 'DEGRADED',
    assessmentEligible: true,
    omitted: 0,
  }],
  capabilities: [{
    id: 'workflow-insights',
    required: true,
    status: 'COMPLETED',
    seen: 2,
    analyzed: 2,
    skipped: 0,
    omitted: 0,
    diagnosticIds: ['model-diagnostic'],
  }],
  limits: [{ omitted: 0, exhausted: false }],
  omittedFindings: 0,
  rejectedCandidates: 0,
  collapsedCandidates: 0,
};

describe('analysis language', () => {
  it('labels a complete assessment without claiming safety or full modelling', () => {
    const value = analysisPresentation({ ...base, status: 'COMPLETE', diagnostics: [], capabilities: [] });

    expect(value.label).toBe('Analysis complete');
    expect(value.tone).toBe('complete');
    expect(value.message).toMatch(/not proof of safety/i);
    expect(value.message).toMatch(/not proof.*every runtime behavior/i);
    expect(analysisPresentation({ ...base, status: 'COMPLETE' }).label).toBe('Analysis complete');
  });

  it('uses Standard scan only for positive, non-adverse model-coverage evidence', () => {
    const value = analysisPresentation(base);

    expect(value.label).toBe('Standard scan');
    expect(value.tone).toBe('neutral');
    expect(value.modelCoverageOnly).toBe(true);
    expect(value.message).toMatch(/Some node behavior is not modelled/i);
  });

  it.each([
    ['unknown code', { diagnostics: [{ ...base.diagnostics![0], code: 'OPTIONAL_LIMIT_EXCEEDED' }] }],
    ['mixed code', { diagnostics: [...base.diagnostics!, { ...base.diagnostics![0], id: 'limit', code: 'OPTIONAL_LIMIT_EXCEEDED' }] }],
    ['omitted diagnostic', { diagnostics: [{ ...base.diagnostics![0], omitted: 1 }] }],
    ['ineligible diagnostic', { diagnostics: [{ ...base.diagnostics![0], assessmentEligible: false }] }],
    ['omitted limit', { limits: [{ omitted: 1, exhausted: false }] }],
    ['exhausted limit', { limits: [{ omitted: 0, exhausted: true }] }],
    ['missing limit omission count', { limits: [{ exhausted: false }] }],
    ['omitted findings', { omittedFindings: 1 }],
    ['rejected candidates', { rejectedCandidates: 1 }],
    ['collapsed candidates', { collapsedCandidates: 1 }],
    ['missing finding counts', { rejectedCandidates: undefined }],
    ['skipped capability', { capabilities: [{ ...base.capabilities![0], status: 'SKIPPED', skipped: 1 }] }],
    ['failed capability', { capabilities: [{ ...base.capabilities![0], status: 'FAILED' }] }],
    ['unknown capability status', { capabilities: [{ ...base.capabilities![0], status: 'UNKNOWN' }] }],
    ['required degraded capability', { capabilities: [{ ...base.capabilities![0], status: 'DEGRADED' }] }],
    ['empty capability rows', { capabilities: [] }],
    ['empty diagnostics', { diagnostics: [] }],
    ['missing capability counters', { capabilities: [{ ...base.capabilities![0], analyzed: undefined }] }],
    ['unknown capability requirement', { capabilities: [{ ...base.capabilities![0], required: undefined }] }],
    ['missing capability reference', { capabilities: [{ ...base.capabilities![0], diagnosticIds: [] }] }],
    ['unknown capability id', { capabilities: [{ ...base.capabilities![0], id: undefined }] }],
  ] as const)('keeps %s conservative', (_case, override) => {
    const value = analysisPresentation({ ...base, ...override });

    expect(value.label).toBe('Partial analysis');
    expect(value.tone).toBe('warning');
    expect(value.modelCoverageOnly).toBe(false);
  });

  it('keeps ambiguous missing support conservative', () => {
    const value = analysisPresentation({ ...base, evidenceComplete: false });

    expect(value.label).toBe('Partial analysis');
    expect(value.tone).toBe('warning');
    expect(value.modelCoverageOnly).toBe(false);
  });

  it('does not infer Standard scan from coarse persisted metadata', () => {
    const value = scanAnalysisPresentation({
      analysisStatus: 'DEGRADED',
      analysisDiagnostics: [{ code: 'SEMANTIC_CATALOGUE_MISS' }],
      riskAssessment: { grade: 'MEDIUM' },
    });

    expect(value.label).toBe('Partial analysis');
    expect(value.modelCoverageOnly).toBe(false);
  });

  it('keeps null assessments explicitly unavailable with no grade available', () => {
    const complete = analysisPresentation({ ...base, status: 'COMPLETE', assessment: 'unavailable' });
    const degraded = analysisPresentation({ ...base, assessment: 'unavailable' });
    const unknown = analysisPresentation({ ...base, status: 'UNKNOWN', assessment: 'unavailable' });

    expect(complete.label).toBe('Assessment unavailable');
    expect(degraded.label).toBe('Assessment unavailable');
    expect(unknown.label).toBe('Assessment unavailable');
    expect(complete.assessmentAvailable).toBe(false);
    expect(degraded.assessmentAvailable).toBe(false);
    expect(unknown.assessmentAvailable).toBe(false);
  });

  it('labels indeterminate analysis as incomplete and assessment unavailable', () => {
    const value = analysisPresentation({ ...base, status: 'INDETERMINATE' });

    expect(value.label).toBe('Analysis incomplete');
    expect(value.message).toMatch(/Assessment unavailable/i);
    expect(value.assessmentAvailable).toBe(false);
  });

  it('fails closed for an unrecognised status and incomplete legacy report data', () => {
    expect(analysisPresentation({ ...base, status: 'UNKNOWN' }).label).toBe('Partial analysis');
    expect(scanAnalysisPresentation({
      analysisStatus: 'COMPLETE',
      riskAssessment: { grade: 'LOW' },
    }).label).toBe('Analysis incomplete');
  });

  it('maps aggregate populations without claiming model success', () => {
    expect(corpusCoverageLabel('completed')).toBe('Analysis complete');
    expect(corpusCoverageLabel('degraded')).toBe('Partial analysis');
    expect(corpusCoverageLabel('indeterminate')).toBe('Analysis incomplete');
    expect(analysisStatusLabel('DEGRADED')).toBe('Partial analysis');
    expect(analysisStatusLabel(undefined)).toBeNull();
  });
});
