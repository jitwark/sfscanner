import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { canonicalizeJson } from '../canonical-json';
import {
  FIELD_FLOW_ENUMS_V1, FIELD_FLOW_PROPERTY_TYPES_V1, FIELD_FLOW_REQUIRED_PROPERTIES_V1, FIELD_FLOW_SANITIZER_MODELS_V1,
} from '@hub/contracts/scanner-v2-field-flow';
import {
  ADVISORY_APPLICABILITY_PROPERTIES_V3, ADVISORY_APPLICABILITY_V3,
  ADVISORY_COVERAGE_REASONS_V1, ADVISORY_EVALUATION_PROPERTIES_V1,
  ADVISORY_EVALUATION_STATES_V1, ADVISORY_EVALUATION_V1, ADVISORY_OMISSION_REASONS_V1,
  ADVISORY_PACKAGE_COVERAGE_PROPERTIES_V1, ADVISORY_PACKAGE_COVERAGE_V1,
  ADVISORY_REFUSED_REASONS_V1, ADVISORY_ROW_REASONS_V1, ADVISORY_UNAVAILABLE_REASONS_V1,
} from '@hub/contracts/scanner-v2-advisory';

export type SafePropertyTypeV2 =
  | 'STRING' | 'INTEGER' | 'BOOLEAN' | 'NULLABLE_STRING' | 'STRING_LIST' | 'INTEGER_LIST';
export type SafeFactSchemaV2 = Readonly<{
  kind: string; ownerCapabilityId: string;
  properties: Readonly<Record<string, SafePropertyTypeV2>>;
  maxStringBytes: number; maxItems: number;
  sensitivity: 'PUBLIC_METADATA' | 'REDACTED_SECURITY';
}>;
export type SafeFactRegistryV2 = Readonly<{
  schemaVersion: 'scanner-safe-facts-v2'; version: string;
  schemas: readonly SafeFactSchemaV2[]; digest: string;
}>;

export type SafeFactEvidenceMappingV2 = Readonly<{
  ruleId: string; ownerCapabilityId: string; evidenceSchemaId: string;
  factKinds: readonly string[]; factProperties: readonly string[];
  factPropertiesByKind: Readonly<Record<string, readonly string[]>>;
  evidenceClass: 'CAPABILITY' | 'CONFIGURATION' | 'SUSPICIOUS_SYNTAX' | 'POTENTIAL_DATAFLOW';
}>;

export type SafeFactSubjectKindV2 = 'WORKFLOW' | 'NODE' | 'EDGE' | 'SOURCE';
export type SafeFactSpanPolicyV2 = 'NONE' | 'OPTIONAL_HALF_OPEN';

const frozenList = <T>(values: readonly T[]): readonly T[] => Object.freeze([...values]);

