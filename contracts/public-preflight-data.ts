import { bodyRules, categoryRules } from './public-preflight-row-rules';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import type { PublicSha256 } from './public-data-model';
import {
  PUBLIC_PREFLIGHT_CATEGORY_ORDER, PUBLIC_PREFLIGHT_NODE_TYPES,
  PUBLIC_PREFLIGHT_OMISSION_CODES, PUBLIC_PREFLIGHT_POINTER_SCOPE_ORDER,
  readPublicPreflightOmissionCodes,
  readPublicPreflightOmissionCounts, type PublicPreflightBodyStatus,
  type PublicPreflightCategory, type PublicPreflightCoverageState, type PublicPreflightNodeType,
  type PublicPreflightObservation, type PublicPreflightOmissionCode,
  type PublicPreflightOmissionCount, type PublicPreflightPointerScope,
  type PublicPreflightPublicLabel, type PublicPreflightRequirement,
} from './public-preflight-vocabulary';
export type PublicPreflightCoverageRow = Readonly<{
  coverageId: string; workflowId: string; sourceId: string; evidenceSchema: 'preflight-prerequisites-v1';
  inventorySha256: PublicSha256; sourceBodySha256: PublicSha256 | null; bodyStatus: PublicPreflightBodyStatus;
  coverageState: PublicPreflightCoverageState; omissionCodes: readonly PublicPreflightOmissionCode[];
  omissionCounts: readonly PublicPreflightOmissionCount[]; source: 'WORKFLOW_EXPORT'; sourcePointer: '/';
  repository: 'UNKNOWN'; commit: 'UNKNOWN'; licence: 'UNKNOWN'; verification: 'UNKNOWN';
}>;
export type PublicPreflightEvidenceRow = Readonly<{
  evidenceId: string; coverageId: string; workflowId: string; category: PublicPreflightCategory;
  observation: PublicPreflightObservation; requirement: PublicPreflightRequirement; source: 'WORKFLOW_EXPORT';
  nodeIndex: number; observationOrdinal: number; nodePointer: string; pointerScope: PublicPreflightPointerScope;
  detailPointer: string; nodeName: null; nodeType: PublicPreflightNodeType | null; typeVersion: string | null;
  publicLabel: PublicPreflightPublicLabel; credentialReference: null;
  subworkflowResolution: 'LITERAL' | 'DYNAMIC' | 'ABSENT' | null;
  environmentNamespace: 'ENV' | 'VARS' | null; installation: 'UNKNOWN'; credentialValidity: 'UNKNOWN';
  runtimeAvailability: 'UNKNOWN'; ownership: 'UNKNOWN'; omissionCodes: readonly PublicPreflightOmissionCode[];
}>;
export type PublicPreflightEvidenceIdentityV1 = Readonly<{
  workflowId: string; category: PublicPreflightCategory; pointerScope: PublicPreflightPointerScope;
  detailPointer: string; nodeIndex: number; observationOrdinal: number;
}>;

const HASH = /^[0-9a-f]{64}$/;
const VERSION = /^(?:0|[1-9][0-9]*)(?:\.[0-9]+){0,2}$/;
const COVERAGE_KEYS = [
  'coverageId', 'workflowId', 'sourceId', 'evidenceSchema', 'inventorySha256', 'sourceBodySha256',
  'bodyStatus', 'coverageState', 'omissionCodes', 'omissionCounts', 'source', 'sourcePointer',
  'repository', 'commit', 'licence', 'verification',
] as const;
const EVIDENCE_KEYS = [
  'evidenceId', 'coverageId', 'workflowId', 'category', 'observation', 'requirement', 'source',
  'nodeIndex', 'observationOrdinal', 'nodePointer', 'pointerScope', 'detailPointer', 'nodeName',
  'nodeType', 'typeVersion', 'publicLabel', 'credentialReference', 'subworkflowResolution',
  'environmentNamespace', 'installation', 'credentialValidity', 'runtimeAvailability', 'ownership',
  'omissionCodes',
] as const;
type RecordValue = Readonly<Record<string, unknown>>;

function ownRecord(value: unknown, keys: readonly string[]): RecordValue | undefined {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return;
    const names = Reflect.ownKeys(value);
    if (names.length !== keys.length || names.some((name) => typeof name !== 'string' || !keys.includes(name))) return;
    const descriptors = Object.getOwnPropertyDescriptors(value); const entries: [string, unknown][] = [];
    for (const key of keys) {
      const descriptor = descriptors[key]; if (!descriptor || !('value' in descriptor)) return;
      entries.push([key, descriptor.value]);
    }
    return Object.fromEntries(entries);
  } catch { return; }
}

function utf8(left: string, right: string): number {
  const a = new TextEncoder().encode(left); const b = new TextEncoder().encode(right);
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
    if (a[index] !== b[index]) return a[index]! < b[index]! ? -1 : 1;
  }
  return a.length === b.length ? 0 : a.length < b.length ? -1 : 1;
}

