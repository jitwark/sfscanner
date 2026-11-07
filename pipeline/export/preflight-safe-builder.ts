import { collectPreflightInventory } from '@hub/contracts/preflight-prerequisites';
import type { CorpusV2InputReceipt } from '../../scripts/lib/corpus-v2-input-inventory.js';
import {
  createPublicPreflightEvidenceId, readPublicPreflightCoverageRow, readPublicPreflightEvidenceRow,
  comparePublicPreflightEvidenceRows, type PublicPreflightCoverageRow, type PublicPreflightEvidenceRow,
} from '../../contracts/public-preflight-data.js';
import {
  PUBLIC_PREFLIGHT_CATEGORY_LABELS, PUBLIC_PREFLIGHT_NODE_TYPES, PUBLIC_PREFLIGHT_OMISSION_CODES,
  type PublicPreflightCategory, type PublicPreflightOmissionCode, type PublicPreflightOmissionCount,
} from '../../contracts/public-preflight-vocabulary.js';

export type SafePrerequisites = Readonly<{ coverage: PublicPreflightCoverageRow; evidence: readonly PublicPreflightEvidenceRow[] }>;
type Count = { count: number; basis: 'EXACT' | 'LOWER_BOUND' };
const dict = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const present = (v: unknown): boolean => typeof v === 'string' && v.length > 0;
const MAX_BYTES = 8 * 1024 * 1024;
const MAX_NODES = 10_000;

