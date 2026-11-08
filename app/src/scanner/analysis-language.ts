export const MODEL_COVERAGE_DIAGNOSTIC_CODES = Object.freeze([
  'SEMANTIC_CATALOGUE_MISS',
  'GENERIC_NODE_UNMODELED_CAPABILITY',
] as const);

const MODEL_COVERAGE_CODES = new Set<string>(MODEL_COVERAGE_DIAGNOSTIC_CODES);

export type AnalysisLabel =
  | 'Analysis complete'
  | 'Standard scan'
  | 'Partial analysis'
  | 'Analysis incomplete'
  | 'Assessment unavailable';

export type AnalysisTone = 'complete' | 'neutral' | 'caution' | 'warning';

export type AnalysisDiagnosticEvidence = {
  id?: string;
  code: string;
  capabilityId?: string;
  aggregateEffect?: string;
  assessmentEligible?: boolean;
  omitted?: number;
};

export type AnalysisCapabilityEvidence = {
  id?: string;
  required?: boolean;
  status?: string;
  seen?: number;
  analyzed?: number;
  skipped?: number;
  omitted?: number;
  diagnosticIds?: readonly string[];
};

export type AnalysisLimitEvidence = {
  omitted?: number;
  exhausted?: boolean;
};

export type AnalysisPresentationInput = {
  status?: string | null;
  assessment: 'present' | 'unavailable';
  evidenceComplete: boolean;
  diagnostics?: readonly AnalysisDiagnosticEvidence[];
  capabilities?: readonly AnalysisCapabilityEvidence[];
  limits?: readonly AnalysisLimitEvidence[];
  omittedFindings?: number;
  rejectedCandidates?: number;
  collapsedCandidates?: number;
};

export type AnalysisPresentation = Readonly<{
  label: AnalysisLabel;
  summary: string;
  message: string;
  tone: AnalysisTone;
  assessmentAvailable: boolean;
  modelCoverageOnly: boolean;
}>;

const COMPLETE_SUMMARY = 'Required analysis capabilities completed within the recorded limits. This is not proof of safety or that every runtime behavior was modelled.';
const STANDARD_SUMMARY = 'Some node behavior is not modelled. Findings and the grade reflect the available evidence.';
const PARTIAL_SUMMARY = 'Some evidence was omitted, refused, failed, or not covered, so the findings and any grade reflect only what was assessed.';
const INCOMPLETE_SUMMARY = 'Assessment unavailable because required analysis did not finish; no risk decision is shown.';
const UNAVAILABLE_SUMMARY = 'No risk assessment was returned, so no grade is shown.';

function presentation(
  label: AnalysisLabel,
  summary: string,
  tone: AnalysisTone,
  assessmentAvailable: boolean,
  modelCoverageOnly = false,
): AnalysisPresentation {
  return Object.freeze({
    label,
    summary,
    message: `${label}. ${summary}`,
    tone,
    assessmentAvailable,
    modelCoverageOnly,
  });
}

function isCount(value: number | undefined): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isId(value: string | undefined): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isPositiveModelCoverageOnly(input: AnalysisPresentationInput): boolean {
  if (!input.evidenceComplete || input.status !== 'DEGRADED') return false;
  const diagnostics = input.diagnostics ?? [];
  const capabilities = input.capabilities ?? [];
  if (diagnostics.length === 0 || capabilities.length === 0) return false;
  if ((input.limits ?? []).some((limit) => {
    const omitted = limit.omitted;
    return !isCount(omitted) || omitted > 0 || limit.exhausted !== false;
  })) return false;
  if (!isCount(input.omittedFindings) || input.omittedFindings > 0
    || !isCount(input.rejectedCandidates) || input.rejectedCandidates > 0
    || !isCount(input.collapsedCandidates) || input.collapsedCandidates > 0) return false;

  const capabilitiesById = new Map(capabilities.map((capability) => [capability.id, capability]));
  if (capabilitiesById.size !== capabilities.length) return false;
  const modelDiagnosticIds = new Set<string>();
  for (const diagnostic of diagnostics) {
    if (!MODEL_COVERAGE_CODES.has(diagnostic.code)) return false;
    if (diagnostic.aggregateEffect !== 'DEGRADED' || diagnostic.assessmentEligible !== true) return false;
    if ((diagnostic.omitted !== undefined && (!isCount(diagnostic.omitted) || diagnostic.omitted > 0))
      || !isId(diagnostic.id) || !isId(diagnostic.capabilityId)) return false;
    if (modelDiagnosticIds.has(diagnostic.id)) return false;
    const capability = capabilitiesById.get(diagnostic.capabilityId);
    if (!capability || !(capability.diagnosticIds ?? []).includes(diagnostic.id)) return false;
    modelDiagnosticIds.add(diagnostic.id);
  }

  for (const capability of capabilities) {
    if (!isId(capability.id) || typeof capability.required !== 'boolean'
      || !Array.isArray(capability.diagnosticIds)) return false;
    if (capability.status !== 'COMPLETED' && capability.status !== 'DEGRADED') return false;
    if (!isCount(capability.seen) || !isCount(capability.analyzed)
      || !isCount(capability.skipped) || !isCount(capability.omitted)) return false;
    if (capability.skipped > 0 || capability.omitted > 0) return false;
    if (capability.analyzed !== capability.seen) return false;
    if (capability.status === 'DEGRADED' && capability.seen === 0) return false;
    if (capability.required === true && capability.status !== 'COMPLETED') return false;
    const ids = capability.diagnosticIds ?? [];
    if (ids.some((id) => !isId(id) || !modelDiagnosticIds.has(id))) return false;
    if (capability.status === 'DEGRADED' && ids.length === 0) return false;
  }
  return true;
}

