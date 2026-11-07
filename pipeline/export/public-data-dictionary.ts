import {
  PUBLIC_DATA_MODEL_SCHEMA_VERSION_V4,
  PUBLIC_RELATION_NAMES,
  PUBLIC_RELATION_NAMES_V4,
  type PublicDataProjectionV4,
  type PublicRelationName,
  type PublicRelationNameV4,
} from '@hub/contracts/public-data-model';

export type PublicFieldDefinition = {
  relation: PublicRelationName;
  field: string;
  type: string;
  nullable: boolean;
  authority: string;
  rightsClass: string;
  privacyRule: string;
  derivation: string;
};

export type PublicFieldDefinitionV4 = Omit<PublicFieldDefinition, 'relation'> & { relation: PublicRelationNameV4 };

type FieldSpec = [field: string, type: string, nullable: boolean, authority: string, rightsClass: string, privacyRule: string, derivation: string];

function define(relation: PublicRelationName, fields: readonly FieldSpec[]): PublicFieldDefinition[] {
  return fields.map(([field, type, nullable, authority, rightsClass, privacyRule, derivation]) => ({
    relation, field, type, nullable, authority, rightsClass, privacyRule, derivation,
  }));
}

const deterministic = 'deterministic';
const all = 'all';
const aggregate = 'aggregate only';
const publicLabel = 'normalized public label';
const exclusionDerivation = 'the upstream acquisition exclusion list is applied before candidates become entries; this exporter has no per-entry public exclusion registry to project, so rows remain empty';