function text(value: unknown): value is string { return typeof value === 'string' && value.length > 0; }
function hash(value: unknown): value is PublicSha256 { return typeof value === 'string' && HASH.test(value); }
function nonnegative(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) >= 0; }
function version(value: unknown): string | null | undefined {
  if (value === null) return null;
  if (typeof value !== 'string' && (typeof value !== 'number' || !Number.isFinite(value) || value < 0)) return;
  const normalized = String(value);
  return VERSION.test(normalized) && new TextEncoder().encode(normalized).length <= 32 ? normalized : undefined;
}
function canonicalOmissions(codeValue: unknown, countValue: unknown) {
  const codes = readPublicPreflightOmissionCodes(codeValue); const counts = readPublicPreflightOmissionCounts(countValue);
  if (!codes || !counts || codes.length !== counts.length) return;
  if (codes.some((code, index) => counts[index]?.code !== code)) return;
  return Object.freeze({ codes, counts });
}

export function isNonemptyCredentialContainer(value: unknown): boolean {
  try { return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length > 0; }
  catch { return false; }
}

export function createPublicPreflightEvidenceId(identity: PublicPreflightEvidenceIdentityV1): string {
  const canonical = JSON.stringify({
    domain: 'preflight-evidence-v1', workflowId: identity.workflowId, category: identity.category,
    pointerScope: identity.pointerScope, detailPointer: identity.detailPointer,
    nodeIndex: identity.nodeIndex, observationOrdinal: identity.observationOrdinal,
  });
  return bytesToHex(sha256(new TextEncoder().encode(canonical)));
}

export function readPublicPreflightCoverageRow(input: unknown): PublicPreflightCoverageRow | undefined {
  try {
    const row = ownRecord(input, COVERAGE_KEYS); if (!row) return;
    const omissions = canonicalOmissions(row.omissionCodes, row.omissionCounts); if (!omissions) return;
    const { coverageId, workflowId, sourceId, inventorySha256, sourceBodySha256 } = row;
    if (!text(coverageId) || coverageId !== workflowId || !text(sourceId) || !hash(inventorySha256)
      || row.evidenceSchema !== 'preflight-prerequisites-v1' || row.source !== 'WORKFLOW_EXPORT'
      || row.sourcePointer !== '/' || row.repository !== 'UNKNOWN' || row.commit !== 'UNKNOWN'
      || row.licence !== 'UNKNOWN' || row.verification !== 'UNKNOWN' || !bodyRules(row, omissions.codes)) return;
    return Object.freeze({
      coverageId, workflowId, sourceId, evidenceSchema: 'preflight-prerequisites-v1' as const,
      inventorySha256, sourceBodySha256: sourceBodySha256 as PublicSha256 | null,
      bodyStatus: row.bodyStatus as PublicPreflightBodyStatus, coverageState: row.coverageState as PublicPreflightCoverageState,
      omissionCodes: omissions.codes, omissionCounts: omissions.counts, source: 'WORKFLOW_EXPORT' as const,
      sourcePointer: '/' as const, repository: 'UNKNOWN' as const, commit: 'UNKNOWN' as const,
      licence: 'UNKNOWN' as const, verification: 'UNKNOWN' as const,
    });
  } catch { return; }
}

export function readPublicPreflightEvidenceRow(input: unknown): PublicPreflightEvidenceRow | undefined {
  try {
    const row = ownRecord(input, EVIDENCE_KEYS); if (!row) return;
    const codes = readPublicPreflightOmissionCodes(row.omissionCodes); const nodeType = row.nodeType;
    const normalizedVersion = version(row.typeVersion); const nodeIndex = row.nodeIndex; const ordinal = row.observationOrdinal;
    if (!codes || normalizedVersion === undefined || !nonnegative(nodeIndex) || !nonnegative(ordinal)
      || !text(row.evidenceId) || !HASH.test(row.evidenceId) || !text(row.coverageId) || row.coverageId !== row.workflowId
      || !text(row.workflowId) || row.requirement !== 'unknown' || row.source !== 'WORKFLOW_EXPORT' || row.nodeName !== null
      || !(row.observation === 'observed' || row.observation === 'inferred' || row.observation === 'unresolved')
      || row.nodePointer !== `/nodes/${nodeIndex}` || !PUBLIC_PREFLIGHT_POINTER_SCOPE_ORDER.includes(row.pointerScope as PublicPreflightPointerScope)
      || codes.length === 0 || !codes.includes('NODE_NAME_WITHHELD') || !categoryRules(row, `/nodes/${nodeIndex}`, nodeIndex)
      || !(row.installation === 'UNKNOWN' && row.credentialValidity === 'UNKNOWN' && row.runtimeAvailability === 'UNKNOWN' && row.ownership === 'UNKNOWN')) return;
    if (nodeType === null) { if (!codes.includes('IDENTIFIER_WITHHELD')) return; }
    else if (!PUBLIC_PREFLIGHT_NODE_TYPES.includes(nodeType as PublicPreflightNodeType)) return;
    if (row.category === 'credential' && !codes.includes('CREDENTIAL_POINTER_WITHHELD')) return;
    const identity = {
      workflowId: row.workflowId, category: row.category as PublicPreflightCategory,
      pointerScope: row.pointerScope as PublicPreflightPointerScope, detailPointer: row.detailPointer as string,
      nodeIndex, observationOrdinal: ordinal,
    };
    if (row.evidenceId !== createPublicPreflightEvidenceId(identity)) return;
    return Object.freeze({
      evidenceId: row.evidenceId, coverageId: row.coverageId, workflowId: row.workflowId,
      category: row.category as PublicPreflightCategory, observation: row.observation as PublicPreflightObservation,
      requirement: 'unknown' as const, source: 'WORKFLOW_EXPORT' as const, nodeIndex, observationOrdinal: ordinal,
      nodePointer: `/nodes/${nodeIndex}`, pointerScope: row.pointerScope as PublicPreflightPointerScope,
      detailPointer: row.detailPointer as string, nodeName: null, nodeType: nodeType as PublicPreflightNodeType | null,
      typeVersion: normalizedVersion, publicLabel: row.publicLabel as PublicPreflightPublicLabel,
      credentialReference: null, subworkflowResolution: row.subworkflowResolution as 'LITERAL' | 'DYNAMIC' | 'ABSENT' | null,
      environmentNamespace: row.environmentNamespace as 'ENV' | 'VARS' | null,
      installation: 'UNKNOWN' as const, credentialValidity: 'UNKNOWN' as const,
      runtimeAvailability: 'UNKNOWN' as const, ownership: 'UNKNOWN' as const, omissionCodes: codes,
    });
  } catch { return; }
}

