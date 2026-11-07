import { collectPreflightInventory } from '@hub/contracts/preflight-prerequisites';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import type {
  PreflightCommunityNodeV1, PreflightCredentialV1, PreflightEnvironmentV1, PreflightIntegrationV1,
  PreflightNodeEvidenceV1, PreflightSubworkflowV1,
} from '@hub/contracts/preflight-prerequisite-types';
import type { ScanWorkflowResult } from './engine';
import type { ScannerReportModelV2 } from './scanner-v2-presentation';
import { safeReportText } from './report/report-safe-content';

export type ReportPrerequisiteEvidence = Readonly<{
  pointer: string; node: string; nodeType: string; typeVersion: string | null;
}>;
export type ReportCredentialRow = Readonly<{
  credentialType: string; credentialName: string | null; reference: PreflightCredentialV1['reference'];
  node: string; nodeType: string; pointer: string; offlineValidity: 'UNKNOWN'; ownership: 'UNKNOWN';
}>;
export type ReportCommunityNodeRow = Readonly<{
  packageName: string | null; nodeTypes: readonly string[]; nodes: readonly string[]; typeVersions: readonly string[];
  evidence: readonly ReportPrerequisiteEvidence[]; packageVersion: null; installed: 'UNKNOWN';
}>;
export type ReportIntegrationRow = Readonly<{
  service: string; nodeType: string; nodes: readonly string[]; credentialTypes: readonly string[];
  evidence: readonly ReportPrerequisiteEvidence[];
}>;
export type ReportSubworkflowRow = Readonly<{
  node: string; pointer: string; resolution: PreflightSubworkflowV1['resolution']; targetExistence: 'UNKNOWN';
}>;
export type ReportEnvironmentRow = Readonly<{
  namespace: 'ENV' | 'VARS'; name: string; pointer: string; value: 'UNKNOWN'; availability: 'UNKNOWN';
  evidence: ReportPrerequisiteEvidence;
}>;

export type ReportPrerequisitesModel = Readonly<
  | {
      status: 'AVAILABLE'; generation: number; inputSha256: string; utf8Bytes: number; malformed: number;
      inventoryTruncated: boolean; environmentIncomplete: Readonly<{ computed: boolean; omitted: boolean }>;
      credentials: readonly ReportCredentialRow[]; communityNodes: readonly ReportCommunityNodeRow[];
      integrations: readonly ReportIntegrationRow[]; subworkflows: readonly ReportSubworkflowRow[];
      environment: readonly ReportEnvironmentRow[];
      provenance: Readonly<{ source: 'WORKFLOW_EXPORT'; pointer: '/'; repository: 'UNKNOWN';
        commit: 'UNKNOWN'; licence: 'UNKNOWN'; verification: 'UNKNOWN' }>;
      unknowns: readonly string[];
    }
  | {
      status: 'UNAVAILABLE'; generation: number; inputSha256: string;
      reason: 'COLLECTOR_FAILED' | 'IDENTITY_MISMATCH';
    }
>;

const freeze = <T>(value: T): Readonly<T> => Object.freeze(value);
const safe = (value: string): string => safeReportText(value);
const strings = (values: readonly string[]): readonly string[] => freeze(values.map(safe));

function evidence(row: PreflightNodeEvidenceV1): ReportPrerequisiteEvidence {
  return freeze({
    pointer: safe(row.pointer), node: safe(row.node), nodeType: safe(row.nodeType), typeVersion: row.typeVersion === null ? null : safe(row.typeVersion),
  });
}

function projectCredentials(rows: readonly PreflightCredentialV1[]): readonly ReportCredentialRow[] {
  return freeze(rows.map((row) => freeze({
    credentialType: safe(row.credentialType), credentialName: row.credentialName === null ? null : safe(row.credentialName),
    reference: row.reference, node: safe(row.node), nodeType: safe(row.nodeType), pointer: safe(row.pointer),
    offlineValidity: 'UNKNOWN' as const, ownership: 'UNKNOWN' as const,
  })));
}

function projectCommunityNodes(rows: readonly PreflightCommunityNodeV1[]): readonly ReportCommunityNodeRow[] {
  return freeze(rows.map((row) => freeze({
    packageName: row.packageName === null ? null : safe(row.packageName), nodeTypes: strings(row.nodeTypes), nodes: strings(row.nodes),
    typeVersions: strings(row.typeVersions), evidence: freeze(row.evidence.map(evidence)), packageVersion: null, installed: 'UNKNOWN' as const,
  })));
}

function projectIntegrations(rows: readonly PreflightIntegrationV1[]): readonly ReportIntegrationRow[] {
  return freeze(rows.map((row) => freeze({
    service: safe(row.service), nodeType: safe(row.nodeType), nodes: strings(row.nodes), credentialTypes: strings(row.credentialTypes),
    evidence: freeze(row.evidence.map(evidence)),
  })));
}

function projectSubworkflows(rows: readonly PreflightSubworkflowV1[]): readonly ReportSubworkflowRow[] {
  return freeze(rows.map((row) => freeze({
    node: safe(row.node), pointer: safe(row.pointer), resolution: row.resolution, targetExistence: 'UNKNOWN' as const,
  })));
}

function projectEnvironment(rows: readonly PreflightEnvironmentV1[]): readonly ReportEnvironmentRow[] {
  return freeze(rows.map((row) => freeze({
    namespace: row.namespace, name: safe(row.name), pointer: safe(row.evidence.pointer), value: 'UNKNOWN' as const,
    availability: 'UNKNOWN' as const, evidence: evidence(row.evidence),
  })));
}

function unavailable(generation: number, inputSha256: string, reason: 'COLLECTOR_FAILED' | 'IDENTITY_MISMATCH'): ReportPrerequisitesModel {
  return freeze({ status: 'UNAVAILABLE', generation, inputSha256, reason });
}

/** Verify the accepted scan identity before deriving a closed, display-only projection from its exact input. */
export function createPrerequisiteSidecar(json: string, generation: number, result: ScanWorkflowResult): ReportPrerequisitesModel {
  const bytes = new TextEncoder().encode(json);
  const inputSha256 = bytesToHex(sha256(bytes));
  const v2 = (result as Partial<ScannerReportModelV2>).v2;
  if (v2?.schemaVersion !== 'scanner-result-v2' || v2.input.rawSha256 !== inputSha256 || v2.input.utf8Bytes !== bytes.length) {
    return unavailable(generation, inputSha256, 'IDENTITY_MISMATCH');
  }
  try {
    const inventory = collectPreflightInventory(JSON.parse(json) as unknown);
    return freeze({
      status: 'AVAILABLE', generation, inputSha256, utf8Bytes: bytes.length, malformed: inventory.malformed,
      inventoryTruncated: inventory.inventoryTruncated, environmentIncomplete: freeze({ ...inventory.environmentIncomplete }),
      credentials: projectCredentials(inventory.prerequisites.credentials),
      communityNodes: projectCommunityNodes(inventory.prerequisites.communityNodes),
      integrations: projectIntegrations(inventory.prerequisites.integrations),
      subworkflows: projectSubworkflows(inventory.prerequisites.subworkflows),
      environment: projectEnvironment(inventory.prerequisites.environment),
      provenance: freeze({ ...inventory.prerequisites.provenance }), unknowns: strings(inventory.prerequisites.unknowns),
    });
  } catch {
    return unavailable(generation, inputSha256, 'COLLECTOR_FAILED');
  }
}
