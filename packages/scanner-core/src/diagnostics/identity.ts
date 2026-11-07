import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { encodeIdentityTuple } from '../workflow-v2/node-edge-identity';
import type { SourceMemberRefV2, SourcePositionV2 } from '../source/source-types';
import { classifyDiagnostic, DIAGNOSTIC_REGISTRY, type AnalysisDiagnosticV2,
  type DiagnosticAggregateEffectV2, type DiagnosticCategoryV2, type DiagnosticCodeV2 } from './registry';

export type DiagnosticIdentityInputV2 = Readonly<{
  code: DiagnosticCodeV2; capabilityId: string; aggregateEffect: DiagnosticAggregateEffectV2;
  category?: DiagnosticCategoryV2; assessmentEligible?: boolean; location?: SourceMemberRefV2;
  observed?: number; maximum?: number; omitted?: number;
}>;
type NormalizedIdentity = { code: DiagnosticCodeV2; capabilityId: string; category: DiagnosticCategoryV2;
  aggregateEffect: DiagnosticAggregateEffectV2; assessmentEligible: boolean; location?: SourceMemberRefV2;
  observed?: number; maximum?: number; omitted?: number; astNodeId: string };
const encoder = new TextEncoder();
const registryOrder = new Map(DIAGNOSTIC_REGISTRY.map((entry, index) => [entry.code, index]));
const identityKeys = ['code', 'capabilityId', 'aggregateEffect', 'category', 'assessmentEligible', 'location', 'observed', 'maximum', 'omitted'] as const;
const diagnosticKeys = ['id', ...identityKeys] as const;
const locationKeys = ['pointer', 'occurrencePath', 'astNodeId', 'span'] as const;
const spanKeys = ['start', 'end'] as const;
const positionKeys = ['line', 'column', 'utf16Offset', 'utf8ByteOffset'] as const;

