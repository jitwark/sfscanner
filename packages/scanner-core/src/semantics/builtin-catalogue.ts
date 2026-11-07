import { admitSemanticCatalogue, createSemanticCatalogueDigest } from './catalogue-admission';
import { builtinSourceProvenance } from './builtin-provenance';
import type {
  ResolvedNodeSemanticsV2, SemanticAuthenticationV2, SemanticCatalogueBodyV2, SemanticCatalogueV2,
  SemanticChannelV2, SemanticDirectionV2, SemanticEndpointV2, SemanticItemModeV2,
  SemanticPathV2, SemanticPathValueTypeV2, SemanticPortV2, SemanticProvenanceV2, SemanticTaintV2,
} from './catalogue-schema';
import type { VersionRangeV2 } from './version-range';

const CORE_DOCS = 'https://docs.n8n.io/integrations/builtin/core-nodes/';
const LANGCHAIN_DOCS = 'https://docs.n8n.io/integrations/builtin/cluster-nodes/';

type OptionalFields = Partial<Omit<ResolvedNodeSemanticsV2, 'semanticId' | 'nodeType'>>;
const range = (op: 'GTE' | 'EQ' = 'GTE', version = '1.0.0'): VersionRangeV2 => ({ clauses: [[{ op, version }]] });
const versions = (values: readonly string[]): VersionRangeV2 => ({
  clauses: values.map((version) => [{ op: 'EQ' as const, version }]),
});
const provenance = (semanticId: string, sourceUrl: string): SemanticProvenanceV2 => builtinSourceProvenance(semanticId, sourceUrl);
const parameter = (pointer: string, valueType: SemanticPathValueTypeV2 = 'ANY', required = false): SemanticPathV2 => ({ pointer, valueType, required });
const endpoint = (path: string, channel: SemanticChannelV2 = 'DATA', direction: SemanticDirectionV2 = 'SINK', taint: SemanticTaintV2 = 'BOTH'): SemanticEndpointV2 => ({ path, channel, direction, taint });
const port = (type = 'main', index = 0, itemMode: SemanticItemModeV2 = 'EACH'): SemanticPortV2 => ({ type, index, itemMode });
const auth = (path: string, noneValues: readonly string[], authenticatedValues: readonly string[]): SemanticAuthenticationV2 => ({ path, noneValues, authenticatedValues, unknownValueEffect: 'EXPOSED' });
const record = (semanticId: string, nodeType: string, fields: OptionalFields = {}, sourceUrl = nodeType.startsWith('@') ? LANGCHAIN_DOCS : CORE_DOCS): ResolvedNodeSemanticsV2 => ({
  semanticId, nodeType, versionRange: fields.versionRange ?? range(), operation: fields.operation ?? null, entry: fields.entry ?? 'NONE',
  parameterPaths: fields.parameterPaths ?? [], authentication: fields.authentication ?? null, credentialPaths: fields.credentialPaths ?? [],
  destinationPaths: fields.destinationPaths ?? [], effects: fields.effects ?? [], endpoints: fields.endpoints ?? [], ports: fields.ports ?? [port()],
  overwritePaths: fields.overwritePaths ?? [], errorMode: fields.errorMode ?? 'UNKNOWN', retryMode: fields.retryMode ?? 'UNKNOWN',
  disabledMode: fields.disabledMode ?? 'SKIP', provenance: fields.provenance ?? provenance(semanticId, sourceUrl),
});