export function comparePublicPreflightEvidenceRows(left: PublicPreflightEvidenceRow, right: PublicPreflightEvidenceRow): number {
  return utf8(left.workflowId, right.workflowId)
    || PUBLIC_PREFLIGHT_CATEGORY_ORDER.indexOf(left.category) - PUBLIC_PREFLIGHT_CATEGORY_ORDER.indexOf(right.category)
    || PUBLIC_PREFLIGHT_POINTER_SCOPE_ORDER.indexOf(left.pointerScope) - PUBLIC_PREFLIGHT_POINTER_SCOPE_ORDER.indexOf(right.pointerScope)
    || utf8(left.detailPointer, right.detailPointer) || left.nodeIndex - right.nodeIndex
    || left.observationOrdinal - right.observationOrdinal;
}

function readRows<T>(value: unknown, reader: (input: unknown) => T | undefined): readonly T[] | undefined {
  try {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Reflect.ownKeys(value).length !== value.length + 1) return;
    const rows: T[] = [];
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = descriptors[String(index)]; if (!descriptor || !('value' in descriptor)) return;
      const row = reader(descriptor.value); if (!row) return; rows.push(row);
    }
    return rows;
  } catch { return; }
}

export function validatePublicPreflightRelations(coverageInput: unknown, evidenceInput: unknown): boolean {
  try {
    const coverageRows = readRows(coverageInput, readPublicPreflightCoverageRow);
    const evidenceRows = readRows(evidenceInput, readPublicPreflightEvidenceRow);
    if (!coverageRows || !evidenceRows || new Set(coverageRows.map((row) => row.coverageId)).size !== coverageRows.length
      || new Set(evidenceRows.map((row) => row.evidenceId)).size !== evidenceRows.length) return false;
    if (coverageRows.some((row, index) => index > 0 && utf8(coverageRows[index - 1]!.workflowId, row.workflowId) >= 0)) return false;
    if (evidenceRows.some((row, index) => index > 0 && comparePublicPreflightEvidenceRows(evidenceRows[index - 1]!, row) >= 0)) return false;
    const coverage = new Map(coverageRows.map((row) => [row.coverageId, row])); const seenCredentials = new Set<string>();
    const carried = new Map<string, Map<PublicPreflightOmissionCode, number>>();
    for (const row of evidenceRows) {
      const parent = coverage.get(row.coverageId); if (!parent || parent.coverageState === 'COMPLETE') return false;
      if (row.category === 'credential') {
        const key = `${row.coverageId}\0${row.nodeIndex}`; if (seenCredentials.has(key)) return false; seenCredentials.add(key);
      }
      const codeCounts = carried.get(row.coverageId) ?? new Map<PublicPreflightOmissionCode, number>();
      for (const code of row.omissionCodes) codeCounts.set(code, (codeCounts.get(code) ?? 0) + 1);
      carried.set(row.coverageId, codeCounts);
    }
    for (const parent of coverageRows) {
      const codeCounts = new Map(parent.omissionCounts.map((row) => [row.code, row.count]));
      for (const [code, count] of carried.get(parent.coverageId) ?? []) {
        const coverageCount = codeCounts.get(code); if (coverageCount === undefined || coverageCount < count) return false;
      }
    }
    return true;
  } catch { return false; }
}
