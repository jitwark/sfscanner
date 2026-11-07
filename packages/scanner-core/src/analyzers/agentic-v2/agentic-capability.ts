import { analyzeInfluenceV2, type InfluenceEvidenceV2, type InfluenceInputV2, type InfluenceResultV2, type InfluenceSourceV2, type InfluenceTargetV2, type InfluenceFlowV2, type InfluenceOverwriteV2 } from './influence';
import { proveApprovalV2, type ApprovalProofInputV2, type ApprovalProofResultV2, type ApprovalPathV2, type ApprovalTargetV2 } from './approval-proof';

export type AgenticCapabilityInputV2 = Readonly<{ influence?: InfluenceInputV2; approval?: ApprovalProofInputV2; sources?: readonly InfluenceSourceV2[]; facts?: InfluenceInputV2['facts']; targets?: readonly InfluenceTargetV2[]; flows?: readonly InfluenceFlowV2[]; overwrites?: readonly InfluenceOverwriteV2[]; approvalTarget?: ApprovalTargetV2; paths?: readonly ApprovalPathV2[]; ruleEffect?: 'SCORING' | 'REPORT_ONLY'; effect?: 'SCORING' | 'REPORT_ONLY'; required?: boolean }>;
export type AgenticFindingV2 = Readonly<{ targetId: string; tool: string; effect: string; argumentPaths: readonly string[]; sourceIds: readonly string[]; conclusion: 'OBSERVED' | 'UNKNOWN'; evidence: readonly InfluenceEvidenceV2[] }>;
export type AgenticCapabilityResultV2 = Readonly<{ status: 'COMPLETE' | 'UNAPPROVED' | 'UNKNOWN' | 'LIMIT_EXCEEDED'; findings: readonly AgenticFindingV2[]; influence: InfluenceResultV2; approval: ApprovalProofResultV2 | null; reportOnly: boolean; aggregateEffect: 'NONE' | 'DEGRADED' | 'INDETERMINATE'; assessmentEligible: boolean; assessment: Readonly<{ controlledTargets: number; approvedTargets: number }> | null }>;

function influenceOf(input: AgenticCapabilityInputV2): InfluenceInputV2 { return input?.influence ?? { sources: input?.sources, facts: input?.facts, targets: input?.targets, flows: input?.flows, overwrites: input?.overwrites }; }
function approvalOf(input: AgenticCapabilityInputV2): ApprovalProofInputV2 | undefined { return input?.approval ?? (input?.paths === undefined ? undefined : { target: input.approvalTarget, paths: input.paths, ruleEffect: input.ruleEffect, effect: input.effect }); }
function effectOf(input: AgenticCapabilityInputV2): 'SCORING' | 'REPORT_ONLY' { return input?.ruleEffect ?? input?.effect ?? 'SCORING'; }
const compareText = (left: string, right: string): number => left === right ? 0 : left < right ? -1 : 1;
function findingEvidence(influences: readonly InfluenceEvidenceV2[], conclusion: AgenticFindingV2['conclusion']): AgenticFindingV2[] {
  const groups = new Map<string, InfluenceEvidenceV2[]>(); for (const evidence of influences) { const bucket = groups.get(evidence.targetId); if (bucket) bucket.push(evidence); else groups.set(evidence.targetId, [evidence]); }
  return [...groups.values()].sort((left, right) => compareText(left[0]!.targetId, right[0]!.targetId)).map((evidence) => { const first = evidence[0]!; return Object.freeze({ targetId: first.targetId, tool: first.tool, effect: first.effect, argumentPaths: Object.freeze([...first.argumentPaths]), sourceIds: Object.freeze([...new Set(evidence.map((item) => item.sourceId))].sort()), conclusion, evidence: Object.freeze([...evidence]) }); });
}
function targetCovers(influence: InfluenceEvidenceV2, target: ApprovalTargetV2): boolean { const requiredArguments = target.argumentPaths; const argumentsMatch = requiredArguments === undefined || requiredArguments.length === influence.argumentPaths.length && requiredArguments.every((path) => influence.argumentPaths.includes(path)); return target.tool === influence.tool && target.effect === influence.effect && (target.targetId === undefined || target.targetId === influence.targetId) && (target.port === undefined || target.port === influence.targetPort) && argumentsMatch; }
function covered(influence: InfluenceEvidenceV2, approval: ApprovalProofResultV2): boolean { return approval.matchedTargets.some((target) => targetCovers(influence, target)); }
function findingsFor(influences: readonly InfluenceEvidenceV2[], approval: ApprovalProofResultV2 | null, conclusion: AgenticFindingV2['conclusion']): AgenticFindingV2[] { return findingEvidence(approval === null ? influences : influences.filter((influence) => !covered(influence, approval)), conclusion); }
function result(input: AgenticCapabilityInputV2, influence: InfluenceResultV2, approval: ApprovalProofResultV2 | null, status: AgenticCapabilityResultV2['status'], findings: readonly AgenticFindingV2[]): AgenticCapabilityResultV2 {
  const reportOnly = effectOf(input) === 'REPORT_ONLY'; const unknown = status === 'UNKNOWN' || status === 'LIMIT_EXCEEDED'; const aggregateEffect: AgenticCapabilityResultV2['aggregateEffect'] = unknown ? (reportOnly ? 'DEGRADED' : 'INDETERMINATE') : 'NONE'; const eligible = status === 'COMPLETE' && !unknown && !reportOnly;
  const controlledTargets = new Set(influence.influences.map((item) => item.targetId)).size; const approvedTargets = approval?.matchedTargets.length ?? (status === 'COMPLETE' ? controlledTargets : 0);
  return Object.freeze({ status, findings: Object.freeze([...findings]), influence, approval, reportOnly, aggregateEffect, assessmentEligible: eligible, assessment: eligible ? Object.freeze({ controlledTargets, approvedTargets }) : null });
}
export function analyzeAgenticCapabilityV2(input: AgenticCapabilityInputV2): AgenticCapabilityResultV2 {
  const influence = analyzeInfluenceV2(influenceOf(input));
  if (influence.status === 'LIMIT_EXCEEDED') return result(input, influence, null, 'LIMIT_EXCEEDED', []);
  if (influence.status === 'UNKNOWN') return result(input, influence, null, 'UNKNOWN', findingEvidence(influence.influences, 'UNKNOWN'));
  if (influence.influences.length === 0) return result(input, influence, null, 'COMPLETE', []);
  const approvalInput = approvalOf(input); if (approvalInput === undefined) return result(input, influence, null, 'UNKNOWN', findingEvidence(influence.influences, 'UNKNOWN'));
  const approval = proveApprovalV2(approvalInput);
  if (approval.status === 'LIMIT_EXCEEDED') return result(input, influence, approval, 'LIMIT_EXCEEDED', []);
  if (approval.status === 'UNKNOWN') return result(input, influence, approval, 'UNKNOWN', findingsFor(influence.influences, null, 'UNKNOWN'));
  if (approval.status === 'UNAPPROVED') return result(input, influence, approval, 'UNAPPROVED', findingsFor(influence.influences, approval, 'OBSERVED'));
  const uncovered = findingsFor(influence.influences, approval, 'OBSERVED'); return uncovered.length > 0 ? result(input, influence, approval, 'UNAPPROVED', uncovered) : result(input, influence, approval, 'COMPLETE', []);
}
export const runAgenticCapabilityV2 = analyzeAgenticCapabilityV2;
export const analyzeAgenticCapability = analyzeAgenticCapabilityV2;
export const runAgenticControlV2 = analyzeAgenticCapabilityV2;