const records: ResolvedNodeSemanticsV2[] = [
  record('ingress.webhook', 'n8n-nodes-base.webhook', { entry: 'TRIGGER', parameterPaths: [parameter('/path', 'STRING', true), parameter('/authentication', 'STRING')], authentication: auth('/authentication', ['none'], ['basicAuth', 'headerAuth', 'jwtAuth']), endpoints: [endpoint('/body', 'DATA', 'SOURCE')], ports: [port()], errorMode: 'STOP', retryMode: 'PLATFORM' }),
  record('ingress.form-trigger', 'n8n-nodes-base.formTrigger', { entry: 'TRIGGER', parameterPaths: [parameter('/path', 'STRING', true), parameter('/authentication', 'STRING')], authentication: auth('/authentication', ['none'], ['basicAuth']), endpoints: [endpoint('/form', 'DATA', 'SOURCE')], ports: [port()], errorMode: 'STOP', retryMode: 'PLATFORM' }),
  record('ingress.chat-trigger', '@n8n/n8n-nodes-langchain.chatTrigger', { entry: 'TRIGGER', parameterPaths: [parameter('/path', 'STRING', true), parameter('/authentication', 'STRING')], authentication: auth('/authentication', ['none'], ['basicAuth']), endpoints: [endpoint('/chatInput', 'DATA', 'SOURCE')], ports: [port()], errorMode: 'STOP', retryMode: 'PLATFORM' }),
  record('ingress.manual-trigger', 'n8n-nodes-base.manualTrigger', { entry: 'MANUAL', ports: [port()], errorMode: 'STOP', retryMode: 'NONE' }),

  record('http-ai.http-request', 'n8n-nodes-base.httpRequest', { parameterPaths: [parameter('/url', 'STRING', true), parameter('/method', 'STRING')], credentialPaths: ['/credentials/httpRequestAuth'], destinationPaths: ['/url'], effects: ['READ_EXTERNAL', 'WRITE_EXTERNAL'], endpoints: [endpoint('/url', 'DATA', 'SINK', 'BOTH')], ports: [port()], retryMode: 'PLATFORM' }),
  record('http-ai.http-request.request', 'n8n-nodes-base.httpRequest', { versionRange: range('EQ'), operation: 'request', parameterPaths: [parameter('/url', 'STRING', true), parameter('/method', 'STRING')], credentialPaths: ['/credentials/httpRequestAuth'], destinationPaths: ['/url'], effects: ['READ_EXTERNAL', 'WRITE_EXTERNAL'], endpoints: [endpoint('/url', 'DATA', 'SINK', 'BOTH')], ports: [port()], errorMode: 'CONTINUE', retryMode: 'BOUNDED' }),
  record('http-ai.openai', 'n8n-nodes-base.openAi', { parameterPaths: [parameter('/resource', 'STRING', true), parameter('/operation', 'STRING', true), parameter('/prompt', 'STRING')], credentialPaths: ['/credentials/openAiApi'], destinationPaths: ['/options/baseURL'], effects: ['READ_EXTERNAL', 'WRITE_EXTERNAL'], endpoints: [endpoint('/prompt', 'MODEL', 'SINK', 'BOTH')], ports: [port()], retryMode: 'PLATFORM' }),
  record('http-ai.ai-agent', '@n8n/n8n-nodes-langchain.agent', { parameterPaths: [parameter('/options/systemMessage', 'STRING')], credentialPaths: ['/credentials'], destinationPaths: ['/options/baseURL'], effects: ['CALL_TOOL', 'READ_EXTERNAL', 'WRITE_EXTERNAL'], endpoints: [endpoint('/options/systemMessage', 'MODEL', 'SINK', 'BOTH')], ports: [port(), port('ai_tool', 0, 'ALL')], retryMode: 'PLATFORM' }),
  record('http-ai.chat-model', '@n8n/n8n-nodes-langchain.lmChatOpenAi', { parameterPaths: [parameter('/modelName', 'STRING', true), parameter('/options', 'OBJECT')], credentialPaths: ['/credentials/openAiApi'], destinationPaths: ['/options/baseURL'], effects: ['READ_EXTERNAL', 'WRITE_EXTERNAL'], endpoints: [endpoint('/modelName', 'MODEL', 'SINK', 'BOTH')], ports: [port()], retryMode: 'PLATFORM' }),

  record('database-file.postgres', 'n8n-nodes-base.postgres', { parameterPaths: [parameter('/operation', 'STRING', true), parameter('/query', 'STRING')], credentialPaths: ['/credentials/postgres'], destinationPaths: ['/options/host', '/options/database'], effects: ['DATABASE_READ', 'DATABASE_WRITE'], endpoints: [endpoint('/query', 'DATA', 'SINK', 'BOTH')], ports: [port()], retryMode: 'BOUNDED' }),
  record('database-file.mysql', 'n8n-nodes-base.mySql', { parameterPaths: [parameter('/operation', 'STRING', true), parameter('/query', 'STRING')], credentialPaths: ['/credentials/mySql'], destinationPaths: ['/options/host', '/options/database'], effects: ['DATABASE_READ', 'DATABASE_WRITE'], endpoints: [endpoint('/query', 'DATA', 'SINK', 'BOTH')], ports: [port()], retryMode: 'BOUNDED' }),
  record('database-file.read-binary-file', 'n8n-nodes-base.readBinaryFile', { parameterPaths: [parameter('/filePath', 'STRING', true)], destinationPaths: ['/filePath'], effects: ['READ_FILE'], endpoints: [endpoint('/filePath', 'DATA', 'SINK', 'CONFIDENTIALITY')], ports: [port()], retryMode: 'NONE' }),
  record('database-file.write-binary-file', 'n8n-nodes-base.writeBinaryFile', { parameterPaths: [parameter('/fileName', 'STRING', true)], destinationPaths: ['/fileName'], effects: ['WRITE_FILE'], endpoints: [endpoint('/fileName', 'DATA', 'SINK', 'INTEGRITY')], ports: [port()], overwritePaths: ['/fileName'], retryMode: 'NONE' }),

  record('code-command.execute-command', 'n8n-nodes-base.executeCommand', { parameterPaths: [parameter('/command', 'STRING', true)], effects: ['EXECUTE_COMMAND'], ports: [port()], errorMode: 'STOP', retryMode: 'NONE' }),
  record('code-command.code', 'n8n-nodes-base.code', { parameterPaths: [parameter('/jsCode', 'STRING', true), parameter('/mode', 'STRING')], effects: ['EXECUTE_CODE'], ports: [port()], errorMode: 'STOP', retryMode: 'NONE' }),
  record('code-command.langchain-tool-code', '@n8n/n8n-nodes-langchain.toolCode', { parameterPaths: [parameter('/jsCode', 'STRING'), parameter('/pythonCode', 'STRING'), parameter('/language', 'STRING')], effects: ['EXECUTE_CODE'], ports: [port(), port('ai_tool', 0, 'ALL')], errorMode: 'STOP', retryMode: 'NONE' }),
  record('code-command.langchain-code', '@n8n/n8n-nodes-langchain.code', { parameterPaths: [parameter('/code/execute/code', 'STRING'), parameter('/code/supplyData/code', 'STRING')], effects: ['EXECUTE_CODE'], ports: [], errorMode: 'UNKNOWN', retryMode: 'NONE' }),

  record('message-mcp.slack', 'n8n-nodes-base.slack', { parameterPaths: [parameter('/channelId', 'STRING', true), parameter('/text', 'STRING', true)], credentialPaths: ['/credentials/slackApi'], destinationPaths: ['/channelId'], effects: ['SEND_MESSAGE'], endpoints: [endpoint('/text', 'DATA', 'SINK', 'CONFIDENTIALITY')], ports: [port()], errorMode: 'CONTINUE', retryMode: 'BOUNDED' }),
  record('message-mcp.email-send', 'n8n-nodes-base.emailSend', { parameterPaths: [parameter('/to', 'STRING', true), parameter('/subject', 'STRING'), parameter('/text', 'STRING')], credentialPaths: ['/credentials/smtp'], destinationPaths: ['/to'], effects: ['SEND_MESSAGE'], endpoints: [endpoint('/text', 'DATA', 'SINK', 'CONFIDENTIALITY')], ports: [port()], errorMode: 'CONTINUE', retryMode: 'BOUNDED' }),
  record('message-mcp.tool-mcp', '@n8n/n8n-nodes-langchain.toolMcp', { parameterPaths: [parameter('/serverUrl', 'STRING', true), parameter('/tool', 'STRING')], credentialPaths: ['/credentials'], destinationPaths: ['/serverUrl'], effects: ['CALL_TOOL'], endpoints: [endpoint('/serverUrl', 'TOOL', 'SINK', 'BOTH')], ports: [port(), port('ai_tool', 0, 'ALL')], errorMode: 'STOP', retryMode: 'BOUNDED' }),

  record('subworkflow.execute-workflow-trigger', 'n8n-nodes-base.executeWorkflowTrigger', { entry: 'SUBWORKFLOW', parameterPaths: [parameter('/workflowInputs', 'OBJECT')], endpoints: [], ports: [port()], errorMode: 'STOP', retryMode: 'NONE' }),
  record('subworkflow.execute-workflow', 'n8n-nodes-base.executeWorkflow', { parameterPaths: [parameter('/workflowId', 'STRING', true), parameter('/workflowInputs', 'OBJECT')], destinationPaths: ['/workflowId'], effects: ['START_SUBWORKFLOW'], endpoints: [], ports: [port()], errorMode: 'STOP', retryMode: 'BOUNDED' }),
  record('subworkflow.tool-workflow', '@n8n/n8n-nodes-langchain.toolWorkflow', { parameterPaths: [parameter('/workflowId', 'STRING', true), parameter('/workflowInputs', 'OBJECT')], destinationPaths: ['/workflowId'], effects: ['START_SUBWORKFLOW'], endpoints: [], ports: [port(), port('ai_tool', 0, 'ALL')], errorMode: 'STOP', retryMode: 'BOUNDED' }),
  record('git.git', 'n8n-nodes-base.git', { parameterPaths: [parameter('/operation', 'STRING', true), parameter('/repositoryUrl', 'STRING', true), parameter('/branch', 'STRING')], credentialPaths: ['/credentials'], destinationPaths: ['/repositoryUrl'], effects: ['READ_EXTERNAL', 'WRITE_EXTERNAL'], endpoints: [endpoint('/repositoryUrl')], ports: [port()], errorMode: 'UNKNOWN', retryMode: 'BOUNDED' }),

  // Flow-control and trigger records. Versions are the exact `nodeVersions` keys in the pinned
  // wrapper files, rendered as canonical strict semver; they are EQ clauses because behaviour and
  // parameters differ by version. `switch` has no fixed port list: its output count is rule-driven.
  record('flow-control.set', 'n8n-nodes-base.set', {
    versionRange: versions(['1.0.0', '2.0.0', '3.0.0', '3.1.0', '3.2.0', '3.3.0', '3.4.0']),
    parameterPaths: [parameter('/keepOnlySet', 'BOOLEAN'), parameter('/values', 'OBJECT'),
      parameter('/mode', 'STRING'), parameter('/duplicateItem', 'BOOLEAN'),
      parameter('/fields/values', 'OBJECT'), parameter('/assignments', 'OBJECT'),
      parameter('/includeOtherFields', 'BOOLEAN'), parameter('/options', 'OBJECT')],
    ports: [port()],
  }),
  record('flow-control.if', 'n8n-nodes-base.if', {
    versionRange: versions(['1.0.0', '2.0.0', '2.1.0', '2.2.0', '2.3.0']),
    parameterPaths: [parameter('/conditions', 'OBJECT'), parameter('/options', 'OBJECT')],
    ports: [port(), port('main', 1)],
  }),
  record('flow-control.switch', 'n8n-nodes-base.switch', {
    versionRange: versions(['1.0.0', '2.0.0', '3.0.0', '3.1.0', '3.2.0', '3.3.0', '3.4.0']),
    parameterPaths: [parameter('/mode', 'STRING'), parameter('/rules', 'OBJECT'),
      parameter('/value1', 'STRING'), parameter('/numberOutputs', 'NUMBER'),
      parameter('/output', 'STRING'), parameter('/options', 'OBJECT')],
    // Output count is rule-driven; an empty list is the honest claim.
    ports: [],
  }),
  record('flow-control.merge', 'n8n-nodes-base.merge', {
    versionRange: versions(['1.0.0', '2.0.0', '2.1.0', '3.0.0', '3.1.0', '3.2.0']),
    parameterPaths: [parameter('/mode', 'STRING'), parameter('/join', 'STRING'),
      parameter('/combinationMode', 'STRING'), parameter('/joinMode', 'STRING'),
      parameter('/options', 'OBJECT')],
    ports: [port('main', 0, 'ALL')],
  }),
  record('flow-control.split-in-batches', 'n8n-nodes-base.splitInBatches', {
    versionRange: versions(['1.0.0', '2.0.0', '3.0.0']),
    parameterPaths: [parameter('/batchSize', 'NUMBER'), parameter('/options', 'OBJECT')],
    ports: [port(), port('main', 1)],
  }),
  record('flow-control.schedule-trigger', 'n8n-nodes-base.scheduleTrigger', {
    entry: 'TRIGGER', versionRange: versions(['1.0.0', '1.1.0', '1.2.0', '1.3.0']),
    parameterPaths: [parameter('/rule', 'OBJECT')], ports: [port()],
  }),
  // Google Sheets is a network integration, not flow control: conservative read+write effects and
  // the v2 destination parameters, no operation-specific claim. It is not a pure-flow record.
  record('google-workspace.google-sheets', 'n8n-nodes-base.googleSheets', {
    versionRange: versions(['1.0.0', '2.0.0', '3.0.0', '4.0.0', '4.1.0', '4.2.0', '4.3.0', '4.4.0', '4.5.0', '4.6.0', '4.7.0']),
    parameterPaths: [parameter('/resource', 'STRING'), parameter('/operation', 'STRING'),
      parameter('/documentId', 'STRING'), parameter('/sheetName', 'STRING'),
      parameter('/range', 'STRING'), parameter('/columns', 'OBJECT')],
    credentialPaths: ['/credentials/googleApi', '/credentials/googleSheetsOAuth2Api'],
    destinationPaths: ['/documentId', '/sheetName', '/range', '/columns'],
    effects: ['READ_EXTERNAL', 'WRITE_EXTERNAL'],
    endpoints: [endpoint('/documentId')],
    ports: [port()],
  }),

  // Five frequent, previously unmodelled families. Versions are EQ clauses taken from the
  // `typeVersion` values actually present in the 11,394 bound readable inputs; anything else
  // (for example telegram typeVersion 2, which upstream does not declare) stays generic fallback.
  // Effects, credential names, destination parameters and ports are read from the pinned
  // `n8n-nodes-base@2.15.1` / `@n8n/n8n-nodes-langchain@2.43.5` files in the source receipts.
  record('message-mcp.gmail', 'n8n-nodes-base.gmail', {
    versionRange: versions(['1.0.0', '2.0.0', '2.1.0', '2.2.0']),
    parameterPaths: [parameter('/resource', 'STRING'), parameter('/operation', 'STRING'),
      parameter('/sendTo', 'STRING'), parameter('/messageId', 'STRING')],
    credentialPaths: ['/credentials/gmailOAuth2'],
    destinationPaths: ['/sendTo', '/messageId', '/threadId'],
    effects: ['READ_EXTERNAL', 'WRITE_EXTERNAL', 'SEND_MESSAGE'],
    endpoints: [endpoint('/sendTo', 'DATA', 'SINK', 'CONFIDENTIALITY')],
    ports: [port()],
  }),
  record('flow-control.wait', 'n8n-nodes-base.wait', {
    versionRange: versions(['1.0.0', '1.1.0']),
    parameterPaths: [parameter('/resume', 'STRING'), parameter('/amount', 'NUMBER'),
      parameter('/unit', 'STRING'), parameter('/dateTime', 'STRING'),
      parameter('/httpMethod', 'STRING'), parameter('/incomingAuthentication', 'STRING')],
    ports: [port()],
  }),
  record('message-mcp.telegram', 'n8n-nodes-base.telegram', {
    versionRange: versions(['1.0.0', '1.1.0', '1.2.0']),
    parameterPaths: [parameter('/resource', 'STRING'), parameter('/operation', 'STRING'),
      parameter('/chatId', 'STRING')],
    credentialPaths: ['/credentials/telegramApi'],
    destinationPaths: ['/chatId'],
    effects: ['READ_EXTERNAL', 'SEND_MESSAGE'],
    endpoints: [endpoint('/chatId', 'DATA', 'SINK', 'BOTH')],
    ports: [port()],
  }),
  record('transform.split-out', 'n8n-nodes-base.splitOut', {
    versionRange: versions(['1.0.0']),
    parameterPaths: [parameter('/fieldToSplitOut', 'STRING', true), parameter('/include', 'STRING'),
      parameter('/options', 'OBJECT')],
    ports: [port()],
  }),
  record('ai.output-parser-structured', '@n8n/n8n-nodes-langchain.outputParserStructured', {
    versionRange: versions(['1.0.0', '1.1.0', '1.2.0', '1.3.0']),
    parameterPaths: [parameter('/schemaType', 'STRING'), parameter('/jsonSchema', 'STRING'),
      parameter('/inputSchema', 'STRING'), parameter('/autoFix', 'BOOLEAN')],
    ports: [port('ai_outputParser', 0, 'EACH'), port('ai_languageModel', 0, 'EACH')],
  }),

  // Sticky Note v1 is an annotation, not an executable step: the pinned `StickyNote.node.js`
  // declares `inputs: []`, `outputs: []`, no credentials, and `execute()` returns
  // `this.getInputData()`. Empty ports/effects/endpoints assert that pinned absence.
  record('annotation.sticky-note', 'n8n-nodes-base.stickyNote', { versionRange: range('EQ'), ports: [] }),

  // NoOp v1 is a pure passthrough: `properties: []`, no credentials, and `execute()` returns
  // `this.getInputData()` (pinned NoOp.node.js). The pinned file declares no error, retry, or
  // disabled handling of its own, so errorMode/retryMode stay at the catalogue's conservative
  // `UNKNOWN` defaults and disabledMode at `SKIP`.
  record('noop.passthrough', 'n8n-nodes-base.noOp', { versionRange: range('EQ') }),
  // Keep these partial records on the analyzer's conservative path; a resolver match is not a
  // complete execution model while the error/retry modes remain UNKNOWN.
  // This Drive record is coarse family metadata, not an operation-specific effect or field model.
  record('google-workspace.google-drive', 'n8n-nodes-base.googleDrive', {
    versionRange: versions(['1.0.0', '2.0.0', '3.0.0']),
    parameterPaths: [parameter('/resource', 'STRING'), parameter('/operation', 'STRING'),
      parameter('/fileId', 'STRING'), parameter('/folderId', 'STRING'), parameter('/name', 'STRING')],
    credentialPaths: ['/credentials/googleApi', '/credentials/googleDriveOAuth2Api'],
    destinationPaths: ['/fileId', '/folderId'],
    effects: ['READ_EXTERNAL', 'WRITE_EXTERNAL'],
    endpoints: [endpoint('/fileId')],
    ports: [port()],
  }),
  // Filter's conditions and kept/discarded transformation behavior are not modeled here.
  record('flow-control.filter', 'n8n-nodes-base.filter', {
    versionRange: versions(['1.0.0', '2.0.0', '2.1.0', '2.2.0', '2.3.0']),
    parameterPaths: [parameter('/conditions', 'OBJECT'), parameter('/options', 'OBJECT')],
    ports: [port()],
  }),
  // Aggregate's top-level parameters are recorded; aggregation transformations remain unmodeled.
  record('flow-control.aggregate', 'n8n-nodes-base.aggregate', {
    versionRange: versions(['1.0.0']),
    parameterPaths: [parameter('/aggregate', 'STRING'), parameter('/fieldsToAggregate', 'OBJECT'),
      parameter('/options', 'OBJECT')],
    ports: [port()],
  }),
];

const catalogueBody: SemanticCatalogueBodyV2 = { schemaVersion: 'scanner-semantics-v2', id: 'scanner-core-builtins', version: '2.2.0', records, configurationKeys: ['allowNetwork', 'approvedDomains'] };
export const BUILTIN_SEMANTIC_CATALOGUE_V2: SemanticCatalogueV2 = admitSemanticCatalogue({ ...catalogueBody, digest: createSemanticCatalogueDigest(catalogueBody) });
