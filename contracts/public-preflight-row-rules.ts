/** Cohesive body classification and category/pointer rules; no source-body existence proof. */
import {
  PUBLIC_PREFLIGHT_CATEGORY_LABELS, PUBLIC_PREFLIGHT_CATEGORY_ORDER,
  PUBLIC_PREFLIGHT_SAFE_PARAMETER_KEYS, type PublicPreflightCategory,
  type PublicPreflightOmissionCode,
} from './public-preflight-vocabulary';

type RecordValue = Readonly<Record<string, unknown>>;
const INDEX = /^(?:0|[1-9][0-9]*)$/;
const hash = (value: unknown): boolean => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);

export function bodyRules(row: RecordValue, codes: readonly PublicPreflightOmissionCode[]): boolean {
  const status = row.bodyStatus; const bodyHash = row.sourceBodySha256; const state = row.coverageState;
  const omitted: Record<string, PublicPreflightOmissionCode> = {
    MISSING: 'BODY_MISSING', SOURCE_UNAVAILABLE: 'BODY_SOURCE_UNAVAILABLE',
    UNPARSEABLE: 'BODY_UNPARSEABLE', REJECTED: 'BODY_REJECTED',
  };
  if (!(status === 'AVAILABLE' || status === 'MISSING' || status === 'SOURCE_UNAVAILABLE'
    || status === 'UNPARSEABLE' || status === 'REJECTED') || !(state === 'COMPLETE' || state === 'PARTIAL' || state === 'UNKNOWN')) return false;
  if (status === 'AVAILABLE' || status === 'UNPARSEABLE') { if (!hash(bodyHash)) return false; }
  if (status === 'MISSING' || status === 'SOURCE_UNAVAILABLE') { if (bodyHash !== null) return false; }
  if (status === 'REJECTED' && bodyHash !== null && !hash(bodyHash)) return false;
  if (codes.some((code) => Object.values(omitted).includes(code) && code !== omitted[status])) return false;
  if (status !== 'AVAILABLE' && (state !== 'UNKNOWN' || !codes.includes(omitted[status]!))) return false;
  if (state === 'COMPLETE' && codes.length > 0) return false;
  if (state !== 'COMPLETE' && codes.length === 0) return false;
  return !(state === 'UNKNOWN' && !codes.some((code) => code === 'BODY_BINDING_UNKNOWN' || code === 'COLLECTOR_REJECTED' || Object.values(omitted).includes(code)));
}

function environmentPointer(value: unknown, nodeIndex: number): value is string {
  if (typeof value !== 'string') return false;
  const prefix = `/nodes/${nodeIndex}/parameters/`;
  if (!value.startsWith(prefix) || value.length === prefix.length) return false;
  return value.slice(prefix.length).split('/').every((token) => INDEX.test(token) || PUBLIC_PREFLIGHT_SAFE_PARAMETER_KEYS.includes(token as never));
}

export function categoryRules(row: RecordValue, nodePointer: string, nodeIndex: number): boolean {
  const category = row.category; const scope = row.pointerScope; const detail = row.detailPointer; const resolution = row.subworkflowResolution;
  if (!PUBLIC_PREFLIGHT_CATEGORY_ORDER.includes(category as PublicPreflightCategory) || row.publicLabel !== PUBLIC_PREFLIGHT_CATEGORY_LABELS[category as PublicPreflightCategory]) return false;
  const noDetails = row.credentialReference === null && resolution === null && row.environmentNamespace === null;
  if (category === 'credential') return scope === 'CONTAINER' && detail === `${nodePointer}/credentials` && row.observation === 'observed' && row.observationOrdinal === 0 && noDetails;
  if (category === 'community-node' || category === 'integration') return scope === 'NODE' && detail === nodePointer && noDetails;
  if (category === 'subworkflow') {
    if (resolution !== 'LITERAL' && row.observation !== 'unresolved') return false;
    if (scope === 'FIELD') return detail === `${nodePointer}/parameters/workflowId` && (resolution === 'LITERAL' || resolution === 'DYNAMIC' || resolution === null) && row.environmentNamespace === null && row.credentialReference === null;
    return scope === 'NODE' && detail === nodePointer && resolution === 'ABSENT' && row.environmentNamespace === null && row.credentialReference === null;
  }
  return category === 'environment' && scope === 'FIELD' && environmentPointer(detail, nodeIndex)
    && (row.environmentNamespace === 'ENV' || row.environmentNamespace === 'VARS') && resolution === null && row.credentialReference === null;
}