export const SAFE_FACT_ENUMS_V2: Readonly<Record<string, readonly string[]>> = Object.freeze({
  ...FIELD_FLOW_ENUMS_V1,
  businessCategory: frozenList(['MANUAL_AUTOMATION', 'WEBHOOK_API', 'SCHEDULED_AUTOMATION', 'DATA_SYNC', 'NOTIFICATION', 'CUSTOM_LOGIC', 'GENERAL_AUTOMATION']),
  confidence: frozenList(['LOW', 'MEDIUM', 'HIGH']), namespaceClass: frozenList(['OFFICIAL_BASE', 'OFFICIAL_SCOPED', 'NON_OFFICIAL']),
  language: frozenList(['JAVASCRIPT', 'PYTHON']), parseState: frozenList(['VERIFIED', 'RECOVERED']), flowKind: frozenList(['TAINT_SINK', 'AGENT_INFLUENCE']),
  sink: frozenList(['SQL', 'COMMAND', 'SSRF', 'HEADER', 'PATH', 'CODE', 'PROMPT']), scheme: frozenList(['HTTP', 'HTTPS', 'UNKNOWN']),
  authorityState: frozenList(['KNOWN', 'UNKNOWN']), valueMode: frozenList(['LITERAL', 'DYNAMIC', 'UNKNOWN']),
  destinationReason: frozenList(['NONE', 'DYNAMIC', 'UNSUPPORTED', 'OVERSIZED', 'MISSING_PATH', 'MALFORMED_PATH']),
  destinationErrorCode: frozenList(['MISSING_SEMANTICS', 'MISSING_PATH', 'MALFORMED_PATH', 'LIMIT_EXCEEDED', 'UNSAFE_INPUT']),
  inventoryStatus: frozenList(['COMPLETE', 'UNKNOWN', 'LIMIT_EXCEEDED', 'UNSAFE_INPUT']),
  authenticationState: frozenList(['MISSING', 'NONE', 'AUTHENTICATED', 'UNKNOWN']), applicability: frozenList(['APPLICABLE', 'NOT_APPLICABLE', 'UNKNOWN']),
  reviewState: frozenList(['ADMITTED', 'WITHDRAWN', 'REJECTED']), observation: frozenList(['AUTH_HEADER', 'SECRET_INDICATOR']),
  evaluationState: frozenList(ADVISORY_EVALUATION_STATES_V1),
  evaluationReason: frozenList(['NONE', ...ADVISORY_UNAVAILABLE_REASONS_V1, ...ADVISORY_REFUSED_REASONS_V1]),
  coverageState: frozenList(['COVERED', 'UNKNOWN']),
  coverageReason: frozenList(ADVISORY_COVERAGE_REASONS_V1),
  rowReason: frozenList(ADVISORY_ROW_REASONS_V1),
  omissionReason: frozenList(ADVISORY_OMISSION_REASONS_V1),
  secretKind: frozenList(['api key', 'password', 'token', 'secret', 'credential', 'authorization', 'cookie', 'bearer token', 'basic auth', 'Stripe API key', 'Google API key', 'AWS access key', 'Slack token', 'GitHub token', 'JWT', 'Anthropic API key', 'OpenAI API key', 'Hugging Face token', 'Replicate API token', 'opaque secret']),
  capability: frozenList(['EXECUTE_COMMAND', 'CUSTOM_CODE', 'WEBHOOK', 'AI_AGENT', 'AI_TOOL']), taintLabel: frozenList(['WEBHOOK_BODY', 'WEBHOOK_QUERY', 'WEBHOOK_HEADER', 'INBOUND_MESSAGE', 'EXTERNAL_HTTP_RESPONSE', 'EXTERNAL_FILE', 'AI_MODEL_OUTPUT']),
  indicator: frozenList(['EVAL', 'FUNCTION_CONSTRUCTOR', 'EXEC', 'DYNAMIC_IMPORT', 'SECRET_ACCESS', 'ENVIRONMENT_ACCESS', 'NETWORK_ACCESS', 'CHILD_PROCESS_METHOD', 'FILESYSTEM_ACCESS', 'SHELL_SUBPROCESS', 'CHILD_PROCESS_REQUIRE', 'CHILD_PROCESS_IMPORT', 'CHILD_PROCESS_DYNAMIC_IMPORT', 'FILESYSTEM_REQUIRE', 'FILESYSTEM_IMPORT', 'FILESYSTEM_DYNAMIC_IMPORT', 'NETWORK_REQUIRE', 'NETWORK_IMPORT', 'NETWORK_DYNAMIC_IMPORT']),
  configurationIndicator: frozenList(['SENSITIVE_KEY', 'SENSITIVE_VALUE']),
});

