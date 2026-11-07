export type ApprovalRuleEffect = 'SCORING' | 'REPORT_ONLY';
export type ApprovalOutcome = 'APPROVED' | 'UNAPPROVED' | 'UNKNOWN' | 'LIMIT_EXCEEDED';
export type ApprovalTargetV2 = Readonly<{ targetId?: string; tool: string; effect: string; argumentPaths?: readonly string[]; port?: number }>;
export type ApprovalEventV2 = Readonly<{ kind?: 'APPROVAL' | 'REJECT' | 'TIMEOUT' | 'RETRY' | 'ERROR' | 'BYPASS'; status?: 'APPROVED' | 'REJECTED' | 'TIMEOUT' | 'RETRY' | 'ERROR' | 'BYPASS'; targetId?: string; tool?: string; effect?: string; argumentPaths?: readonly string[]; arguments?: readonly string[]; port?: number }>;
export type ApprovalPathV2 = Readonly<{ pathId: string; target?: ApprovalTargetV2; events?: readonly ApprovalEventV2[]; controls?: readonly ApprovalEventV2[]; resolution?: 'RESOLVED' | 'UNKNOWN' | 'UNRESOLVED' | 'AMBIGUOUS' }> & Partial<ApprovalTargetV2>;
export type ApprovalProofInputV2 = Readonly<{ target?: ApprovalTargetV2; targets?: readonly ApprovalTargetV2[]; paths: readonly ApprovalPathV2[]; ruleEffect?: ApprovalRuleEffect; effect?: ApprovalRuleEffect; required?: boolean; maxOperations?: number }>;
export type ApprovalPathResultV2 = Readonly<{ pathId: string; status: ApprovalOutcome; reason: 'MATCH' | 'BYPASS' | 'MISMATCH' | 'REJECTED' | 'TIMEOUT' | 'RETRY' | 'ERROR' | 'UNSUPPORTED' }>;
export type ApprovalControlEvidenceV2 = Readonly<{ pathId: string; targetId: string | null; kind: string; tool: string | null; effect: string | null; argumentPaths: readonly string[]; port: number | null; targetPort: number | null }>;
export type ApprovalProofResultV2 = Readonly<{ status: ApprovalOutcome; pathResults: readonly ApprovalPathResultV2[]; controlEvidence: readonly ApprovalControlEvidenceV2[]; matchedTargets: readonly ApprovalTargetV2[]; omitted: number; operations: number; reportOnly: boolean; aggregateEffect: 'NONE' | 'DEGRADED' | 'INDETERMINATE'; assessmentEligible: boolean; assessment: Readonly<{ approvedTargets: number }> | null }>;

