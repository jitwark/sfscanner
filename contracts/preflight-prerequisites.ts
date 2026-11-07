/**
 * Traceable prerequisite inventory: turns one workflow export into credential, community-node, integration,
 * subworkflow and environment observations, each anchored to a JSON pointer inside the exported document.
 * Nothing here executes code, reads the host environment or infers ownership, installation or availability;
 * a literal `$env`/`$vars` mention is an observed reference, never proof the variable exists or is used.
 */
import type {
  PreflightCommunityNodeV1, PreflightCredentialV1, PreflightEnvironmentV1, PreflightIntegrationV1,
  PreflightNodeEvidenceV1, PreflightPrerequisitesV1, PreflightProvenanceV1, PreflightSubworkflowV1,
  RawNodeV1,
} from './preflight-prerequisite-types';

type Dict = Readonly<Record<string, unknown>>;

const SUBWORKFLOW_TYPE = 'n8n-nodes-base.executeWorkflow';
const OFFICIAL_PREFIXES: readonly string[] = Object.freeze(['n8n-nodes-base.', '@n8n/n8n-nodes-langchain.']);
const FLOW_UTILITY_TYPES: Readonly<Record<string, true>> = Object.freeze({
  'n8n-nodes-base.set': true, 'n8n-nodes-base.code': true, 'n8n-nodes-base.if': true, 'n8n-nodes-base.switch': true, 'n8n-nodes-base.filter': true,
  'n8n-nodes-base.merge': true, 'n8n-nodes-base.splitInBatches': true, 'n8n-nodes-base.splitOut': true, 'n8n-nodes-base.aggregate': true,
  'n8n-nodes-base.itemLists': true, 'n8n-nodes-base.sort': true, 'n8n-nodes-base.limit': true, 'n8n-nodes-base.removeDuplicates': true,
  'n8n-nodes-base.wait': true, 'n8n-nodes-base.noOp': true, 'n8n-nodes-base.start': true, 'n8n-nodes-base.stickyNote': true,
  'n8n-nodes-base.dateTime': true, 'n8n-nodes-base.compareDatasets': true, 'n8n-nodes-base.stopAndError': true, 'n8n-nodes-base.respondToWebhook': true,
  'n8n-nodes-base.webhook': true, 'n8n-nodes-base.formTrigger': true, 'n8n-nodes-base.scheduleTrigger': true, 'n8n-nodes-base.manualTrigger': true,
  'n8n-nodes-base.errorTrigger': true, 'n8n-nodes-base.executeWorkflowTrigger': true, 'n8n-nodes-base.crypto': true,
});
/** Node types whose admitted semantic model is a remote call, so they are integrations without needing a credential reference. */
const REMOTE_ACCESS_TYPES: Readonly<Record<string, true>> = Object.freeze({
  'n8n-nodes-base.httpRequest': true, 'n8n-nodes-base.graphql': true,
});
/** Admitted official service types; nothing else may enter the integration inventory, however official it looks. */
const KNOWN_INTEGRATION_TYPES: Readonly<Record<string, true>> = Object.freeze({ 'n8n-nodes-base.slack': true, 'n8n-nodes-base.gmail': true, 'n8n-nodes-base.postgres': true });
/** Internal inventory bounds, not a replacement for any scanner budget: they only keep one export's traversal finite. */
const MAX_ENVIRONMENT_DEPTH = 64;
const MAX_ENVIRONMENT_VALUES = 10_000;
const MAX_ENVIRONMENT_CHARS = 1_000_000;
const ENVIRONMENT_REFERENCE = /(\$env|\$vars)\.([A-Za-z0-9_]+)/g;
const COMPUTED_ENVIRONMENT_REFERENCE = /(\$env|\$vars)\s*(?:\?\.\s*)?\[/;
/** Only fixed structural keys are admitted in environment evidence paths; other keys may themselves contain secrets. */
const SAFE_PARAMETER_KEYS = new Set(['url', 'options', 'headers', 'list', 'jsCode', 'text', 'value', 'jsonBody']);
const UNKNOWNS_BASE: readonly string[] = Object.freeze([
  'credential references are export identifiers only; secrets, scopes, ownership, expiry and offline validity stay unknown.',
  'npm package versions and installation state are not recorded in a workflow export; community node package versions stay unknown.',
  'disabled nodes are listed as exported; whether a disabled node needs its prerequisites at run time is not evaluated.',
  "environment references are literal $env/$vars mentions; the value, the variable's existence and its availability on a target stay unknown.",
]);
const PROVENANCE: PreflightProvenanceV1 = Object.freeze({
  source: 'WORKFLOW_EXPORT' as const, pointer: '/' as const,
  repository: 'UNKNOWN' as const, commit: 'UNKNOWN' as const, licence: 'UNKNOWN' as const, verification: 'UNKNOWN' as const,
});

const ro = <T>(value: T): Readonly<T> => Object.freeze(value);
export const isDict = (value: unknown): value is Dict => typeof value === 'object' && value !== null && !Array.isArray(value);
export const cmp = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0);
/** Whitespace-only values prove nothing, so text is admitted only after trimming. */
export const text = (value: unknown): string | null => (typeof value === 'string' && value.trim().length > 0 ? value.trim() : null);
const isOfficial = (type: string): boolean => OFFICIAL_PREFIXES.some((prefix) => type.startsWith(prefix));
/** A credential key alone proves nothing: only an entry carrying a non-empty id or name declares a real reference. */
const hasCredentialReference = (node: RawNodeV1): boolean => node.credentials !== null && Object.values(node.credentials).some((entry) => isDict(entry) && (text(entry.id) !== null || text(entry.name) !== null));
/** Identity is known only for types the local model admits; an unmodelled type that merely declares credentials stays unknown. */
export const hasKnownIdentity = (node: RawNodeV1): boolean => FLOW_UTILITY_TYPES[node.type] === true || REMOTE_ACCESS_TYPES[node.type] === true
  || node.type === SUBWORKFLOW_TYPE || KNOWN_INTEGRATION_TYPES[node.type] === true;