export const SAFE_FACT_SUBJECT_KINDS_V2: Readonly<Record<string, readonly SafeFactSubjectKindV2[]>> = Object.freeze({
  'workflow.summary.v1': frozenList<SafeFactSubjectKindV2>(['WORKFLOW']), 'workflow.structure.v1': frozenList<SafeFactSubjectKindV2>(['WORKFLOW']), 'workflow.dependencies.v1': frozenList<SafeFactSubjectKindV2>(['WORKFLOW']), 'workflow.effects.v1': frozenList<SafeFactSubjectKindV2>(['WORKFLOW']), 'workflow.function.v1': frozenList<SafeFactSubjectKindV2>(['WORKFLOW']), 'workflow.risk-summary.v1': frozenList<SafeFactSubjectKindV2>(['WORKFLOW']),
  'workflow.fingerprint.v1': frozenList<SafeFactSubjectKindV2>(['WORKFLOW']), 'integration.v1': frozenList<SafeFactSubjectKindV2>(['WORKFLOW']), 'node.capability.v2': frozenList<SafeFactSubjectKindV2>(['NODE']),
  'node.configuration.v2': frozenList<SafeFactSubjectKindV2>(['SOURCE']), 'code.indicator.v2': frozenList<SafeFactSubjectKindV2>(['SOURCE']), 'dataflow.summary.v2': frozenList<SafeFactSubjectKindV2>(['SOURCE', 'NODE']),
  'destination.v2': frozenList<SafeFactSubjectKindV2>(['SOURCE']), 'destination.v3': frozenList<SafeFactSubjectKindV2>(['SOURCE']), 'destination.coverage.v1': frozenList<SafeFactSubjectKindV2>(['WORKFLOW']), 'ingress.v2': frozenList<SafeFactSubjectKindV2>(['NODE']),
  [ADVISORY_EVALUATION_V1]: frozenList<SafeFactSubjectKindV2>(['WORKFLOW']),
  [ADVISORY_PACKAGE_COVERAGE_V1]: frozenList<SafeFactSubjectKindV2>(['WORKFLOW']),
  [ADVISORY_APPLICABILITY_V3]: frozenList<SafeFactSubjectKindV2>(['WORKFLOW']),
  'dataflow.provenance.v1': frozenList<SafeFactSubjectKindV2>(['NODE']), 'dataflow.summary.v3': frozenList<SafeFactSubjectKindV2>(['NODE']),
  'dataflow.coverage.v1': frozenList<SafeFactSubjectKindV2>(['WORKFLOW']),
});

export const SAFE_FACT_SPAN_POLICIES_V2: Readonly<Record<string, SafeFactSpanPolicyV2>> = Object.freeze({
  'workflow.summary.v1': 'NONE', 'workflow.structure.v1': 'NONE', 'workflow.dependencies.v1': 'NONE', 'workflow.effects.v1': 'NONE', 'workflow.function.v1': 'NONE', 'workflow.risk-summary.v1': 'NONE', 'workflow.fingerprint.v1': 'NONE',
  'integration.v1': 'NONE', 'node.capability.v2': 'OPTIONAL_HALF_OPEN', 'node.configuration.v2': 'OPTIONAL_HALF_OPEN',
  'code.indicator.v2': 'OPTIONAL_HALF_OPEN', 'dataflow.summary.v2': 'OPTIONAL_HALF_OPEN', 'destination.v2': 'OPTIONAL_HALF_OPEN',
  'destination.v3': 'OPTIONAL_HALF_OPEN', 'destination.coverage.v1': 'NONE',
  'ingress.v2': 'OPTIONAL_HALF_OPEN', [ADVISORY_EVALUATION_V1]: 'NONE',
  [ADVISORY_PACKAGE_COVERAGE_V1]: 'NONE', [ADVISORY_APPLICABILITY_V3]: 'NONE',
  'dataflow.provenance.v1': 'OPTIONAL_HALF_OPEN', 'dataflow.summary.v3': 'OPTIONAL_HALF_OPEN', 'dataflow.coverage.v1': 'NONE',
});

