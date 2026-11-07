export const FIELD_FLOW_ENUMS_V1 = Object.freeze({
  sinkClass: Object.freeze(['COMMAND', 'SQL', 'HTML', 'HTTP_DESTINATION', 'SSRF', 'HEADER', 'PATH', 'CODE', 'PROMPT', 'TOOL_CONTROL'] as const),
  taintChannel: Object.freeze(['CONFIDENTIALITY', 'INTEGRITY', 'CONTROL'] as const),
  fieldFlowChannel: Object.freeze(['DATA', 'CONTROL', 'ERROR', 'MODEL', 'TOOL', 'CONTEXT'] as const),
  fieldFlowLabel: Object.freeze(['WEBHOOK_BODY', 'WEBHOOK_QUERY', 'WEBHOOK_HEADER', 'INBOUND_MESSAGE', 'EXTERNAL_HTTP_RESPONSE', 'EXTERNAL_FILE', 'AI_MODEL_OUTPUT', 'MODEL_OUTPUT', 'RETRIEVED_CONTEXT', 'TOOL_RESULT'] as const),
  fieldFlowUnknownReason: Object.freeze(['UNMODELLED_SOURCE', 'UNMODELLED_TRANSFER', 'DYNAMIC_FIELD', 'AMBIGUOUS_EDGE', 'UNSUPPORTED_SELECTOR', 'PAYLOAD_LIMIT'] as const),
  fieldFlowKnowledge: Object.freeze(['KNOWN', 'UNKNOWN'] as const), fieldFlowCoverageStatus: Object.freeze(['COMPLETE', 'LIMITED', 'FAILED'] as const),
  fieldFlowCapability: Object.freeze(['taint-confidentiality', 'taint-integrity'] as const),
  fieldFlowActiveTaintChannel: Object.freeze(['CONFIDENTIALITY', 'INTEGRITY'] as const),
  fieldFlowKind: Object.freeze(['TAINT_SINK'] as const), fieldFlowReachability: Object.freeze(['CONFIGURED'] as const),
} as const);

export const FIELD_FLOW_LABELS_BY_CHANNEL_V1 = Object.freeze({
  CONFIDENTIALITY: Object.freeze(['WEBHOOK_BODY', 'WEBHOOK_QUERY', 'WEBHOOK_HEADER', 'INBOUND_MESSAGE', 'EXTERNAL_HTTP_RESPONSE', 'EXTERNAL_FILE', 'AI_MODEL_OUTPUT'] as const),
  INTEGRITY: Object.freeze(['INBOUND_MESSAGE', 'EXTERNAL_HTTP_RESPONSE', 'EXTERNAL_FILE', 'AI_MODEL_OUTPUT', 'MODEL_OUTPUT', 'RETRIEVED_CONTEXT', 'TOOL_RESULT'] as const),
});
export type FieldFlowPropertyTypeV1 = 'STRING' | 'INTEGER' | 'STRING_LIST';

export const FIELD_FLOW_PROPERTY_TYPES_V1 = Object.freeze({
  'dataflow.provenance.v1': Object.freeze({
    sourceNodeOrdinal: 'INTEGER', sourceNodeDigest: 'STRING', sourceFieldPath: 'STRING_LIST', taintChannel: 'STRING', taintLabels: 'STRING_LIST',
  }),
  'dataflow.summary.v3': Object.freeze({
    flowKind: 'STRING', sinkClass: 'STRING', sinkParameterPath: 'STRING', sinkChannel: 'STRING', edgeChannel: 'STRING',
    taintChannel: 'STRING', taintLabels: 'STRING_LIST', sourceProvenanceFactId: 'STRING', sourceNodeOrdinal: 'INTEGER',
    sourceNodeDigest: 'STRING', sourceFieldPath: 'STRING_LIST', sinkFieldPath: 'STRING_LIST', knowledge: 'STRING',
    unknownReasons: 'STRING_LIST', omittedAtoms: 'INTEGER', omittedSanitizers: 'INTEGER', sanitizedFor: 'STRING_LIST',
    reachability: 'STRING', propertyPath: 'STRING',
  }),
  'dataflow.coverage.v1': Object.freeze({
    capabilityId: 'STRING', coverageStatus: 'STRING', fieldsExamined: 'INTEGER', knownFields: 'INTEGER', knownEmptyFields: 'INTEGER',
    unknownFields: 'INTEGER', positiveFields: 'INTEGER', emittedFlows: 'INTEGER', suppressedFlows: 'INTEGER',
    omittedAtoms: 'INTEGER', omittedSanitizers: 'INTEGER', unknownReasons: 'STRING_LIST', taintChannels: 'STRING_LIST',
    sinkChannels: 'STRING_LIST', edgeChannels: 'STRING_LIST', unmappedSources: 'INTEGER', unmappedSinks: 'INTEGER',
    unmappedPaths: 'INTEGER', redactedPaths: 'INTEGER', invalidTokens: 'INTEGER', witnessUnavailable: 'INTEGER', omittedTraceSteps: 'INTEGER',
  }),
} as const satisfies Readonly<Record<string, Readonly<Record<string, FieldFlowPropertyTypeV1>>>>);
export type FieldFlowFactKindV1 = keyof typeof FIELD_FLOW_PROPERTY_TYPES_V1;
export const FIELD_FLOW_REQUIRED_PROPERTIES_V1 = Object.freeze(Object.fromEntries(
  Object.entries(FIELD_FLOW_PROPERTY_TYPES_V1).map(([kind, properties]) => [kind, Object.freeze(Object.keys(properties).filter((key) => key !== 'propertyPath'))]),
)) as Readonly<Record<FieldFlowFactKindV1, readonly string[]>>;
export function isFieldFlowFactKindV1(kind: unknown): kind is FieldFlowFactKindV1 {
  return typeof kind === 'string' && Object.hasOwn(FIELD_FLOW_PROPERTY_TYPES_V1, kind);
}

const LEGACY_CLEARS = ['SQL', 'COMMAND', 'SSRF', 'HEADER', 'PATH', 'CODE', 'PROMPT'] as const;
const MODEL_DEFINITIONS = [
  ['encode-uri-component', 'encodeURIComponent', ['HEADER']], ['encode-uri', 'encodeURI', []],
  ['string', 'String', []], ['json-stringify', 'JSON.stringify', []],
  ['decode-uri-component', 'decodeURIComponent', []], ['decode-uri', 'decodeURI', []],
  ['number', 'Number', LEGACY_CLEARS], ['parse-int', 'parseInt', LEGACY_CLEARS], ['parse-float', 'parseFloat', LEGACY_CLEARS],
] as const;
/** Shared reviewed authority: transport readers and transfer models must use these same decisions. */
export const FIELD_FLOW_SANITIZER_MODELS_V1 = Object.freeze(MODEL_DEFINITIONS.map(([suffix, callee, clears]) => Object.freeze({
  modelId: `sf.san.v1.${suffix}`, revision: '1', callee, clears: Object.freeze([...clears]),
  scope: 'VALUE_ONLY', pathRule: 'EXACT_SINK_FIELD_PATH',
})).sort((left, right) => left.modelId < right.modelId ? -1 : left.modelId > right.modelId ? 1 : 0));