const normalizeTypeVersion = (value: unknown): string | null => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? String(value) : text(value));

/** Escapes one JSON pointer token; `/credentials/a~1b~0c` names the key `a/b~c` and never a path. */
export const escapeJsonPointerSegment = (value: string): string => value.replaceAll('~', '~0').replaceAll('/', '~1');

const nodeEvidence = (node: RawNodeV1): PreflightNodeEvidenceV1 => ro({
  source: 'WORKFLOW_EXPORT' as const, pointer: `/nodes/${node.index}`,
  node: node.name, nodeType: node.type, typeVersion: node.typeVersion,
});

function readNodes(workflow: unknown): Readonly<{ nodes: readonly RawNodeV1[]; malformed: number }> {
  if (!isDict(workflow)) throw new TypeError('workflow must be an object');
  const raw = workflow.nodes;
  if (!Array.isArray(raw)) throw new TypeError('workflow.nodes must be an array');
  const nodes: RawNodeV1[] = []; let malformed = 0;
  raw.forEach((item, index) => {
    const type = isDict(item) ? text(item.type) : null; if (type === null) { malformed += 1; return; }
    nodes.push(ro({ index, name: text(item.name) ?? `node[${index}]`, type, typeVersion: normalizeTypeVersion(item.typeVersion), parameters: item.parameters, credentials: isDict(item.credentials) ? item.credentials : null }));
  });
  return ro({ nodes: ro(nodes), malformed });
}