export const SAFE_FACT_REQUIRED_PROPERTIES_V2: Readonly<Record<string, readonly string[]>> = Object.freeze({
  'workflow.summary.v1': frozenList(['connectionCount']), 'workflow.structure.v1': frozenList(['total', 'executable', 'disabled', 'inert', 'unresolved', 'vertices', 'edges', 'unresolvedEdges', 'parallelEdgeCount', 'weakComponents', 'structuralCycleRank']), 'workflow.dependencies.v1': frozenList(['totalNodes', 'reviewedNodes', 'assumedNodes', 'unknownNodes', 'credentialReferences', 'requiredCredentialSlots', 'configuredCredentialSlots', 'missingCredentialSlots', 'unknownCredentialSlots', 'environmentReferences', 'redactedIdentifiers', 'omittedIdentifiers']), 'workflow.effects.v1': frozenList(['totalNodes', 'reviewedNodes', 'assumedNodes', 'unknownNodes', 'effectCounts', 'disabledEffectNodes']), 'workflow.function.v1': frozenList(['basicPurpose', 'triggerDescription', 'dataFlowSummary', 'businessCategory', 'confidence']),
  'workflow.risk-summary.v1': frozenList(['topRisks', 'dataExposure', 'complexityDrivers']), 'workflow.fingerprint.v1': frozenList(['value']),
  'integration.v1': frozenList(['service', 'usage', 'nodeTypes', 'nodeCount', 'riskNotes']), 'node.capability.v2': frozenList(['nodeType', 'nodePackage', 'namespaceClass', 'capabilities', 'toolCount', 'contextCount']),
  'node.configuration.v2': frozenList(['observation']), 'code.indicator.v2': frozenList(['language', 'indicator', 'start', 'end', 'parseState']),
  'dataflow.summary.v2': frozenList(['flowKind', 'propertyPathComplete', 'humanGatePresent', 'humanGateDominates', 'taintLabels']),
  'destination.v2': frozenList(['parameterPath', 'scheme', 'hostname', 'authorityState', 'valueMode']), 'destination.v3': frozenList(['parameterPath', 'scheme', 'hostname', 'authorityState', 'valueMode', 'reason', 'omitted', 'inventoryStatus']),
  'destination.coverage.v1': frozenList(['inventoryStatus', 'nodesExamined', 'pathsConfigured', 'recordsEmitted', 'errors', 'omitted', 'errorCodes']), 'ingress.v2': frozenList(['authentication', 'authenticationState', 'legacyAuthenticated']),
  [ADVISORY_EVALUATION_V1]: frozenList(ADVISORY_EVALUATION_PROPERTIES_V1),
  [ADVISORY_PACKAGE_COVERAGE_V1]: frozenList(ADVISORY_PACKAGE_COVERAGE_PROPERTIES_V1),
  [ADVISORY_APPLICABILITY_V3]: frozenList(ADVISORY_APPLICABILITY_PROPERTIES_V3),
  ...FIELD_FLOW_REQUIRED_PROPERTIES_V1,
});

const STRING_BYTES = 4_096;
const schema = (
  kind: string, ownerCapabilityId: string,
  properties: Record<string, SafePropertyTypeV2>,
  sensitivity: SafeFactSchemaV2['sensitivity'],
): SafeFactSchemaV2 => Object.freeze({
  kind, ownerCapabilityId, properties: Object.freeze(properties),
  maxStringBytes: STRING_BYTES, maxItems: kind.startsWith('advisory.') ? 1000 : STRING_BYTES, sensitivity,
});