/** Runs only on the captured source value. No local collector labels or identifiers survive. */
export function buildSafePrerequisites(
  receipt: CorpusV2InputReceipt, inventorySha256: string, sourceId: string, value?: unknown,
): SafePrerequisites {
  const counts = new Map<PublicPreflightOmissionCode, Count>();
  const add = (code: PublicPreflightOmissionCode, count = 1, basis: Count['basis'] = 'EXACT') => {
    if (count === 0) return;
    const old = counts.get(code);
    counts.set(code, { count: (old?.count ?? 0) + count, basis: old?.basis === 'LOWER_BOUND' ? 'LOWER_BOUND' : basis });
  };
  const evidence: PublicPreflightEvidenceRow[] = [];
  let rejected = false;
  const omissions = () => PUBLIC_PREFLIGHT_OMISSION_CODES.filter((code) => counts.has(code));
  const finish = (): SafePrerequisites => {
    const omissionCounts: PublicPreflightOmissionCount[] = omissions().map((code) => ({ code, ...counts.get(code)! }));
    const coverage = readPublicPreflightCoverageRow({
      coverageId: receipt.entryId, workflowId: receipt.entryId, sourceId, evidenceSchema: 'preflight-prerequisites-v1',
      inventorySha256, sourceBodySha256: receipt.bodySha256, bodyStatus: receipt.status,
      coverageState: receipt.status !== 'AVAILABLE' || rejected ? 'UNKNOWN' : counts.size > 0 ? 'PARTIAL' : 'COMPLETE',
      omissionCodes: omissions(), omissionCounts, source: 'WORKFLOW_EXPORT', sourcePointer: '/',
      repository: 'UNKNOWN', commit: 'UNKNOWN', licence: 'UNKNOWN', verification: 'UNKNOWN',
    });
    if (!coverage) throw new Error('Preflight: safe coverage invariant failed');
    return { coverage, evidence: evidence.sort(comparePublicPreflightEvidenceRows) };
  };
  if (receipt.status !== 'AVAILABLE') {
    const code = { MISSING: 'BODY_MISSING', SOURCE_UNAVAILABLE: 'BODY_SOURCE_UNAVAILABLE', UNPARSEABLE: 'BODY_UNPARSEABLE', REJECTED: 'BODY_REJECTED' } as const;
    add(code[receipt.status]); return finish();
  }
  if (value === undefined || (receipt.byteLength ?? Infinity) > MAX_BYTES || !dict(value) || !Array.isArray(value.nodes)
    || value.nodes.length > MAX_NODES) {
    rejected = true; add('COLLECTOR_REJECTED'); return finish();
  }
  let inventory: ReturnType<typeof collectPreflightInventory>;
  try { inventory = collectPreflightInventory(value); }
  catch { rejected = true; add('COLLECTOR_REJECTED'); return finish(); }
  if (inventory.malformed) add('INVALID_EXPORT_EVIDENCE', inventory.malformed);
  if (inventory.inventoryTruncated) add('COLLECTOR_LIMIT', 1, 'LOWER_BOUND');
  if (inventory.environmentIncomplete.computed) add('COMPUTED_ACCESS', 1, 'LOWER_BOUND');
  if (inventory.environmentIncomplete.omitted) add('UNSAFE_PARAMETER_PATH', 1, 'LOWER_BOUND');
  const nodes = value.nodes;
  const emit = (category: PublicPreflightCategory, index: number, pointerScope: PublicPreflightEvidenceRow['pointerScope'], detailPointer: string,
    observation: PublicPreflightEvidenceRow['observation'], extra: Partial<Pick<PublicPreflightEvidenceRow, 'subworkflowResolution' | 'environmentNamespace'>> = {}, ordinal = 0,
    identifierCount = 0, credentialCount = 0) => {
    const node = nodes[index];
    if (!dict(node)) { add('INVALID_EXPORT_EVIDENCE'); return; }
    const type = PUBLIC_PREFLIGHT_NODE_TYPES.find((type) => type === node.type) ?? null;
    const version = typeof node.typeVersion === 'number' || typeof node.typeVersion === 'string' ? String(node.typeVersion) : null;
    const typeVersion = version !== null && /^(?:0|[1-9][0-9]*)(?:\.[0-9]+){0,2}$/.test(version) && version.length <= 32 ? version : null;
    const codes: PublicPreflightOmissionCode[] = ['NODE_NAME_WITHHELD'];
    add('NODE_NAME_WITHHELD');
    if (type === null) { codes.push('IDENTIFIER_WITHHELD'); identifierCount += 1; }
    if (identifierCount > 0) { if (!codes.includes('IDENTIFIER_WITHHELD')) codes.push('IDENTIFIER_WITHHELD'); add('IDENTIFIER_WITHHELD', identifierCount); }
    if (credentialCount > 0) { codes.push('CREDENTIAL_POINTER_WITHHELD'); add('CREDENTIAL_POINTER_WITHHELD', credentialCount); }
    if (category === 'subworkflow' && extra.subworkflowResolution !== 'ABSENT') { codes.push('SUBWORKFLOW_ID_WITHHELD'); add('SUBWORKFLOW_ID_WITHHELD'); }
    const identity = { workflowId: receipt.entryId, category, pointerScope, detailPointer, nodeIndex: index, observationOrdinal: ordinal };
    const row = readPublicPreflightEvidenceRow({
      evidenceId: createPublicPreflightEvidenceId(identity), coverageId: receipt.entryId, ...identity,
      observation, requirement: 'unknown', source: 'WORKFLOW_EXPORT', nodePointer: `/nodes/${index}`, nodeName: null,
      nodeType: type, typeVersion, publicLabel: PUBLIC_PREFLIGHT_CATEGORY_LABELS[category], credentialReference: null,
      subworkflowResolution: null, environmentNamespace: null, ...extra,
      installation: 'UNKNOWN', credentialValidity: 'UNKNOWN', runtimeAvailability: 'UNKNOWN', ownership: 'UNKNOWN',
      omissionCodes: PUBLIC_PREFLIGHT_OMISSION_CODES.filter((code) => codes.includes(code)),
    });
    if (!row) throw new Error('Preflight: safe evidence invariant failed');
    evidence.push(row);
  };
  // Container observations include real nodes even when their collector identity is malformed.
  nodes.forEach((node, index) => {
    if (!dict(node) || typeof node.type !== 'string' || node.type.trim().length === 0) return;
    const credentials = node.credentials;
    if (credentials !== undefined && credentials !== null && !dict(credentials)) { add('INVALID_EXPORT_EVIDENCE'); return; }
    if (!dict(credentials) || Object.keys(credentials).length === 0) return;
    const identifiers = Object.values(credentials).reduce<number>((total, leaf) => total + (dict(leaf) ? Number(present(leaf.id)) + Number(present(leaf.name)) : 0), 0);
    emit('credential', index, 'CONTAINER', `/nodes/${index}/credentials`, 'observed', {}, 0, identifiers, Object.keys(credentials).length);
  });
  const nodeIndex = (pointer: string) => Number(/^\/nodes\/(0|[1-9][0-9]*)(?:\/|$)/.exec(pointer)?.[1] ?? NaN);
  for (const group of inventory.prerequisites.communityNodes) for (const fact of group.evidence) {
    const index = nodeIndex(fact.pointer); emit('community-node', index, 'NODE', `/nodes/${index}`, 'inferred');
  }
  for (const group of inventory.prerequisites.integrations) for (const fact of group.evidence) {
    const index = nodeIndex(fact.pointer); emit('integration', index, 'NODE', `/nodes/${index}`, 'inferred');
  }
  for (const fact of inventory.prerequisites.subworkflows) {
    const index = nodeIndex(fact.pointer);
    const absent = fact.resolution === 'ABSENT' && fact.pointer === `/nodes/${index}`;
    const resolution = absent ? 'ABSENT' : fact.resolution === 'ABSENT' ? null : fact.resolution;
    emit('subworkflow', index, absent ? 'NODE' : 'FIELD', fact.pointer, resolution === 'LITERAL' ? 'observed' : 'unresolved', { subworkflowResolution: resolution });
  }
  const ordinals = new Map<string, number>();
  for (const fact of inventory.prerequisites.environment) {
    const index = nodeIndex(fact.evidence.pointer); const key = `${index}\0${fact.evidence.pointer}`;
    const ordinal = ordinals.get(key) ?? 0; ordinals.set(key, ordinal + 1);
    emit('environment', index, 'FIELD', fact.evidence.pointer, 'observed', { environmentNamespace: fact.namespace }, ordinal, 1);
  }
  return finish();
}