function collectCredentials(nodes: readonly RawNodeV1[]): readonly PreflightCredentialV1[] {
  const rows: PreflightCredentialV1[] = [];
  for (const node of nodes) {
    const credentials = node.credentials;
    if (credentials === null) continue;
    for (const credentialType of Object.keys(credentials)) {
      const details = isDict(credentials[credentialType]) ? credentials[credentialType] as Dict : {};
      const hasId = text(details.id) !== null; const hasName = text(details.name) !== null;
      const pointer = `/nodes/${node.index}/credentials/${escapeJsonPointerSegment(credentialType)}`;
      rows.push(ro({ credentialType, credentialName: text(details.name), reference: hasId && hasName ? 'ID_AND_NAME' : hasId ? 'ID_ONLY' : hasName ? 'NAME_ONLY' : 'EMPTY', node: node.name, nodeType: node.type, pointer, offlineValidity: 'UNKNOWN', ownership: 'UNKNOWN' }));
    }
  }
  return ro(rows.sort((left, right) => cmp(left.credentialType, right.credentialType) || cmp(left.node, right.node)));
}

type IndexedEvidence = Readonly<{ index: number; row: PreflightNodeEvidenceV1 }>;
const evidenceRows = (evidence: readonly IndexedEvidence[]): readonly PreflightNodeEvidenceV1[] => ro(evidence.slice().sort((left, right) => left.index - right.index).map(({ row }) => row));

function collectCommunityNodes(nodes: readonly RawNodeV1[]): readonly PreflightCommunityNodeV1[] {
  const groups = new Map<string, { packageName: string | null; nodeTypes: string[]; nodes: string[]; typeVersions: string[]; evidence: IndexedEvidence[] }>();
  for (const node of nodes) {
    if (isOfficial(node.type)) continue;
    const dot = node.type.lastIndexOf('.'); const packageName = dot > 0 ? node.type.slice(0, dot) : null;
    const group = groups.get(String(packageName)) ?? { packageName, nodeTypes: [], nodes: [], typeVersions: [], evidence: [] };
    if (!group.nodeTypes.includes(node.type)) group.nodeTypes.push(node.type);
    group.nodes.push(node.name); group.evidence.push({ index: node.index, row: nodeEvidence(node) });
    if (node.typeVersion !== null && !group.typeVersions.includes(node.typeVersion)) group.typeVersions.push(node.typeVersion);
    groups.set(String(packageName), group);
  }
  return ro([...groups.values()].map((group) => ro({
    packageName: group.packageName, nodeTypes: ro(group.nodeTypes), nodes: ro(group.nodes), typeVersions: ro(group.typeVersions),
    evidence: evidenceRows(group.evidence), packageVersion: null, installed: 'UNKNOWN' as const,
  })).sort((left, right) => cmp(String(left.packageName), String(right.packageName)) || cmp(left.nodeTypes.join(), right.nodeTypes.join())));
}

function collectIntegrations(nodes: readonly RawNodeV1[]): readonly PreflightIntegrationV1[] {
  const groups = new Map<string, { nodes: string[]; credentialTypes: string[]; evidence: IndexedEvidence[] }>();
  for (const node of nodes) {
    if (REMOTE_ACCESS_TYPES[node.type] !== true && !(KNOWN_INTEGRATION_TYPES[node.type] === true && hasCredentialReference(node))) continue;
    const group = groups.get(node.type) ?? { nodes: [], credentialTypes: [], evidence: [] };
    group.nodes.push(node.name); group.evidence.push({ index: node.index, row: nodeEvidence(node) });
    for (const key of node.credentials === null ? [] : Object.keys(node.credentials)) if (!group.credentialTypes.includes(key)) group.credentialTypes.push(key);
    groups.set(node.type, group);
  }
  return ro([...groups.entries()].map(([nodeType, group]) => ro({
    service: nodeType.slice(nodeType.lastIndexOf('.') + 1), nodeType, nodes: ro(group.nodes),
    credentialTypes: ro(group.credentialTypes.sort(cmp)), evidence: evidenceRows(group.evidence),
  })).sort((left, right) => cmp(left.nodeType, right.nodeType)));
}