const schemas: readonly SafeFactSchemaV2[] = Object.freeze([
  schema('workflow.summary.v1', 'workflow-insights', { connectionCount: 'INTEGER' }, 'PUBLIC_METADATA'),
  schema('workflow.dependencies.v1', 'structural-policies', {
    totalNodes: 'INTEGER', reviewedNodes: 'INTEGER', assumedNodes: 'INTEGER', unknownNodes: 'INTEGER',
    credentialReferences: 'INTEGER', requiredCredentialSlots: 'INTEGER', configuredCredentialSlots: 'INTEGER',
    missingCredentialSlots: 'INTEGER', unknownCredentialSlots: 'INTEGER', environmentReferences: 'INTEGER',
    redactedIdentifiers: 'INTEGER', omittedIdentifiers: 'INTEGER',
  }, 'REDACTED_SECURITY'),
  schema('workflow.effects.v1', 'structural-policies', {
    totalNodes: 'INTEGER', reviewedNodes: 'INTEGER', assumedNodes: 'INTEGER', unknownNodes: 'INTEGER',
    effectCounts: 'INTEGER_LIST', disabledEffectNodes: 'INTEGER',
  }, 'REDACTED_SECURITY'),
  schema('workflow.structure.v1', 'structural-policies', {
    total: 'INTEGER', executable: 'INTEGER', disabled: 'INTEGER', inert: 'INTEGER', unresolved: 'INTEGER',
    vertices: 'INTEGER', edges: 'INTEGER', unresolvedEdges: 'INTEGER', parallelEdgeCount: 'INTEGER',
    weakComponents: 'INTEGER', structuralCycleRank: 'INTEGER',
  }, 'PUBLIC_METADATA'),
  schema('workflow.function.v1', 'workflow-insights', {
    basicPurpose: 'STRING', triggerDescription: 'STRING', dataFlowSummary: 'STRING',
    businessCategory: 'STRING', confidence: 'STRING',
  }, 'PUBLIC_METADATA'),
  schema('workflow.risk-summary.v1', 'workflow-insights', {
    topRisks: 'STRING_LIST', dataExposure: 'STRING', complexityDrivers: 'STRING_LIST',
  }, 'REDACTED_SECURITY'),
  schema('workflow.fingerprint.v1', 'source-normalization', { value: 'STRING' }, 'PUBLIC_METADATA'),
  schema('integration.v1', 'workflow-insights', {
    service: 'STRING', usage: 'STRING', nodeTypes: 'STRING_LIST', nodeCount: 'INTEGER', riskNotes: 'STRING_LIST',
  }, 'REDACTED_SECURITY'),
  schema('node.capability.v2', 'structural-policies', {
    nodeType: 'STRING', nodePackage: 'STRING', namespaceClass: 'STRING', capabilities: 'STRING_LIST',
    toolCount: 'INTEGER', contextCount: 'INTEGER',
  }, 'REDACTED_SECURITY'),
  schema('node.configuration.v2', 'structural-policies', {
    observation: 'STRING', header: 'NULLABLE_STRING', literalValue: 'BOOLEAN', parameterPath: 'STRING',
    secretKind: 'STRING', indicator: 'STRING', hasLiteralValue: 'BOOLEAN',
  }, 'REDACTED_SECURITY'),
  schema('code.indicator.v2', 'expression-security', {
    language: 'STRING', indicator: 'STRING', member: 'STRING', start: 'INTEGER', end: 'INTEGER', parseState: 'STRING',
  }, 'REDACTED_SECURITY'),
  schema('dataflow.summary.v2', 'graph-semantics', {
    flowKind: 'STRING', sink: 'STRING', parameterPath: 'STRING', referenceRoot: 'STRING', propertyPath: 'STRING',
    sourceNodeId: 'STRING', sourceNodeName: 'STRING', propertyPathComplete: 'BOOLEAN',
    humanGatePresent: 'BOOLEAN', humanGateDominates: 'BOOLEAN', taintLabels: 'STRING_LIST',
  }, 'REDACTED_SECURITY'),
  ...Object.entries(FIELD_FLOW_PROPERTY_TYPES_V1).map(([kind, properties]) => schema(kind, 'graph-semantics', properties, 'REDACTED_SECURITY')),
  schema('destination.v2', 'structural-policies', {
    parameterPath: 'STRING', scheme: 'STRING', hostname: 'NULLABLE_STRING', authorityState: 'STRING', valueMode: 'STRING',
  }, 'REDACTED_SECURITY'),
  schema('destination.v3', 'structural-policies', {
    parameterPath: 'STRING', scheme: 'STRING', hostname: 'NULLABLE_STRING', authorityState: 'STRING', valueMode: 'STRING',
    reason: 'STRING', omitted: 'INTEGER', inventoryStatus: 'STRING',
  }, 'REDACTED_SECURITY'),
  schema('destination.coverage.v1', 'structural-policies', {
    inventoryStatus: 'STRING', nodesExamined: 'INTEGER', pathsConfigured: 'INTEGER', recordsEmitted: 'INTEGER',
    errors: 'INTEGER', omitted: 'INTEGER', errorCodes: 'STRING_LIST',
  }, 'REDACTED_SECURITY'),
  schema('ingress.v2', 'structural-policies', {
    authentication: 'NULLABLE_STRING', authenticationState: 'STRING', legacyAuthenticated: 'BOOLEAN',
  }, 'REDACTED_SECURITY'),
  schema(ADVISORY_EVALUATION_V1, 'assessment', {
    evaluationState: 'STRING', evaluationReason: 'STRING', targetDigest: 'STRING',
    sourceId: 'NULLABLE_STRING', pinDigest: 'NULLABLE_STRING', coverageDigest: 'NULLABLE_STRING',
    rightsReceiptDigest: 'NULLABLE_STRING', provenanceReceiptDigest: 'NULLABLE_STRING',
    boundsDigest: 'NULLABLE_STRING', admissionReceiptDigest: 'NULLABLE_STRING',
    pinnedSnapshotSha256: 'NULLABLE_STRING', snapshotSha256: 'NULLABLE_STRING',
    capturedAt: 'NULLABLE_STRING', admittedAt: 'NULLABLE_STRING', evaluatedAt: 'NULLABLE_STRING',
    catalogueVersion: 'NULLABLE_STRING', catalogueDigest: 'NULLABLE_STRING', coverageClaimed: 'BOOLEAN',
    packagesRequested: 'INTEGER', packagesCovered: 'INTEGER', packageRowsOmitted: 'INTEGER',
    recordsExamined: 'INTEGER', recordsApplicable: 'INTEGER', recordsNotApplicable: 'INTEGER',
    recordsUnknown: 'INTEGER', omissionReasons: 'STRING_LIST',
  }, 'REDACTED_SECURITY'),
  schema(ADVISORY_PACKAGE_COVERAGE_V1, 'assessment', {
    packageName: 'STRING', packageVersion: 'NULLABLE_STRING', coverageState: 'STRING', coverageReason: 'STRING',
  }, 'REDACTED_SECURITY'),
  schema(ADVISORY_APPLICABILITY_V3, 'assessment', {
    advisoryId: 'STRING', packageName: 'STRING', installedVersion: 'NULLABLE_STRING', reviewState: 'STRING',
    applicability: 'STRING', rowReason: 'STRING', matchedPrerequisites: 'STRING_LIST', unknownPrerequisites: 'STRING_LIST',
  }, 'REDACTED_SECURITY'),
]);