export const PUBLIC_FIELD_DEFINITIONS: readonly PublicFieldDefinition[] = [
  ...define('releases', [
    ['releaseId', 'string', false, deterministic, all, 'stable release identity', 'release metadata'],
    ['schemaVersion', 'string', false, deterministic, all, 'versioned contract identity', 'release metadata'],
    ['generatedAt', 'ISO-8601 string', false, deterministic, all, 'generation timestamp only', 'injected release clock'],
    ['toolVersion', 'string', false, deterministic, all, 'tool identity only', 'release metadata'],
    ['scannerVersion', 'string', false, deterministic, all, 'release identity only, never a producing engine for any row', 'release metadata'],
    ['policyVersion', 'string', false, deterministic, all, 'policy identity only', 'release metadata'],
    ['searchIndexVersion', 'string', false, deterministic, all, 'index identity only', 'release metadata'],
    ['buildRevision', 'string', false, deterministic, all, 'build identity only', 'release metadata'],
    ['manifestSha256', 'lowercase SHA-256', false, deterministic, all, 'hash, not source content', 'manifest bytes'],
    ['corpusSha256', 'lowercase SHA-256', false, deterministic, all, 'hash, not workflow content', 'corpus bytes'],
    ['counts', 'object', false, deterministic, aggregate, 'counts only', 'release metadata; excluded is a corpus facet and does not imply exclusion rows'],
    ['facetCounts', 'object', false, deterministic, aggregate, 'rights counts only', 'release metadata; rights.excluded is a corpus facet and does not imply exclusion rows'],
  ]),
  ...define('workflows', [
    ['workflowId', 'string', false, deterministic, all, 'stable public identifier', 'canonical entry id'],
    ['title', 'string', false, 'source/prose', all, 'bounded display text', 'curated entry title'],
    ['description', 'string', true, 'source/prose', all, 'bounded; no raw JSON', 'curated entry description'],
    ['descriptionAuthority', 'enum', false, deterministic, all, 'authority label, not a claim', 'description provenance'],
    ['sourceId', 'string', false, deterministic, all, 'relation key only', 'source identity join'],
    ['rightsStatus', 'enum', false, 'source', all, 'rights state is explicit', 'rights evidence'],
    ['body', 'path/hash reference', true, deterministic, 'all; always null in public-data-model-v3', 'never inline workflow JSON', 'v3 publishes no body for any row; rightsStatus still reports the source licence and redistribution facts'],
    ['grade', 'known/null fact object', false, deterministic, all, 'unknown is not low risk', 'scanner result with fail-closed fallback'],
    ['score', 'known/null fact object', false, deterministic, all, 'unknown is not zero', 'scanner result with fail-closed fallback'],
    ['completeness', 'enum', false, deterministic, all, 'partial is explicit', 'structure analysis'],
    ['complexity', 'enum', false, deterministic, all, 'derived complexity only', 'structure analysis'],
    ['nodeCount', 'integer', false, deterministic, all, 'count, not node payload', 'functional node analysis'],
    ['connectionCount', 'integer', false, deterministic, all, 'count, not connection payload', 'graph analysis'],
    ['readinessStatus', 'enum', false, deterministic, all, 'status only; no secret values', 'readiness analysis and rights gate'],
    ['scanEvidence.scannerVersion', 'string or null', true, deterministic, all, 'producing engine identity only', 'the engine that produced this row verdict, null when no engine did; the release-level scannerVersion is release identity only'],
    ['scanEvidence.analysisStatus', 'enum: COMPLETE | DEGRADED | INDETERMINATE, or null', true, deterministic, all, 'status only; no diagnostic codes, evidence or locations', 'this row result receipt status, null when none was recorded'],
    ['scanEvidence.scanFreshness', 'enum: CURRENT | NO_RESULT | HISTORICAL | UNSCANNED | SOURCE_UNAVAILABLE', false, deterministic, all, 'state only; nothing is inferred from a title, a URL or a release identity', 'this row own evidence: an owner ruling, then an admitted scan result, then a current-identity refusal with no result, then a retained verdict, then no verdict. NO_RESULT means bytes were read and the engine refused; it carries no grade and no digest. Independent of redistribution rights, which answer a different question (whether the release may ship the body) and never decide freshness'],
    ['scanEvidence.scanBodySha256', 'lowercase SHA-256 or null', true, deterministic, all, 'hash of the scanned bytes; not body content and never the public pack hash', 'the admitted scan receipt for a current scan; null when no receipt exists'],
  ]),
  ...define('sources', [
    ['sourceId', 'string', false, deterministic, all, 'stable relation key', 'source identity hash'],
    ['kind', 'enum', false, 'source', all, 'source classification', 'source registry'],
    ['publicUrl', 'URL string', false, 'source', all, 'safe external link', 'source permalink'],
    ['repositoryUrl', 'URL string', true, 'source', all, 'safe external link', 'repository identity'],
    ['licence', 'string', true, 'source', all, 'licence fact only', 'rights evidence'],
    ['licenceUrl', 'URL string', true, 'source', all, 'safe external link', 'rights evidence'],
  ]),
  ...define('findings', [
    ['findingId', 'string', false, deterministic, all, 'stable finding identity', 'workflow and policy ids'],
    ['workflowId', 'string', false, deterministic, all, 'relation key only', 'canonical entry id'],
    ['policyId', 'string', false, deterministic, all, 'stable policy identity', 'scanner policy registry'],
    ['severity', 'enum', false, deterministic, all, 'severity fact only', 'scanner policy output'],
    ['category', 'string', false, deterministic, all, 'bounded category', 'scanner policy output'],
    ['effect', 'string', false, 'non-authoritative-prose', all, 'no evidence or secrets', 'scanner explanation prose'],
    ['confidence', 'enum', false, deterministic, all, 'confidence is explicit', 'scanner policy output'],
    ['title', 'string', false, 'non-authoritative-prose', all, 'bounded display text', 'scanner policy output'],
    ['remediation', 'string', false, 'non-authoritative-prose', all, 'no evidence or secrets', 'scanner remediation prose'],
  ]),
  ...define('integrations', [['id', 'string', false, deterministic, all, publicLabel, 'normalized node integration'] , ['label', 'string', false, deterministic, all, publicLabel, 'normalized node integration']]),
  ...define('tags', [['id', 'string', false, deterministic, all, publicLabel, 'normalized entry tag'], ['label', 'string', false, deterministic, all, publicLabel, 'normalized entry tag']]),
  ...define('triggers', [['id', 'string', false, deterministic, all, publicLabel, 'normalized trigger'], ['label', 'string', false, deterministic, all, publicLabel, 'normalized trigger']]),
  ...define('workflowIntegrations', [['workflowId', 'string', false, deterministic, all, 'relation keys only', 'workflow-to-integration join'], ['integrationId', 'string', false, deterministic, all, 'relation keys only', 'workflow-to-integration join']]),
  ...define('workflowTags', [['workflowId', 'string', false, deterministic, all, 'relation keys only', 'workflow-to-tag join'], ['tagId', 'string', false, deterministic, all, 'relation keys only', 'workflow-to-tag join']]),
  ...define('workflowTriggers', [['workflowId', 'string', false, deterministic, all, 'relation keys only', 'workflow-to-trigger join'], ['triggerId', 'string', false, deterministic, all, 'relation keys only', 'workflow-to-trigger join']]),
  ...define('credentials', [['id', 'string', false, deterministic, all, publicLabel, 'distinct credential type label, hashed; the per-workflow rows are requirements.kind = credential'], ['label', 'string', false, deterministic, all, publicLabel, 'distinct credential type label; requirements.kind = credential carries the same label per workflow, so the two cannot disagree about presence']]),
  ...define('domains', [['id', 'string', false, deterministic, all, 'stable relation key', 'normalized hostname hash'], ['hostname', 'hostname string', false, deterministic, all, 'literal host only; no credentials', 'literal workflow host']]),
  ...define('communityNodes', [['id', 'string', false, deterministic, all, publicLabel, 'normalized package name hash'], ['packageName', 'string', false, deterministic, all, 'package identity only', 'readiness extra package']]),
  ...define('requirements', [['requirementId', 'string', false, deterministic, all, 'stable requirement identity', 'workflow and requirement hash'], ['workflowId', 'string', false, deterministic, all, 'relation key only', 'canonical entry id'], ['kind', 'enum', false, deterministic, all, 'requirement class only; kind = credential is the workflow-grain twin of the credentials relation', 'readiness analysis'], ['label', 'string', false, deterministic, all, 'no secret value', 'readiness analysis'], ['status', 'enum', false, deterministic, all, 'status is explicit', 'readiness analysis']]),
  ...define('exclusions', [['exclusionId', 'string', false, deterministic, aggregate, 'exclusion identity only', exclusionDerivation], ['workflowId', 'string', true, deterministic, aggregate, 'relation key only', exclusionDerivation], ['status', 'enum', false, deterministic, aggregate, 'excluded only', exclusionDerivation], ['reasonCode', 'string', false, deterministic, aggregate, 'reason code only', exclusionDerivation], ['publicReference', 'URL/string', true, 'source', aggregate, 'safe reference only', exclusionDerivation]]),
  ...define('artifacts', [['artifactId', 'string', false, deterministic, all, 'stable artifact identity', 'release and relation identity'], ['releaseId', 'string', false, deterministic, all, 'relation key only', 'release identity'], ['relation', 'enum', false, deterministic, all, 'relation name only', 'writer output'], ['format', 'enum', false, deterministic, all, 'format name only', 'writer output'], ['path', 'relative path', false, deterministic, all, 'release-relative path only', 'writer output'], ['sha256', 'lowercase SHA-256', false, deterministic, all, 'hash, not artifact content', 'writer output bytes'], ['byteSize', 'integer', false, deterministic, all, 'size only', 'writer output bytes'], ['rightsStatus', 'enum', false, 'source', all, 'rights state is explicit', 'rights evidence']]),
];

