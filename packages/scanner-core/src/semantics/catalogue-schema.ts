import type { VersionRangeV2 } from './version-range';
export type { VersionRangeV2 };

export type ScanSeverityV2 = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' | 'INFO';
export type StrictSemverV2 = string;
export type VersionComparatorV2 = Readonly<{ op: 'EQ' | 'LT' | 'LTE' | 'GT' | 'GTE'; version: StrictSemverV2 }>;
export type SemanticEffectV2 = 'READ_EXTERNAL' | 'WRITE_EXTERNAL' | 'EXECUTE_CODE' | 'EXECUTE_COMMAND' | 'READ_FILE' | 'WRITE_FILE' | 'DATABASE_READ' | 'DATABASE_WRITE' | 'SEND_MESSAGE' | 'CALL_TOOL' | 'START_SUBWORKFLOW';
export type SemanticEntryV2 = 'TRIGGER' | 'MANUAL' | 'SUBWORKFLOW' | 'NONE';
export type SemanticPathValueTypeV2 = 'ANY' | 'STRING' | 'BOOLEAN' | 'NUMBER' | 'OBJECT' | 'ARRAY';
export type SemanticChannelV2 = 'DATA' | 'CONTROL' | 'ERROR' | 'MODEL' | 'TOOL' | 'CONTEXT';
export type SemanticDirectionV2 = 'SOURCE' | 'SINK' | 'SANITIZER';
export type SemanticTaintV2 = 'CONFIDENTIALITY' | 'INTEGRITY' | 'BOTH';
export type SemanticItemModeV2 = 'EACH' | 'ALL' | 'PAIRWISE' | 'UNKNOWN';
export type SemanticErrorModeV2 = 'STOP' | 'CONTINUE' | 'OUTPUT' | 'UNKNOWN';
export type SemanticRetryModeV2 = 'NONE' | 'BOUNDED' | 'PLATFORM' | 'UNKNOWN';
export type SemanticDisabledModeV2 = 'SKIP' | 'UNKNOWN';
export type SemanticUnknownValueEffectV2 = 'UNKNOWN' | 'EXPOSED';

export type SemanticPathV2 = Readonly<{ pointer: string; valueType: SemanticPathValueTypeV2; required: boolean }>;
export type SemanticAuthenticationV2 = Readonly<{ path: string; noneValues: readonly string[]; authenticatedValues: readonly string[]; unknownValueEffect: SemanticUnknownValueEffectV2 }>;
export type SemanticEndpointV2 = Readonly<{ path: string; channel: SemanticChannelV2; direction: SemanticDirectionV2; taint: SemanticTaintV2; scope?: string }>;
export type SemanticPortV2 = Readonly<{ type: string; index: number; itemMode: SemanticItemModeV2 }>;
export type SemanticProvenanceV2 = Readonly<{ sourceUrl: string; sourceDigest: string; reviewedAt: string; reviewer: string }>;

export type ResolvedNodeSemanticsV2 = Readonly<{
  semanticId: string; nodeType: string; versionRange: VersionRangeV2; operation: string | null; entry: SemanticEntryV2;
  parameterPaths: readonly SemanticPathV2[]; authentication: SemanticAuthenticationV2 | null; credentialPaths: readonly string[]; destinationPaths: readonly string[];
  effects: readonly SemanticEffectV2[]; endpoints: readonly SemanticEndpointV2[]; ports: readonly SemanticPortV2[]; overwritePaths: readonly string[];
  errorMode: SemanticErrorModeV2; retryMode: SemanticRetryModeV2; disabledMode: SemanticDisabledModeV2; provenance: SemanticProvenanceV2;
}>;

export type SemanticCatalogueV2 = Readonly<{ schemaVersion: 'scanner-semantics-v2'; id: string; version: string; records: readonly ResolvedNodeSemanticsV2[]; configurationKeys: readonly string[]; digest: string }>;
export type SemanticCatalogueBodyV2 = Omit<SemanticCatalogueV2, 'digest'>;
export type SemanticResolutionQueryV2 = Readonly<{ nodeType: string; version: string; operation?: string | null; aliases?: readonly string[] }>;