const mapping = (
  ruleId: string, ownerCapabilityId: string, evidenceSchemaId: string,
  factKinds: readonly string[], factProperties: readonly string[],
  evidenceClass: SafeFactEvidenceMappingV2['evidenceClass'],
  factPropertiesByKind: Readonly<Record<string, readonly string[]>> = Object.fromEntries(factKinds.map((kind) => [kind, factProperties])),
): SafeFactEvidenceMappingV2 => Object.freeze({
  ruleId, ownerCapabilityId, evidenceSchemaId,
  factKinds: Object.freeze([...factKinds]), factProperties: Object.freeze([...factProperties]),
  factPropertiesByKind: Object.freeze(Object.fromEntries(Object.entries(factPropertiesByKind).map(([kind, properties]) => [kind, Object.freeze([...properties])]))) as Readonly<Record<string, readonly string[]>>,
  evidenceClass,
});

export const TAINTED_RULE_SINK_CLASSES_V1: Readonly<Record<string, (typeof FIELD_FLOW_ENUMS_V1.sinkClass)[number]>> = Object.freeze({
  TAINTED_COMMAND: 'COMMAND', TAINTED_SQL_QUERY: 'SQL', TAINTED_REQUEST_URL: 'SSRF',
  TAINTED_FILE_PATH: 'PATH', TAINTED_CODE_INPUT: 'CODE', TAINTED_REQUEST_HEADER: 'HEADER', TAINTED_AI_PROMPT: 'PROMPT',
});
const taintProperties = Object.freeze([...FIELD_FLOW_REQUIRED_PROPERTIES_V1['dataflow.summary.v3'], 'propertyPath']);