if (new Set(PUBLIC_FIELD_DEFINITIONS.map(({ relation }) => relation)).size !== PUBLIC_RELATION_NAMES.length) {
  throw new Error('Public data dictionary: relation coverage is incomplete');
}

export function publicDataDictionaryRows(): PublicFieldDefinition[] {
  return PUBLIC_FIELD_DEFINITIONS.map((definition) => ({ ...definition }));
}

type V4FieldTail = readonly [type: string, nullable: boolean, authority: string, rightsClass: string, privacyRule: string, derivation: string];
type V4FieldSpec = readonly [field: string, ...V4FieldTail];
type CoverageFieldSpec = readonly [field: keyof PublicDataProjectionV4['preflightCoverage'][number], ...V4FieldTail];
type EvidenceFieldSpec = readonly [field: keyof PublicDataProjectionV4['preflightEvidence'][number], ...V4FieldTail];

function defineV4(relation: PublicRelationNameV4, fields: readonly V4FieldSpec[]): PublicFieldDefinitionV4[] {
  return fields.map(([field, type, nullable, authority, rightsClass, privacyRule, derivation]) => ({
    relation, field, type, nullable, authority, rightsClass, privacyRule, derivation,
  }));
}

type FieldOverride = Partial<Omit<PublicFieldDefinition, 'relation' | 'field'>>;
const V4_OVERRIDES: Readonly<Record<string, FieldOverride>> = {
  'releases.schemaVersion': { type: 'enum: ' + PUBLIC_DATA_MODEL_SCHEMA_VERSION_V4 },
  'workflows.body': { rightsClass: 'all; always null in public-data-model-v4' },
  'workflows.scanEvidence.scanFreshness': {
    derivation: 'this row own evidence: an owner ruling, then an admitted scan result, then a current-identity refusal with no result, then a retained verdict, then no verdict. NO_RESULT means bytes were read and the engine produced no result; it requires a bound body digest, has no result status and carries unknown grade and score. Independent of redistribution rights, which answer a different question (whether the release may ship the body) and never decide freshness',
  },
  'artifacts.relation': { type: 'enum: ' + PUBLIC_RELATION_NAMES_V4.join(' | ') },
  'credentials.id': { derivation: 'public ordinal only; no hash of a withheld credential token' },
  'credentials.label': { privacyRule: 'fixed Credential reference label plus public ordinal; original type token withheld' },
  'communityNodes.id': { derivation: 'public ordinal only; no hash of a withheld package token' },
  'communityNodes.packageName': { privacyRule: 'fixed Community package reference label plus public ordinal; original package token withheld' },
  'requirements.requirementId': { derivation: 'workflow, category and public ordinal for withheld references; no node, field, credential or package token hash' },
  'requirements.label': { privacyRule: 'credential, community, replaceable-value and version use fixed category labels; public domain labels remain explicit', derivation: 'legacy display reference only; preflightEvidence is the source-bound prerequisite inventory' },
};

