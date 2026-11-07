/**
 * The closed vocabulary a staged v2 regeneration run may contain, as data.
 *
 * These tables are the whole allow-list the staged-bytes sweep applies: object keys, enumerated
 * values, 16-hex ids, 64-hex digests and closed tokens. They mirror the v2 writer family's published
 * shapes (`run-v2-regeneration.ts`, `v2-regenerate-entry.ts`, `v2-scan-evidence.ts`,
 * `v2-corpus-adapter.ts`, `formal-node-coverage.ts`) and live apart from the sweep engine so the vocabulary can be read and
 * reviewed without reading the walker. A token the writer adds later is not here, so the sweep fails
 * closed on it by design.
 */
import { V2_ARTIFACT_GROUPS, V2_ENTRY_PLAN_SCHEMA_VERSION } from './v2-regenerate-entry.js';
import { V2_SCAN_EVIDENCE_SCHEMA_VERSION } from './v2-scan-evidence.js';
import { V2_REGENERATION_RUN_SCHEMA_VERSION } from './run-v2-regeneration.js';
import { DEFAULT_SCANNER_LIMITS_V2 } from '../../contracts/scanner-limits-v2.js';
import { isConsistentFormalCoverageV1 } from './staged-bytes-formal-coverage.js';

export type ValueRule =
  | { kind: 'object'; keys: Readonly<Record<string, ValueRule>>; check?: (value: unknown) => boolean } | { kind: 'array'; item: ValueRule }
  | { kind: 'oneOf'; items: readonly ValueRule[] } | { kind: 'enum'; values: readonly string[] }
  | { kind: 'literal'; value: string } | { kind: 'shaped'; pattern: RegExp }
  | { kind: 'integer' } | { kind: 'number'; min?: number; max?: number } | { kind: 'boolean' } | { kind: 'null' } | { kind: 'optional'; item: ValueRule };