export function createDiagnosticId(input: DiagnosticIdentityInputV2): string {
  try { return identityDigest(normalizeIdentity(input)); }
  catch { throw new TypeError('Invalid diagnostic identity'); }
}
export function sortDiagnostics(diagnostics: readonly AnalysisDiagnosticV2[], capabilityOrder: readonly string[] = []): readonly AnalysisDiagnosticV2[] {
  try {
    assertDenseArray(diagnostics); const order = capabilityRanks(capabilityOrder);
    const groups = new Map<string, AnalysisDiagnosticV2[]>();
    for (const diagnostic of diagnostics) {
      const normalized = normalizeDiagnostic(diagnostic); const group = groups.get(normalized.id);
      if (group) group.push(normalized); else groups.set(normalized.id, [normalized]);
    }
    const unique = [...groups.values()].map((group) => duplicateRepresentative(group, order));
    return Object.freeze(unique.sort((left, right) => compareDiagnostics(left, right, order)));
  } catch { throw new TypeError('Invalid diagnostic collection'); }
}
function normalizeIdentity(input: DiagnosticIdentityInputV2): NormalizedIdentity {
  const value = record(input, identityKeys); const code = required(value, 'code') as DiagnosticCodeV2;
  const capabilityId = required(value, 'capabilityId'); const effect = required(value, 'aggregateEffect');
  const category = optional(value, 'category'); const eligible = optional(value, 'assessmentEligible');
  if (typeof capabilityId !== 'string' || capabilityId.length === 0) throw new TypeError();
  if (eligible !== undefined && typeof eligible !== 'boolean') throw new TypeError();
  const classification = eligible === undefined ? classifyDiagnostic(code) : classifyDiagnostic(code, !eligible);
  if (eligible !== undefined && eligible !== classification.assessmentEligible) throw new TypeError();
  if (effect !== classification.aggregateEffect || category !== undefined && category !== classification.category) throw new TypeError();
  const locationValue = optional(value, 'location'); const location = locationValue === undefined ? undefined : cloneLocation(locationValue);
  return { code, capabilityId, category: classification.category, aggregateEffect: classification.aggregateEffect,
    assessmentEligible: classification.assessmentEligible, location, observed: optionalNumber(value, 'observed'),
    maximum: optionalNumber(value, 'maximum'), omitted: optionalNumber(value, 'omitted'), astNodeId: location?.astNodeId ?? 'NONE' };
}
function normalizeDiagnostic(input: AnalysisDiagnosticV2): AnalysisDiagnosticV2 {
  const value = record(input, diagnosticKeys); const identity = normalizeIdentity({
    code: required(value, 'code') as DiagnosticCodeV2, capabilityId: required(value, 'capabilityId') as string,
    aggregateEffect: required(value, 'aggregateEffect') as DiagnosticAggregateEffectV2,
    category: required(value, 'category') as DiagnosticCategoryV2, assessmentEligible: required(value, 'assessmentEligible') as boolean,
    location: optional(value, 'location') as SourceMemberRefV2 | undefined, observed: optionalNumber(value, 'observed'),
    maximum: optionalNumber(value, 'maximum'), omitted: optionalNumber(value, 'omitted') });
  const id = required(value, 'id'); if (typeof id !== 'string' || id !== identityDigest(identity)) throw new TypeError();
  return Object.freeze({ id, code: identity.code, category: identity.category, capabilityId: identity.capabilityId,
    aggregateEffect: identity.aggregateEffect, assessmentEligible: identity.assessmentEligible,
    ...(identity.location === undefined ? {} : { location: identity.location }),
    ...(identity.observed === undefined ? {} : { observed: identity.observed }),
    ...(identity.maximum === undefined ? {} : { maximum: identity.maximum }),
    ...(identity.omitted === undefined ? {} : { omitted: identity.omitted }) });
}
function identityDigest(input: NormalizedIdentity): string {
  return bytesToHex(sha256(encoder.encode(encodeIdentityTuple(['secureflow-diagnostic-id-v2', input.capabilityId, input.code,
    input.aggregateEffect, input.astNodeId, input.observed === undefined ? 'NONE' : String(input.observed),
    input.maximum === undefined ? 'NONE' : String(input.maximum), input.omitted === undefined ? 'NONE' : String(input.omitted)]))));
}
function duplicateRepresentative(group: readonly AnalysisDiagnosticV2[], order: Map<string, number>): AnalysisDiagnosticV2 {
  let representative = group[0];
  for (const candidate of group.slice(1)) if (compareDiagnostics(candidate, representative, order) < 0) representative = candidate;
  if (group.length === 1 || representative.location === undefined) return representative;
  return Object.freeze({ ...representative, location: Object.freeze({ ...representative.location, span: null }) });
}
function cloneLocation(input: unknown): SourceMemberRefV2 {
  const value = record(input, locationKeys); const pointer = required(value, 'pointer'); const astNodeId = required(value, 'astNodeId');
  if (typeof pointer !== 'string' || typeof astNodeId !== 'string' || astNodeId.length === 0) throw new TypeError();
  const path = required(value, 'occurrencePath'); assertDenseArray(path);
  const occurrencePath = Object.freeze((path as readonly unknown[]).map(numericValue)); const span = required(value, 'span');
  return Object.freeze({ pointer, occurrencePath, astNodeId, span: span === null ? null : cloneSpan(span) });
}
function cloneSpan(input: unknown): NonNullable<SourceMemberRefV2['span']> {
  const value = record(input, spanKeys); return Object.freeze({ start: clonePosition(required(value, 'start')), end: clonePosition(required(value, 'end')) });
}
function clonePosition(input: unknown): SourcePositionV2 {
  const value = record(input, positionKeys); return Object.freeze({ line: numericValue(required(value, 'line')), column: numericValue(required(value, 'column')),
    utf16Offset: numericValue(required(value, 'utf16Offset')), utf8ByteOffset: numericValue(required(value, 'utf8ByteOffset')) });
}
function optionalNumber(value: Record<string, unknown>, key: string): number | undefined {
  const number = optional(value, key); return number === undefined ? undefined : numericValue(number);
}
function numericValue(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new TypeError(); return value as number;
}
function capabilityRanks(order: readonly string[]): Map<string, number> {
  assertDenseArray(order); const ranks = new Map<string, number>();
  for (const [index, capability] of order.entries()) { if (typeof capability !== 'string' || ranks.has(capability)) throw new TypeError(); ranks.set(capability, index); }
  return ranks;
}
function compareDiagnostics(left: AnalysisDiagnosticV2, right: AnalysisDiagnosticV2, ranks: Map<string, number>): number {
  const leftRank = ranks.get(left.capabilityId); const rightRank = ranks.get(right.capabilityId);
  if (leftRank !== undefined || rightRank !== undefined) {
    if (leftRank === undefined) return 1; if (rightRank === undefined) return -1; if (leftRank !== rightRank) return leftRank - rightRank;
  } else if (left.capabilityId !== right.capabilityId) return compareCodePoints(left.capabilityId, right.capabilityId);
  const codeOrder = (registryOrder.get(left.code) ?? Number.MAX_SAFE_INTEGER) - (registryOrder.get(right.code) ?? Number.MAX_SAFE_INTEGER);
  if (codeOrder !== 0) return codeOrder; const locationOrder = compareLocations(left.location, right.location);
  return locationOrder !== 0 ? locationOrder : left.id === right.id ? 0 : compareCodePoints(left.id, right.id);
}
function compareLocations(left: SourceMemberRefV2 | undefined, right: SourceMemberRefV2 | undefined): number {
  if (left === undefined) return right === undefined ? 0 : 1; if (right === undefined) return -1;
  const pointerOrder = compareCodePoints(left.pointer, right.pointer); return pointerOrder !== 0 ? pointerOrder : comparePaths(left.occurrencePath, right.occurrencePath);
}
function comparePaths(left: readonly number[], right: readonly number[]): number {
  for (let index = 0; index < Math.min(left.length, right.length); index += 1) if (left[index] !== right[index]) return left[index] - right[index];
  return left.length - right.length;
}
function compareCodePoints(left: string, right: string): number {
  const leftPoints = Array.from(left, (value) => value.codePointAt(0)!); const rightPoints = Array.from(right, (value) => value.codePointAt(0)!);
  for (let index = 0; index < Math.min(leftPoints.length, rightPoints.length); index += 1) if (leftPoints[index] !== rightPoints[index]) return leftPoints[index] - rightPoints[index];
  return leftPoints.length - rightPoints.length;
}
function record(input: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new TypeError(); const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null || Object.getOwnPropertySymbols(input).length > 0) throw new TypeError();
  for (const key of Object.getOwnPropertyNames(input)) { const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!allowed.includes(key) || !descriptor || !('value' in descriptor)) throw new TypeError(); }
  return input as Record<string, unknown>;
}
function required(value: Record<string, unknown>, key: string): unknown { if (!Object.prototype.hasOwnProperty.call(value, key)) throw new TypeError(); return value[key]; }
function optional(value: Record<string, unknown>, key: string): unknown { return Object.prototype.hasOwnProperty.call(value, key) ? value[key] : undefined; }
function assertDenseArray(input: unknown): asserts input is readonly unknown[] {
  if (!Array.isArray(input) || Object.getPrototypeOf(input) !== Array.prototype || Object.getOwnPropertySymbols(input).length > 0) throw new TypeError();
  const names = Object.getOwnPropertyNames(input); if (names.length !== input.length + 1 || !names.includes('length')) throw new TypeError();
  for (let index = 0; index < input.length; index += 1) { const descriptor = Object.getOwnPropertyDescriptor(input, String(index)); if (!descriptor || !('value' in descriptor)) throw new TypeError(); }
  if (names.some((name) => name !== 'length' && !/^\d+$/.test(name))) throw new TypeError();
}