export function analysisPresentation(input: AnalysisPresentationInput): AnalysisPresentation {
  const status = input.status;
  const knownStatus = status === 'COMPLETE' || status === 'DEGRADED' || status === 'INDETERMINATE';

  if (status === 'INDETERMINATE') {
    return presentation('Analysis incomplete', INCOMPLETE_SUMMARY, 'warning', false);
  }
  if (input.assessment !== 'present') {
    if (status === 'DEGRADED') {
      return presentation('Assessment unavailable', 'Analysis is partial and the available evidence cannot support a risk decision; no grade is shown.', 'warning', false);
    }
    if (status === 'COMPLETE') {
      return presentation('Assessment unavailable', 'Analysis completed, but no risk assessment was returned; no grade is shown.', 'warning', false);
    }
    return presentation('Assessment unavailable', UNAVAILABLE_SUMMARY, 'warning', false);
  }
  if (!knownStatus) {
    return presentation('Partial analysis', 'The analysis state is not recognised, so this report does not treat the result as complete or fully modelled.', 'warning', false);
  }
  if (status === 'COMPLETE') {
    return presentation('Analysis complete', COMPLETE_SUMMARY, 'complete', true);
  }
  if (isPositiveModelCoverageOnly(input)) {
    return presentation('Standard scan', STANDARD_SUMMARY, 'neutral', true, true);
  }
  return presentation('Partial analysis', PARTIAL_SUMMARY, 'warning', true);
}

export type AnalysisScanLike = {
  analysisStatus?: string | null;
  analysisDiagnostics?: readonly { code: string; omitted?: number }[];
  riskAssessment?: unknown;
  humanSummary?: unknown;
  summary?: unknown;
  assessment?: unknown;
  v2?: {
    schemaVersion?: string;
    analysis?: {
      status?: string;
      capabilities?: readonly AnalysisCapabilityEvidence[];
      diagnostics?: readonly AnalysisDiagnosticEvidence[];
    };
    limits?: { usage?: readonly AnalysisLimitEvidence[] };
    stats?: { omittedFindings?: number; rejectedCandidates?: number; collapsedCandidates?: number };
  };
};

export function scanAnalysisPresentation(scan: AnalysisScanLike): AnalysisPresentation {
  const v2 = scan.v2;
  if (v2?.schemaVersion === 'scanner-result-v2' && v2.analysis) {
    const evidenceComplete = Array.isArray(v2.analysis.capabilities)
      && Array.isArray(v2.analysis.diagnostics)
      && Array.isArray(v2.limits?.usage)
      && v2.stats !== undefined;
    return analysisPresentation({
      status: v2.analysis.status,
      assessment: scan.assessment === null || scan.assessment === undefined ? 'unavailable' : 'present',
      evidenceComplete,
      diagnostics: v2.analysis.diagnostics,
      capabilities: v2.analysis.capabilities,
      limits: v2.limits?.usage,
      omittedFindings: v2.stats?.omittedFindings,
      rejectedCandidates: v2.stats?.rejectedCandidates,
      collapsedCandidates: v2.stats?.collapsedCandidates,
    });
  }

  const legacy = analysisPresentation({
    status: scan.analysisStatus,
    assessment: scan.riskAssessment === null || scan.riskAssessment === undefined ? 'unavailable' : 'present',
    evidenceComplete: false,
    diagnostics: scan.analysisDiagnostics,
  });
  if (legacy.label === 'Analysis complete' && (!scan.humanSummary || !scan.summary)) {
    return presentation('Analysis incomplete', 'Required report data is incomplete, so no risk decision is shown.', 'warning', false);
  }
  return legacy;
}

export type CorpusCoverageKind = 'completed' | 'degraded' | 'indeterminate';

const CORPUS_LABELS: Readonly<Record<CorpusCoverageKind, AnalysisLabel>> = Object.freeze({
  completed: 'Analysis complete',
  degraded: 'Partial analysis',
  indeterminate: 'Analysis incomplete',
});

export function corpusCoverageLabel(kind: CorpusCoverageKind): AnalysisLabel {
  return CORPUS_LABELS[kind];
}

export function analysisStatusLabel(status?: string | null): AnalysisLabel | null {
  if (status === 'COMPLETE') return CORPUS_LABELS.completed;
  if (status === 'DEGRADED') return CORPUS_LABELS.degraded;
  if (status === 'INDETERMINATE') return CORPUS_LABELS.indeterminate;
  return null;
}