function collectSubworkflows(nodes: readonly RawNodeV1[]): readonly PreflightSubworkflowV1[] {
  return ro(nodes.filter((node) => node.type === SUBWORKFLOW_TYPE).map((node) => {
    const parameters = isDict(node.parameters) ? node.parameters : {};
    const hasWorkflowId = Object.prototype.hasOwnProperty.call(parameters, 'workflowId');
    const raw = hasWorkflowId ? parameters.workflowId : undefined;
    const literal = typeof raw === 'string' ? raw : isDict(raw) ? text(raw.value) : null;
    const dynamic = typeof raw === 'string' ? raw.includes('{{') : isDict(raw) && raw.value !== undefined;
    const resolution = literal === null ? 'ABSENT' as const : dynamic ? 'DYNAMIC' as const : 'LITERAL' as const;
    const pointer = hasWorkflowId ? `/nodes/${node.index}/parameters/workflowId` : `/nodes/${node.index}`;
    return ro({ node: node.name, pointer, targetWorkflowId: resolution === 'LITERAL' ? literal : null, resolution, targetExistence: 'UNKNOWN' as const });
  }).sort((left, right) => cmp(left.node, right.node)));
}

type EnvironmentBudget = { visited: number; characters: number; truncated: boolean; computed: boolean; omitted: boolean };
type EnvironmentHit = Readonly<{ index: number; evidence: PreflightNodeEvidenceV1; pointer: string; namespace: 'ENV' | 'VARS'; name: string }>;

function* parameterKeys(value: Dict | readonly unknown[], arrayLimit: number): Generator<string> {
  if (Array.isArray(value)) {
    for (let index = 0; index < Math.min(value.length, arrayLimit); index += 1) yield String(index);
  } else {
    for (const key in value) yield key;
  }
}

/** Only identifier access is an observation; computed access (`$env[...]`) stays an unnamed unknown. */
function recordEnvironmentReferences(hit: { index: number; evidence: PreflightNodeEvidenceV1 }, pointer: string, value: string, hits: EnvironmentHit[], seen: Set<string>, budget: EnvironmentBudget): void {
  for (const match of value.matchAll(ENVIRONMENT_REFERENCE)) {
    const namespace = match[1] === '$env' ? 'ENV' as const : 'VARS' as const;
    const name = match[2]!; const key = `${pointer}\u0000${namespace}\u0000${name}`;
    if (seen.has(key)) continue; seen.add(key);
    hits.push(ro({ index: hit.index, evidence: hit.evidence, pointer, namespace, name }));
  }
  if (COMPUTED_ENVIRONMENT_REFERENCE.test(value)) budget.computed = true;
}

/** Iterative so a deep or cyclic export cannot overflow the stack, and bounded so one export cannot stall it. */
function scanParameters(node: RawNodeV1, evidence: PreflightNodeEvidenceV1, hits: EnvironmentHit[], seen: Set<string>, budget: EnvironmentBudget): void {
  const stack: Array<{ value: unknown; pointer: string; depth: number; safe: boolean }> = [{ value: node.parameters, pointer: `/nodes/${node.index}/parameters`, depth: 0, safe: true }];
  while (stack.length > 0) {
    const entry = stack.pop()!;
    budget.visited += 1;
    if (budget.visited > MAX_ENVIRONMENT_VALUES || entry.depth > MAX_ENVIRONMENT_DEPTH) { budget.truncated = true; return; }
    if (typeof entry.value === 'string') {
      budget.characters += entry.value.length;
      if (budget.characters > MAX_ENVIRONMENT_CHARS) { budget.truncated = true; return; }
      if (entry.safe) recordEnvironmentReferences({ index: node.index, evidence }, entry.pointer, entry.value, hits, seen, budget);
      else {
        if (entry.value.search(ENVIRONMENT_REFERENCE) >= 0) budget.omitted = true;
        if (COMPUTED_ENVIRONMENT_REFERENCE.test(entry.value)) budget.computed = true;
      }
      continue;
    }
    if (!Array.isArray(entry.value) && !isDict(entry.value)) continue;
    const array = Array.isArray(entry.value);
    const arrayLimit = MAX_ENVIRONMENT_VALUES - budget.visited - stack.length + 1;
    for (const key of parameterKeys(entry.value, arrayLimit)) {
      if (!Object.prototype.hasOwnProperty.call(entry.value, key)) continue;
      if (budget.visited + stack.length >= MAX_ENVIRONMENT_VALUES) { budget.truncated = true; break; }
      if (!array) budget.characters += key.length;
      if (budget.characters > MAX_ENVIRONMENT_CHARS) { budget.truncated = true; return; }
      const safe = entry.safe && (array || SAFE_PARAMETER_KEYS.has(key));
      const pointer = safe ? `${entry.pointer}/${escapeJsonPointerSegment(key)}` : entry.pointer;
      const value = array ? (entry.value as unknown[])[Number(key)] : (entry.value as Dict)[key];
      stack.push({ value, pointer, depth: entry.depth + 1, safe });
    }
    if (array && (entry.value as unknown[]).length > arrayLimit) budget.truncated = true;
  }
}