/** The closed value sets of the v2 writer family; a writer that publishes a new token fails the sweep. */
const FRESHNESS = Object.freeze(['CURRENT', 'NO_RESULT', 'HISTORICAL', 'UNSCANNED', 'SOURCE_UNAVAILABLE']);
const REASONS = Object.freeze(['admitted-receipt', 'readiness-contradiction', 'unadmitted-receipt', 'no-result', 'retained-verdict', 'no-receipt', 'owner-ruling']);
const DISPOSITIONS = Object.freeze(['regenerated', 'historical', 'unavailable']);
const RIGHTS = Object.freeze(['redistributable', 'link_only', 'excluded']);
const STATUSES = Object.freeze(['COMPLETE', 'DEGRADED', 'INDETERMINATE']);
const GRADES = Object.freeze(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']);

const INTEGER: ValueRule = { kind: 'integer' };
const NULL: ValueRule = { kind: 'null' };
const ENTRY_ID: ValueRule = { kind: 'shaped', pattern: /^[0-9a-f]{16}$/ };
const DIGEST: ValueRule = { kind: 'shaped', pattern: /^[0-9a-f]{64}$/ };
const IDENTITY: ValueRule = { kind: 'shaped', pattern: /^[A-Za-z0-9][A-Za-z0-9._:+-]{0,63}$/ };
const CODE: ValueRule = { kind: 'shaped', pattern: /^[A-Z][A-Z0-9_]{0,63}$/ };
const REASON_CODE: ValueRule = { kind: 'shaped', pattern: /^[A-Z][A-Z0-9_-]{0,63}$/ };
const TEXT: ValueRule = { kind: 'shaped', pattern: /^.{0,4096}$/s };
const optional = (item: ValueRule): ValueRule => ({ kind: 'optional', item });
const arrayOf = (item: ValueRule): ValueRule => ({ kind: 'array', item });
const enums = (values: readonly string[]): ValueRule => ({ kind: 'enum', values });
const enumCounts = (values: readonly string[]): ValueRule => ({
  kind: 'object', keys: Object.fromEntries(values.map((value) => [value, INTEGER])),
});

const ASSESSMENT: ValueRule = { kind: 'object', keys: {
  label: enums(['CURRENT', 'HISTORICAL']), grade: optional(enums(GRADES)), analysisStatus: optional(enums(STATUSES)),
  diagnosticCodes: arrayOf(CODE), producingIdentity: IDENTITY,
} };
const PLAN: ValueRule = { kind: 'object', keys: {
  schemaVersion: { kind: 'literal', value: V2_ENTRY_PLAN_SCHEMA_VERSION }, entryId: ENTRY_ID,
  state: enums(FRESHNESS), stateReason: enums(REASONS), rightsClass: enums(RIGHTS), inventorySha256: DIGEST,
  assessment: optional(ASSESSMENT), bodySha256: optional(DIGEST), resultDigest: optional(DIGEST),
  receiptReasonCode: optional(REASON_CODE),
  artifacts: arrayOf({ kind: 'object', keys: { group: enums(V2_ARTIFACT_GROUPS), disposition: enums(DISPOSITIONS) } }),
} };
const formalCoverageRate = (target: 'meets90Percent' | 'meets95Percent'): ValueRule => ({ kind: 'object', keys: {
  numerator: { kind: 'oneOf', items: [INTEGER, NULL] }, denominator: { kind: 'oneOf', items: [INTEGER, NULL] },
  ratio: { kind: 'oneOf', items: [{ kind: 'number', min: 0, max: 1 }, NULL] }, [target]: { kind: 'boolean' },
} });
const FORMAL_COVERAGE_BINDING: ValueRule = { kind: 'object', keys: {
  inventoryFileSha256: DIGEST, inventorySha256: DIGEST, bodyMapSha256: DIGEST, scopedSemanticsDigest: DIGEST,
  legacySemanticsDigest: DIGEST, engineBuildDigest: DIGEST, sourceReceiptSha256: DIGEST,
  producerSourceSha256: DIGEST, sourceBindingsSha256: DIGEST, measurementContextSha256: DIGEST,
  executionContext: { kind: 'object', keys: {
    limits: { kind: 'object', keys: {
      schemaVersion: { kind: 'literal', value: DEFAULT_SCANNER_LIMITS_V2.schemaVersion },
      ...Object.fromEntries(Object.keys(DEFAULT_SCANNER_LIMITS_V2).filter((key) => key !== 'schemaVersion').map((key) => [key, INTEGER] as const)),
    } },
    lockfileSha256: DIGEST,
    runtime: { kind: 'object', keys: {
      node: { kind: 'shaped', pattern: /^v?\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/ },
      v8: { kind: 'shaped', pattern: /^v?\d+\.\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/ },
      platform: { kind: 'shaped', pattern: /^[a-z0-9]+$/ }, arch: { kind: 'shaped', pattern: /^[a-z0-9]+$/ },
      loaderArgumentsSha256: DIGEST,
    } },
    tools: { kind: 'object', keys: Object.fromEntries(['@humanwhocodes/momoa', '@noble/hashes', 'tsx', 'typescript']
      .map((name) => [name, { kind: 'shaped', pattern: /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}:[0-9a-f]{64}$/ }] as const)),
    },
  } },
} };
const FORMAL_COVERAGE: ValueRule = { kind: 'object', check: isConsistentFormalCoverageV1, keys: {
  schemaVersion: { kind: 'literal', value: 'q02-formal-coverage-v1' },
  status: enums(['COMPLETE', 'INCOMPLETE']), countsScope: enums(['EXAMINED_COHORT_ONLY', 'FULL_COHORT']),
  cohort: { kind: 'object', keys: {
    id: { kind: 'literal', value: 'q02-official-nodes-v1' },
    ruleVersion: { kind: 'literal', value: 'executable-official-scoped-v1' },
    namespaces: arrayOf({ kind: 'oneOf', items: [
      { kind: 'literal', value: 'n8n-nodes-base' }, { kind: 'literal', value: '@n8n/n8n-nodes-langchain' },
    ] }),
  } },
  binding: FORMAL_COVERAGE_BINDING,
  counts: { kind: 'object', keys: {
    cohortWorkflows: INTEGER, workflowsWithExecutableNodes: INTEGER, executableInstances: INTEGER,
    reviewedExecutableInstances: INTEGER, fullyModelledWorkflows: INTEGER, reviewedInertNodes: INTEGER,
  } },
  rates: { kind: 'object', keys: {
    reviewedExecutableInstances: formalCoverageRate('meets95Percent'),
    fullyModelledWorkflows: formalCoverageRate('meets90Percent'),
  } },
  exclusions: arrayOf({ kind: 'object', keys: {
    entryId: ENTRY_ID,
    reason: enums(['MALFORMED', 'MISSING', 'SOURCE_UNAVAILABLE', 'COMMUNITY_PACKAGE', 'INVALID_NODE_IDENTITY', 'NO_EXECUTABLE_NODE', 'REJECTED_INPUT']),
    reasonCode: optional(REASON_CODE),
  } }),
  unknownMeasurements: arrayOf({ kind: 'object', keys: {
    entryId: ENTRY_ID, stage: enums(['SOURCE', 'NORMALIZATION']),
    code: enums(['WORKFLOW_TOO_LARGE', 'WORKFLOW_TOO_COMPLEX']), cause: optional(TEXT),
  } }),
  wholeCorpus: { kind: 'object', keys: {
    inventoryRows: INTEGER, availableBodies: INTEGER, missing: INTEGER, sourceUnavailable: INTEGER,
    malformed: INTEGER, rejected: INTEGER, measurementUnknown: INTEGER, communityPackage: INTEGER,
    invalidNodeIdentity: INTEGER, noExecutableNode: INTEGER, formalCohort: INTEGER,
    disabledNodes: INTEGER, reviewedInertNodes: INTEGER,
    inventoryStatuses: enumCounts(['AVAILABLE', 'MISSING', 'SOURCE_UNAVAILABLE', 'UNPARSEABLE', 'REJECTED']),
  } },
} };
const RUN: ValueRule = { kind: 'object', keys: {
  schemaVersion: { kind: 'literal', value: V2_REGENERATION_RUN_SCHEMA_VERSION }, inventorySha256: DIGEST, entryCount: INTEGER,
  states: enumCounts(FRESHNESS), reasons: enumCounts(REASONS),
  artifactGroups: arrayOf({ kind: 'object', keys: {
    group: enums(V2_ARTIFACT_GROUPS), regenerated: INTEGER, historical: INTEGER, unavailable: INTEGER,
  } }),
  currentVerdicts: { kind: 'object', keys: { count: INTEGER, producingIdentities: arrayOf(IDENTITY) } },
  plans: arrayOf(PLAN),
  formalCoverage: { kind: 'oneOf', items: [{ kind: 'null' }, FORMAL_COVERAGE] },
} };
const SCAN: ValueRule = { kind: 'object', keys: {
  entryId: ENTRY_ID, rightsClass: enums(RIGHTS), ok: { kind: 'boolean' },
  identity: { kind: 'object', keys: {
    scannerVersion: IDENTITY, engineBuildDigest: DIGEST, profileId: IDENTITY, profileVersion: IDENTITY,
    rulesetDigest: DIGEST, semanticsDigest: DIGEST, limitsDigest: DIGEST,
  } },
  bodySha256: DIGEST, resultDigest: optional(DIGEST), analysisStatus: enums(STATUSES),
  assessment: optional({ kind: 'object', keys: { grade: enums(GRADES), score: INTEGER } }),
  security: { kind: 'object', keys: {
    schemaVersion: enums(['scanner-result-v1', 'scanner-result-v2']), grade: enums([...GRADES, 'UNKNOWN']), score: INTEGER,
    counts: { kind: 'object', keys: { critical: INTEGER, high: INTEGER, medium: INTEGER, low: INTEGER, info: INTEGER } },
    findings: arrayOf({ kind: 'object', keys: { id: CODE, title: { kind: 'shaped', pattern: /^.{0,4096}$/s }, severity: enums(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO']), node: optional({ kind: 'shaped', pattern: /^.{1,512}$/s }), why: { kind: 'shaped', pattern: /^.{0,4096}$/s }, fix: { kind: 'shaped', pattern: /^.{0,4096}$/s } } }),
    hardenedExtra: INTEGER, scannerVersion: IDENTITY, profile: enums(['beta-default', 'beta-hardened']), analysisStatus: enums(STATUSES),
    analysisDiagnosticCodes: optional(arrayOf(CODE)), stampReason: optional(enums(['source_unavailable'])),
    noResult: optional({ kind: 'boolean' }), noResultCode: optional(CODE),
  } },
  diagnosticCodes: arrayOf(CODE), findingIds: arrayOf(DIGEST), refusalCode: optional(CODE),
} };
const RECORD: ValueRule = { kind: 'object', keys: {
  schemaVersion: { kind: 'literal', value: V2_SCAN_EVIDENCE_SCHEMA_VERSION }, entryId: ENTRY_ID,
  scanFreshness: enums(FRESHNESS), rightsClass: enums(RIGHTS), inventorySha256: DIGEST, scan: optional(SCAN),
  retainedVerdict: optional({ kind: 'object', keys: {
    scannerVersion: IDENTITY, grade: optional(enums(GRADES)), analysisStatus: optional(enums(STATUSES)),
  } }),
  receiptReasonCode: optional(REASON_CODE),
} };

/** The two file names the v2 writer emits; any other staged file name is itself a finding. */
export const STAGED_FILES: Readonly<Record<string, { rule: ValueRule; lines: boolean }>> = Object.freeze({
  'v2-regeneration-report.json': { rule: RUN, lines: false },
  'v2-scan-evidence.ndjson': { rule: RECORD, lines: true },
});

/** Raw-text classes the schema alone under-names: drive/UNC and absolute paths, URLs, credential markers. */
export const TEXT_RULES: readonly Readonly<{ rule: 'url' | 'credential-marker'; pattern: RegExp }>[] = Object.freeze([
  { rule: 'url', pattern: /\b(?:https?|ftp):\/\//i },
  { rule: 'credential-marker', pattern: /(?:password|passwd|secret|token|api[ _-]?key|authorization|bearer)\s*[:=]/i },
]);
/** Decoded string values only: raw JSON escapes (\/) must never hide a filesystem path. */
export const STRICT_PATH = /[A-Za-z]:[\\/]|\\\\[^\\/]+[\\/]|file:\/\/|(?:^|[^A-Za-z0-9])\.\.[\\/]|\/(?:home|Users|srv|var|etc|mnt|opt|tmp|root|private)\//;
/** The legacy catch-all, unanchored; skipped only for an actual finding `node` display value. */
export const GENERIC_POSIX_PATH = /\/(?:[A-Za-z0-9._-]+\/)+[A-Za-z0-9._-]+/;
/** Strict paths are rejected in every decoded string; the generic slash form only skips finding.node. */
export function scanDecodedPaths(value: unknown, segments: readonly (string | number)[], artifact: string, jsonPath: string, report: (artifact: string, jsonPath: string, rule: 'filesystem-path') => void): void {
  if (typeof value === 'string') {
    if (STRICT_PATH.test(value)) report(artifact, jsonPath, 'filesystem-path');
    const findingNode = segments.at(-1) === 'node' && segments.includes('findings');
    if (!findingNode && GENERIC_POSIX_PATH.test(value)) report(artifact, jsonPath, 'filesystem-path');
    return;
  }
  if (Array.isArray(value)) { value.forEach((item, index) => scanDecodedPaths(item, [...segments, index], artifact, `${jsonPath}[${index}]`, report)); return; }
  if (value !== null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) scanDecodedPaths(child, [...segments, key], artifact, `${jsonPath}.${key}`, report);
  }
}

export const CONTROL_CHARACTER = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