const categoryMatrix = 'credential -> CONTAINER /nodes/<i>/credentials, observed ordinal 0; community-node -> NODE /nodes/<i>; integration -> NODE /nodes/<i>; subworkflow -> FIELD /nodes/<i>/parameters/workflowId with LITERAL or DYNAMIC, or NODE /nodes/<i> with ABSENT and unresolved observation; environment -> FIELD safe /nodes/<i>/parameters/... with requested ENV or VARS';
const omissions = 'BODY_MISSING | BODY_SOURCE_UNAVAILABLE | BODY_UNPARSEABLE | BODY_REJECTED | BODY_BINDING_UNKNOWN | COLLECTOR_REJECTED | COLLECTOR_LIMIT | COMPUTED_ACCESS | UNSAFE_PARAMETER_PATH | NODE_NAME_WITHHELD | IDENTIFIER_WITHHELD | CREDENTIAL_POINTER_WITHHELD | SUBWORKFLOW_ID_WITHHELD | INVALID_EXPORT_EVIDENCE';
const nodeTypes = 'n8n-nodes-base.set | n8n-nodes-base.code | n8n-nodes-base.if | n8n-nodes-base.switch | n8n-nodes-base.filter | n8n-nodes-base.merge | n8n-nodes-base.splitInBatches | n8n-nodes-base.splitOut | n8n-nodes-base.aggregate | n8n-nodes-base.itemLists | n8n-nodes-base.sort | n8n-nodes-base.limit | n8n-nodes-base.removeDuplicates | n8n-nodes-base.wait | n8n-nodes-base.noOp | n8n-nodes-base.start | n8n-nodes-base.stickyNote | n8n-nodes-base.dateTime | n8n-nodes-base.compareDatasets | n8n-nodes-base.stopAndError | n8n-nodes-base.respondToWebhook | n8n-nodes-base.webhook | n8n-nodes-base.formTrigger | n8n-nodes-base.scheduleTrigger | n8n-nodes-base.manualTrigger | n8n-nodes-base.errorTrigger | n8n-nodes-base.executeWorkflowTrigger | n8n-nodes-base.crypto | n8n-nodes-base.httpRequest | n8n-nodes-base.graphql | n8n-nodes-base.slack | n8n-nodes-base.gmail | n8n-nodes-base.postgres | n8n-nodes-base.executeWorkflow';