function collectEnvironment(nodes: readonly RawNodeV1[], budget: EnvironmentBudget): readonly PreflightEnvironmentV1[] {
  const hits: EnvironmentHit[] = []; const seen = new Set<string>();
  for (const node of nodes) {
    if (budget.truncated || budget.visited >= MAX_ENVIRONMENT_VALUES) { budget.truncated = true; break; }
    scanParameters(node, nodeEvidence(node), hits, seen, budget);
  }
  return ro(hits.map(({ index, evidence, pointer, namespace, name }) => ({ index, pointer, row: ro({
    namespace, name, value: 'UNKNOWN' as const, availability: 'UNKNOWN' as const, evidence: ro({ ...evidence, pointer }),
  }) }))
    .sort((left, right) => left.index - right.index || cmp(left.pointer, right.pointer) || cmp(left.row.namespace, right.row.namespace) || cmp(left.row.name, right.row.name))
    .map(({ row }) => row));
}

/** The one entry point: a parsed export, its prerequisite inventory and whether an internal bound cut it short. */
export function collectPreflightInventory(workflow: unknown): Readonly<{
  nodes: readonly RawNodeV1[]; malformed: number; prerequisites: PreflightPrerequisitesV1; inventoryTruncated: boolean;
  environmentIncomplete: Readonly<{ computed: boolean; omitted: boolean }>;
}> {
  const { nodes, malformed } = readNodes(workflow);
  const budget: EnvironmentBudget = { visited: 0, characters: 0, truncated: false, computed: false, omitted: false };
  const environment = collectEnvironment(nodes, budget);
  const subworkflows = collectSubworkflows(nodes);
  const unknowns = [...UNKNOWNS_BASE];
  if (subworkflows.some((row) => row.resolution === 'DYNAMIC')) unknowns.push('a dynamic subworkflow id, and whether any referenced workflow exists, cannot be resolved offline.');
  if (budget.truncated) unknowns.push('parameter traversal stopped at an internal inventory limit, so the environment reference inventory is incomplete.');
  if (budget.computed) unknowns.push('computed environment or variable access ($env[...] or $vars[...]) cannot be named offline and stays unknown.');
  if (budget.omitted) unknowns.push('environment evidence omitted because a parameter path may contain sensitive dynamic keys.');
  return ro({
    nodes, malformed, inventoryTruncated: budget.truncated, environmentIncomplete: ro({ computed: budget.computed, omitted: budget.omitted }),
    prerequisites: ro({
      credentials: collectCredentials(nodes), communityNodes: collectCommunityNodes(nodes), integrations: collectIntegrations(nodes),
      subworkflows, environment, provenance: PROVENANCE, unknowns: ro(unknowns),
    }),
  });
}