type Mutable = { used: number; omitted: number; evidence: ApprovalControlEvidenceV2[]; paths: ApprovalPathResultV2[]; pathTargets: (ApprovalTargetV2 | undefined)[] };
const has = (value: object, key: string): boolean => Object.prototype.hasOwnProperty.call(value, key);
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 512 && !value.includes('\0');
const list = (value: unknown): value is readonly string[] => Array.isArray(value) && value.every(text);
const safePort = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const targetValid = (value: unknown): value is ApprovalTargetV2 => value !== null && typeof value === 'object' && text((value as ApprovalTargetV2).tool) && text((value as ApprovalTargetV2).effect) && ((value as ApprovalTargetV2).targetId === undefined || text((value as ApprovalTargetV2).targetId)) && ((value as ApprovalTargetV2).argumentPaths === undefined || list((value as ApprovalTargetV2).argumentPaths)) && ((value as ApprovalTargetV2).port === undefined || safePort((value as ApprovalTargetV2).port));
const eventKind = (event: ApprovalEventV2): string => event.status ?? event.kind ?? '';
function eventArguments(event: ApprovalEventV2): readonly string[] | undefined { const value = event.argumentPaths ?? event.arguments; return value === undefined || list(value) ? value : undefined; }
const covers = (provided: readonly string[] | undefined, required: readonly string[] | undefined): boolean => required === undefined || required.every((path) => provided?.includes(path) === true);
const compareText = (left: string, right: string): number => left === right ? 0 : left < right ? -1 : 1;
function maxOf(input: ApprovalProofInputV2): number | undefined { if (input === null || typeof input !== 'object') return undefined; const value = input.maxOperations ?? 4096; return Number.isSafeInteger(value) && value >= 0 ? value : undefined; }
function reportOnlyOf(input: ApprovalProofInputV2): boolean { return input !== null && typeof input === 'object' && (input.ruleEffect ?? input.effect) === 'REPORT_ONLY'; }
function targetKey(target: ApprovalTargetV2): string { return `${target.targetId ?? ''}|${target.tool}|${target.effect}|${target.port ?? ''}|${[...(target.argumentPaths ?? [])].sort().join('\0')}`; }
function uniqueTargets(targets: readonly ApprovalTargetV2[]): readonly ApprovalTargetV2[] { const seen = new Set<string>(); const selected = targets.filter((target) => { const key = targetKey(target); if (seen.has(key)) return false; seen.add(key); return true; }); return Object.freeze(selected.sort((left, right) => compareText(targetKey(left), targetKey(right)))); }
function fullyApproved(state: Mutable): readonly ApprovalTargetV2[] { const groups = new Map<string, { target: ApprovalTargetV2; statuses: ApprovalOutcome[] }>(); for (let index = 0; index < state.pathTargets.length; index += 1) { const target = state.pathTargets[index]; if (!target) continue; const key = targetKey(target); const group = groups.get(key); if (group) group.statuses.push(state.paths[index]!.status); else groups.set(key, { target, statuses: [state.paths[index]!.status] }); } return uniqueTargets([...groups.values()].filter((group) => group.statuses.length > 0 && group.statuses.every((status) => status === 'APPROVED')).map((group) => group.target)); }
function freezeResult(status: ApprovalOutcome, state: Mutable, input: ApprovalProofInputV2, matched: readonly ApprovalTargetV2[]): ApprovalProofResultV2 { const reportOnly = reportOnlyOf(input); const unknown = status === 'UNKNOWN' || status === 'LIMIT_EXCEEDED'; const eligible = status === 'APPROVED' && !reportOnly; const partial = status === 'LIMIT_EXCEEDED'; return Object.freeze({ status, pathResults: Object.freeze(partial ? [] : state.paths), controlEvidence: Object.freeze(partial ? [] : state.evidence), matchedTargets: uniqueTargets(matched), omitted: state.omitted, operations: state.used, reportOnly, aggregateEffect: unknown ? (reportOnly ? 'DEGRADED' : 'INDETERMINATE') : 'NONE', assessmentEligible: eligible, assessment: eligible ? Object.freeze({ approvedTargets: matched.length }) : null }); }
function targetFor(path: ApprovalPathV2, fallback: ApprovalTargetV2 | undefined): ApprovalTargetV2 | undefined { const candidate = path.target ?? (path.tool !== undefined && path.effect !== undefined ? { targetId: path.targetId, tool: path.tool, effect: path.effect, argumentPaths: path.argumentPaths, port: path.port } : fallback); return targetValid(candidate) ? candidate : undefined; }
function eventMatches(event: ApprovalEventV2, target: ApprovalTargetV2): boolean { return text(event.tool) && text(event.effect) && event.tool === target.tool && event.effect === target.effect && (target.targetId === undefined || event.targetId === target.targetId) && (target.port === undefined || event.port === target.port) && covers(eventArguments(event), target.argumentPaths); }
function classifyPath(path: ApprovalPathV2, target: ApprovalTargetV2, state: Mutable, maximum: number): ApprovalPathResultV2 {
  if (path.resolution !== undefined && path.resolution !== 'RESOLVED') return { pathId: path.pathId, status: 'UNKNOWN', reason: 'UNSUPPORTED' };
  const events = path.events ?? path.controls; if (!Array.isArray(events)) return { pathId: path.pathId, status: 'UNKNOWN', reason: 'UNSUPPORTED' };
  if (++state.used > maximum) { state.omitted += 1; return { pathId: path.pathId, status: 'LIMIT_EXCEEDED', reason: 'UNSUPPORTED' }; }
  if (events.length === 0) return { pathId: path.pathId, status: 'UNAPPROVED', reason: 'BYPASS' };
  let sawMismatch = false;
  for (const event of events) {
    if (++state.used > maximum) { state.omitted += 1; return { pathId: path.pathId, status: 'LIMIT_EXCEEDED', reason: 'UNSUPPORTED' }; }
    if (event === null || typeof event !== 'object') return { pathId: path.pathId, status: 'UNKNOWN', reason: 'UNSUPPORTED' };
    const kind = eventKind(event); const args = eventArguments(event); const argsPresent = has(event, 'argumentPaths') || has(event, 'arguments');
    if (kind === 'TIMEOUT' || kind === 'RETRY' || kind === 'ERROR') return { pathId: path.pathId, status: 'UNKNOWN', reason: kind };
    if (kind === 'BYPASS') return { pathId: path.pathId, status: 'UNAPPROVED', reason: 'BYPASS' };
    if (kind === '') return { pathId: path.pathId, status: 'UNKNOWN', reason: 'UNSUPPORTED' };
    if (kind === 'REJECT' || kind === 'REJECTED') return { pathId: path.pathId, status: 'UNAPPROVED', reason: 'REJECTED' };
    if (kind !== 'APPROVAL' && kind !== 'APPROVED') return { pathId: path.pathId, status: 'UNKNOWN', reason: 'UNSUPPORTED' };
    if (!text(event.tool) || !text(event.effect) || event.port !== undefined && !safePort(event.port) || argsPresent && args === undefined || target.argumentPaths !== undefined && target.argumentPaths.length > 0 && args === undefined || target.targetId !== undefined && event.targetId === undefined) return { pathId: path.pathId, status: 'UNKNOWN', reason: 'UNSUPPORTED' };
    if (eventMatches(event, target)) { state.evidence.push(Object.freeze({ pathId: path.pathId, targetId: target.targetId ?? null, kind, tool: event.tool ?? null, effect: event.effect ?? null, argumentPaths: Object.freeze([...(args ?? [])]), port: event.port ?? null, targetPort: target.port ?? null })); return { pathId: path.pathId, status: 'APPROVED', reason: 'MATCH' }; }
    sawMismatch = true;
  }
  return { pathId: path.pathId, status: 'UNAPPROVED', reason: sawMismatch ? 'MISMATCH' : 'BYPASS' };
}
export function proveApprovalV2(input: ApprovalProofInputV2): ApprovalProofResultV2 {
  const maximum = maxOf(input); const reportOnly = reportOnlyOf(input);
  if (maximum === undefined || !Array.isArray(input.paths)) return Object.freeze({ status: 'UNKNOWN', pathResults: Object.freeze([]), controlEvidence: Object.freeze([]), matchedTargets: Object.freeze([]), omitted: 1, operations: 0, reportOnly, aggregateEffect: reportOnly ? 'DEGRADED' : 'INDETERMINATE', assessmentEligible: false, assessment: null });
  const targets = input.targets; if (targets !== undefined && (!Array.isArray(targets) || !targets.every(targetValid))) return freezeResult('UNKNOWN', { used: 0, omitted: 1, evidence: [], paths: [], pathTargets: [] }, input, []);
  const fallback = targetValid(input.target) ? input.target : targets?.length === 1 ? targets[0] : undefined; const state: Mutable = { used: 0, omitted: 0, evidence: [], paths: [], pathTargets: [] };
  for (const path of input.paths) {
    if (path === null || typeof path !== 'object' || !text(path.pathId)) { state.omitted += 1; state.pathTargets.push(undefined); continue; }
    const target = targetFor(path, fallback); state.pathTargets.push(target); if (!target) { state.paths.push({ pathId: path.pathId, status: 'UNKNOWN', reason: 'UNSUPPORTED' }); continue; }
    const result = classifyPath(path, target, state, maximum); state.paths.push(result); if (result.status === 'LIMIT_EXCEEDED') return freezeResult('LIMIT_EXCEEDED', state, input, []);
  }
  if (state.omitted > 0 || state.paths.length !== input.paths.length) return freezeResult('UNKNOWN', state, input, fullyApproved(state));
  const statuses = state.paths.map(({ status }) => status); const status: ApprovalOutcome = statuses.includes('UNKNOWN') ? 'UNKNOWN' : statuses.includes('UNAPPROVED') ? 'UNAPPROVED' : statuses.length > 0 && statuses.every((item) => item === 'APPROVED') ? 'APPROVED' : 'UNKNOWN';
  return freezeResult(status, state, input, fullyApproved(state));
}
export const proveApprovalCoverageV2 = proveApprovalV2;
export const checkApprovalProofV2 = proveApprovalV2;
export const analyzeApprovalProofV2 = proveApprovalV2;
export const proveApproval = proveApprovalV2;