const COVERAGE_FIELD_SPECS = [
  ['coverageId', 'string', false, deterministic, all, 'stable coverage identity only', 'workflow and inventory identity'],
  ['workflowId', 'string', false, deterministic, all, 'relation key only', 'canonical workflow id'],
  ['sourceId', 'string', false, deterministic, all, 'relation key only', 'source identity join'],
  ['evidenceSchema', 'enum: preflight-prerequisites-v1', false, deterministic, all, 'version identity only', 'collector evidence schema'],
  ['inventorySha256', 'lowercase SHA-256', false, deterministic, all, 'hash, not source content', 'inventory bytes; never a source path'],
  ['sourceBodySha256', 'lowercase SHA-256 or null', true, deterministic, all, 'hash, not source content', 'bound source body digest when retained; never raw body'],
  ['bodyStatus', 'enum: AVAILABLE | MISSING | SOURCE_UNAVAILABLE | UNPARSEABLE | REJECTED', false, deterministic, all, 'state only; never a source path', 'C1b body classification'],
  ['coverageState', 'enum: COMPLETE | PARTIAL | UNKNOWN', false, deterministic, all, 'aggregate state only', 'C1b coverage classification'],
  ['omissionCodes', 'closed-code array: ' + omissions, false, deterministic, all, 'codes only; never source content or identifiers', 'canonical, ordered, duplicate-free C1b omissions'],
  ['omissionCounts', 'array of {code, count, basis: EXACT | LOWER_BOUND}', false, deterministic, aggregate, 'codes and counts only', 'same canonical code set as omissionCodes'],
  ['source', 'enum: WORKFLOW_EXPORT', false, deterministic, all, 'source class only', 'admitted workflow export'],
  ['sourcePointer', 'literal: /', false, deterministic, all, 'pointer only; no filesystem path', 'workflow root'],
  ['repository', 'literal: UNKNOWN', false, deterministic, all, 'unknown remains unknown', 'not inferred from source'],
  ['commit', 'literal: UNKNOWN', false, deterministic, all, 'unknown remains unknown', 'not inferred from source'],
  ['licence', 'literal: UNKNOWN', false, deterministic, all, 'unknown remains unknown', 'not inferred from source'],
  ['verification', 'literal: UNKNOWN', false, deterministic, all, 'unknown remains unknown', 'no runtime or live claim'],
] satisfies readonly CoverageFieldSpec[];