export const SAFE_FACT_EVIDENCE_MAPPINGS_V2: readonly SafeFactEvidenceMappingV2[] = Object.freeze([
  mapping('N8N_EXECUTE_COMMAND', 'structural-policies', 'v1.node-type', ['node.capability.v2'], ['nodeType'], 'CAPABILITY'),
  mapping('N8N_CODE_NODE', 'structural-policies', 'v1.node-type', ['node.capability.v2'], ['nodeType'], 'CAPABILITY'),
  mapping('RAW_AUTH_HEADER', 'structural-policies', 'v1.auth-header', ['node.configuration.v2'], ['header', 'literalValue'], 'CONFIGURATION'),
  mapping('RAW_SECRET_INDICATOR', 'structural-policies', 'v1.secret-indicator', ['node.configuration.v2'], ['parameterPath', 'secretKind', 'indicator', 'hasLiteralValue'], 'CONFIGURATION'),
  mapping('UNAPPROVED_DOMAIN', 'structural-policies', 'v1.domain', ['destination.v2'], ['hostname'], 'CONFIGURATION'),
  mapping('UNKNOWN_NODE_PACKAGE', 'structural-policies', 'v1.node-package', ['node.capability.v2'], ['nodeType', 'nodePackage'], 'CONFIGURATION'),
  mapping('WEBHOOK_EXPOSURE', 'structural-policies', 'v1.webhook-auth', ['ingress.v2'], ['authentication'], 'CONFIGURATION'),
  mapping('JAVASCRIPT_DYNAMIC_EXECUTION', 'javascript-security', 'v1.code-indicator', ['code.indicator.v2'], ['indicator', 'member', 'start', 'end'], 'SUSPICIOUS_SYNTAX'),
  mapping('PYTHON_DYNAMIC_EXECUTION', 'python-security', 'v1.code-indicator', ['code.indicator.v2'], ['indicator', 'member', 'start', 'end'], 'SUSPICIOUS_SYNTAX'),
  mapping('TAINTED_COMMAND', 'taint-integrity', 'v1.taint', ['dataflow.summary.v3'], taintProperties, 'POTENTIAL_DATAFLOW'),
  mapping('TAINTED_SQL_QUERY', 'taint-integrity', 'v1.taint', ['dataflow.summary.v3'], taintProperties, 'POTENTIAL_DATAFLOW'),
  mapping('TAINTED_REQUEST_URL', 'taint-integrity', 'v1.taint', ['dataflow.summary.v3'], taintProperties, 'POTENTIAL_DATAFLOW'),
  mapping('TAINTED_FILE_PATH', 'taint-integrity', 'v1.taint', ['dataflow.summary.v3'], taintProperties, 'POTENTIAL_DATAFLOW'),
  mapping('TAINTED_CODE_INPUT', 'taint-integrity', 'v1.taint', ['dataflow.summary.v3'], taintProperties, 'POTENTIAL_DATAFLOW'),
  mapping('TAINTED_REQUEST_HEADER', 'taint-integrity', 'v1.taint', ['dataflow.summary.v3'], taintProperties, 'POTENTIAL_DATAFLOW'),
  mapping('TAINTED_AI_PROMPT', 'taint-integrity', 'v1.taint', ['dataflow.summary.v3'], taintProperties, 'POTENTIAL_DATAFLOW'),
  mapping('AI_AGENT_UNGATED_TOOL', 'agentic-control', 'v1.agent-control', ['node.capability.v2', 'dataflow.summary.v2'], ['toolCount', 'contextCount', 'taintLabels', 'humanGatePresent', 'humanGateDominates'], 'CAPABILITY', { 'node.capability.v2': ['toolCount', 'contextCount'], 'dataflow.summary.v2': ['taintLabels', 'humanGatePresent', 'humanGateDominates'] }),
]);

const body = Object.freeze({ schemaVersion: 'scanner-safe-facts-v2' as const, version: '2.5.0', schemas });
export const SAFE_FACT_REGISTRY_V2: SafeFactRegistryV2 = Object.freeze({
  ...body, digest: bytesToHex(sha256(new TextEncoder().encode(canonicalizeJson(body)))),
});
const authorityBody = Object.freeze({
  ...body, enums: SAFE_FACT_ENUMS_V2, subjects: SAFE_FACT_SUBJECT_KINDS_V2, spans: SAFE_FACT_SPAN_POLICIES_V2,
  requiredProperties: SAFE_FACT_REQUIRED_PROPERTIES_V2, evidenceMappings: SAFE_FACT_EVIDENCE_MAPPINGS_V2,
  sanitizers: FIELD_FLOW_SANITIZER_MODELS_V1,
  taintRuleSinkClasses: TAINTED_RULE_SINK_CLASSES_V1,
});
export const SAFE_FACT_AUTHORITY_DIGEST_V2 = bytesToHex(sha256(new TextEncoder().encode(canonicalizeJson(authorityBody))));