const EVIDENCE_FIELD_SPECS = [
  ['evidenceId', 'string', false, deterministic, all, 'stable evidence identity only', 'workflow, category, pointer and ordinal identity'],
  ['coverageId', 'string', false, deterministic, all, 'relation key only', 'matching coverage row'],
  ['workflowId', 'string', false, deterministic, all, 'relation key only', 'canonical workflow id'],
  ['category', 'enum: credential | community-node | integration | subworkflow | environment', false, deterministic, all, 'category label only', categoryMatrix],
  ['observation', 'enum: observed | inferred | unresolved', false, deterministic, all, 'state only; no raw observation', 'credential is observed; node subworkflow absent is unresolved'],
    ['requirement', 'literal: unknown', false, deterministic, all, 'presence is not validity', 'never inferred from reference presence'],
  ['source', 'enum: WORKFLOW_EXPORT', false, deterministic, all, 'source class only', 'admitted workflow export'],
  ['nodeIndex', 'non-negative integer', false, deterministic, all, 'index only; no node body', 'candidate node position'],
  ['observationOrdinal', 'non-negative integer', false, deterministic, all, 'ordinal only', 'credential containers require observed ordinal 0'],
  ['nodePointer', 'safe /nodes/<index> pointer', false, deterministic, all, 'pointer only; no node name', 'candidate node position'],
  ['pointerScope', 'enum: NODE | FIELD | CONTAINER', false, deterministic, all, 'scope label only', categoryMatrix],
  ['detailPointer', 'safe category pointer', false, deterministic, all, 'no credential key or value, subworkflow id, expression text, environment value or source path', categoryMatrix],
  ['nodeName', 'null', false, deterministic, all, 'node names are withheld', 'every C1b evidence row'],
  ['nodeType', 'enum: ' + nodeTypes + ', or null', true, deterministic, all, 'bounded node type only', 'admitted collector node type; null when withheld'],
  ['typeVersion', 'bounded decimal version string or null', true, deterministic, all, 'version only; no parameters', 'normalized node typeVersion'],
  ['publicLabel', 'enum: Credential references at node | Community package reference | Integration observation | Subworkflow reference | Environment reference', false, deterministic, all, 'closed label only', 'category label matrix'],
  ['credentialReference', 'null', false, deterministic, all, 'never a credential key, value, id or name', 'credential C1b rows are value-free'],
  ['subworkflowResolution', 'enum: LITERAL | DYNAMIC | ABSENT, or null', true, deterministic, all, 'never a subworkflow id', 'FIELD: LITERAL, DYNAMIC or null-present unresolved; NODE: ABSENT only'],
  ['environmentNamespace', 'enum: ENV | VARS, or null', true, deterministic, all, 'namespace label only; never an identifier or value', 'environment FIELD rows request ENV or VARS only'],
  ['installation', 'literal: UNKNOWN', false, deterministic, all, 'unknown remains unknown', 'no runtime claim'],
  ['credentialValidity', 'literal: UNKNOWN', false, deterministic, all, 'unknown remains unknown', 'presence is not validity'],
  ['runtimeAvailability', 'literal: UNKNOWN', false, deterministic, all, 'unknown remains unknown', 'no live claim'],
  ['ownership', 'literal: UNKNOWN', false, deterministic, all, 'unknown remains unknown', 'no live claim'],
  ['omissionCodes', 'closed-code array: ' + omissions, false, deterministic, all, 'codes only; never source content or identifiers', 'canonical, ordered, duplicate-free C1b omissions with the required withholding code'],
] satisfies readonly EvidenceFieldSpec[];

export const PUBLIC_FIELD_DEFINITIONS_V4: readonly PublicFieldDefinitionV4[] = [
  ...PUBLIC_FIELD_DEFINITIONS.map((definition) => ({
    ...definition,
    ...V4_OVERRIDES[definition.relation + '.' + definition.field],
  })),
  ...defineV4('preflightCoverage', COVERAGE_FIELD_SPECS),
  ...defineV4('preflightEvidence', EVIDENCE_FIELD_SPECS),
];

if (new Set(PUBLIC_FIELD_DEFINITIONS_V4.map(({ relation }) => relation)).size !== PUBLIC_RELATION_NAMES_V4.length) {
  throw new Error('Public data dictionary: v4 relation coverage is incomplete');
}

export function publicDataDictionaryRowsV4(): PublicFieldDefinitionV4[] {
  return PUBLIC_FIELD_DEFINITIONS_V4.map((definition) => ({ ...definition }));
}
