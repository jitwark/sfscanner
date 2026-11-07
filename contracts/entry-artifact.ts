import {
  RIGHTS_STATUSES,
  type Entry,
  type EntryReadiness,
  type EntrySource,
  type GeneratedDescription,
  type PublicFinding,
} from './index';
import { MAX_ARTIFACT_CHARS, MAX_CATALOGUE_ARTIFACT_CHARS, MAX_ID_CHARS, count, parseJsonObject, record, text } from './artifact-validation';
import { SCANNER_RESULT_SCHEMA_VERSION, parseScannerResultSchemaVersion } from './scanner-result';

const GRADES = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL', 'UNKNOWN'] as const;
const SEVERITIES = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO'] as const;
const COMPLEXITIES = ['simple', 'medium', 'complex'] as const;
const DESCRIPTION_SOURCES = ['upstream', 'generated', 'fallback'] as const;
const PROVENANCE_SOURCES = ['gemini', 'upstream', 'fallback', 'unknown'] as const;
const PROFILES = ['beta-default', 'beta-hardened'] as const;
const ANALYSIS_STATUSES = ['COMPLETE', 'DEGRADED', 'INDETERMINATE'] as const;
/** Why a `not-scanned` stamp was written; closed vocabulary, like every other marker here. */
const STAMP_REASONS = ['source_unavailable'] as const;
const REPLACEABLE_KINDS = ['url', 'email', 'phone', 'chat_id', 'sheet_id', 'id'] as const;
const READINESS_ANALYSES = ['derived', 'unscanned'] as const;
const COMPATIBILITY_STATUSES = ['likely-compatible', 'review-required', 'unknown'] as const;
const MAX_ENTRY_ARRAY = 5_000;
const MAX_ENTRY_TEXT = 262_144;
const MAX_SMALL_ARRAY = 5_000;
const SHA256_HEX = /^[0-9a-f]{64}$/;

function invalid(label: string): never { throw new Error(`Malformed entry: ${label}`); }
function obj(value: unknown, label: string): Record<string, unknown> { return record(value) ?? invalid(label); }
function reqText(value: unknown, label: string, max = MAX_ENTRY_TEXT): string {
  return text(value, max) && value.length > 0 ? value : invalid(label);
}
function optText(value: unknown, label: string, max = MAX_ENTRY_TEXT): string | undefined {
  return value === undefined ? undefined : reqText(value, label, max);
}
function nullableText(value: unknown, label: string, max = MAX_ENTRY_TEXT): string | null {
  return value === null ? null : reqText(value, label, max);
}
function flag(value: unknown, label: string): boolean { return typeof value === 'boolean' ? value : invalid(label); }
function integer(value: unknown, label: string, max = Number.MAX_SAFE_INTEGER): number {
  return count(value, max) ? value : invalid(label);
}
function choice<T extends string>(value: unknown, values: readonly T[], label: string): T {
  return typeof value === 'string' && (values as readonly string[]).includes(value) ? value as T : invalid(label);
}
function textList(value: unknown, label: string, max = MAX_SMALL_ARRAY): string[] {
  if (!Array.isArray(value) || value.length > max) invalid(label);
  return value.map((item) => reqText(item, label, 4_096));
}

function parseSource(value: unknown): EntrySource {
  const raw = obj(value, 'source');
  const source: EntrySource = { kind: choice(raw.kind, ['github', 'n8n_official'], 'source.kind'), permalink: reqText(raw.permalink, 'source.permalink', 4_096), fetchedAt: reqText(raw.fetchedAt, 'source.fetchedAt', 128) };
  const strings: Array<[keyof EntrySource, number]> = [['repo', 2_048], ['owner', 512], ['path', 4_096], ['commit', 256], ['committedAt', 128]];
  for (const [key, max] of strings) { const item = optText(raw[key], `source.${String(key)}`, max); if (item !== undefined) source[key] = item as never; }
  if (raw.stars !== undefined) source.stars = integer(raw.stars, 'source.stars');
  if (raw.templateId !== undefined) source.templateId = integer(raw.templateId, 'source.templateId');
  if (raw.author !== undefined) { const author = obj(raw.author, 'source.author'); source.author = { name: reqText(author.name, 'source.author.name', 512) }; const username = optText(author.username, 'source.author.username', 512); const url = optText(author.url, 'source.author.url', 4_096); if (username !== undefined) source.author.username = username; if (url !== undefined) source.author.url = url; }
  return source;
}

function parseStructure(value: unknown): Entry['structure'] {
  const raw = obj(value, 'structure');
  return { nodeCount: integer(raw.nodeCount, 'structure.nodeCount'), rawNodeCount: integer(raw.rawNodeCount, 'structure.rawNodeCount'), annotationNodeCount: integer(raw.annotationNodeCount, 'structure.annotationNodeCount'), connectionCount: integer(raw.connectionCount, 'structure.connectionCount'), nodeTypes: textList(raw.nodeTypes, 'structure.nodeTypes'), integrations: textList(raw.integrations, 'structure.integrations'), trigger: reqText(raw.trigger, 'structure.trigger', 512), isSubWorkflow: flag(raw.isSubWorkflow, 'structure.isSubWorkflow'), complexity: choice(raw.complexity, COMPLEXITIES, 'structure.complexity'), hasCode: flag(raw.hasCode, 'structure.hasCode'), hasAI: flag(raw.hasAI, 'structure.hasAI'), hasWebhook: flag(raw.hasWebhook, 'structure.hasWebhook'), ...(raw.partial === undefined ? {} : { partial: flag(raw.partial, 'structure.partial') }) };
}

function parseFinding(value: unknown): PublicFinding {
  const raw = obj(value, 'security.finding');
  return { id: reqText(raw.id, 'finding.id', 256), title: reqText(raw.title, 'finding.title'), severity: choice(raw.severity, SEVERITIES, 'finding.severity'), ...(raw.node === undefined ? {} : { node: reqText(raw.node, 'finding.node', 512) }), why: reqText(raw.why, 'finding.why'), fix: reqText(raw.fix, 'finding.fix') };
}

function parseSecurity(value: unknown): Entry['security'] {
  const raw = obj(value, 'security'); const counts = obj(raw.counts, 'security.counts');
  if (!Array.isArray(raw.findings) || raw.findings.length > 20) invalid('security.findings');
  const grade = choice(raw.grade, GRADES, 'security.grade');
  const score = typeof raw.score === 'number' && Number.isFinite(raw.score) && raw.score >= 0 && raw.score <= 100 ? raw.score : invalid('security.score');
  const analysisStatus = raw.analysisStatus === undefined ? undefined : choice(raw.analysisStatus, ANALYSIS_STATUSES, 'security.analysisStatus');
  const analysisDiagnosticCodes = raw.analysisDiagnosticCodes === undefined ? undefined : textList(raw.analysisDiagnosticCodes, 'security.analysisDiagnosticCodes', 100);
  const stampReason = raw.stampReason === undefined ? undefined : choice(raw.stampReason, STAMP_REASONS, 'security.stampReason');
  const noResult = raw.noResult === undefined ? undefined : raw.noResult === true ? true : invalid('security.noResult');
  const noResultCode = raw.noResultCode === undefined ? undefined : reqText(raw.noResultCode, 'security.noResultCode', 64);
  const scannerVersion = reqText(raw.scannerVersion, 'security.scannerVersion', 256);
  const schemaVersion = raw.schemaVersion === undefined ? undefined : raw.schemaVersion === 'scanner-result-v2' ? 'scanner-result-v2' : parseScannerResultSchemaVersion(raw.schemaVersion);
  const legacyFallback = scannerVersion === 'unscanned' || scannerVersion === 'not-scanned' || analysisStatus === 'INDETERMINATE';
  if (schemaVersion === undefined && !legacyFallback) invalid('security.schemaVersion');
  if (analysisStatus === 'INDETERMINATE' && (grade !== 'UNKNOWN' || score !== 0)) invalid('security.indeterminate verdict');
  if (analysisStatus === 'COMPLETE' && analysisDiagnosticCodes !== undefined && analysisDiagnosticCodes.length > 0) invalid('security.complete diagnostics');
  // A v2 DEGRADED result may legitimately carry no diagnostic code: a capability with skipped units
  // coerces the status without emitting a diagnostic. A v1 DEGRADED row still states its codes.
  if (analysisStatus === 'DEGRADED' && schemaVersion === SCANNER_RESULT_SCHEMA_VERSION && (!analysisDiagnosticCodes || analysisDiagnosticCodes.length === 0)) invalid('security.degraded diagnostics');
  return { grade, score, counts: { critical: integer(counts.critical, 'security.counts.critical'), high: integer(counts.high, 'security.counts.high'), medium: integer(counts.medium, 'security.counts.medium'), low: integer(counts.low, 'security.counts.low'), info: integer(counts.info, 'security.counts.info') }, findings: raw.findings.map(parseFinding), hardenedExtra: integer(raw.hardenedExtra, 'security.hardenedExtra'), scannerVersion, profile: choice(raw.profile, PROFILES, 'security.profile'), ...(schemaVersion === undefined ? {} : { schemaVersion }), ...(analysisStatus === undefined ? {} : { analysisStatus }), ...(analysisDiagnosticCodes === undefined ? {} : { analysisDiagnosticCodes }), ...(stampReason === undefined ? {} : { stampReason }), ...(noResult === undefined ? {} : { noResult }), ...(noResultCode === undefined ? {} : { noResultCode }) };
}

function parseDescription(value: unknown): GeneratedDescription {
  const raw = obj(value, 'descriptionContent'); const beforeAfter = obj(raw.beforeAfter, 'descriptionContent.beforeAfter');
  return { headline: reqText(raw.headline, 'descriptionContent.headline'), summary: reqText(raw.summary, 'descriptionContent.summary'), outcome: reqText(raw.outcome, 'descriptionContent.outcome'), beforeAfter: { before: reqText(beforeAfter.before, 'descriptionContent.before'), after: reqText(beforeAfter.after, 'descriptionContent.after') }, exampleScenario: reqText(raw.exampleScenario, 'descriptionContent.exampleScenario'), howItWorks: textList(raw.howItWorks, 'descriptionContent.howItWorks', 100), limitations: textList(raw.limitations, 'descriptionContent.limitations', 100), audience: reqText(raw.audience, 'descriptionContent.audience') };
}

function parseReadiness(value: unknown): EntryReadiness {
  const raw = obj(value, 'readiness'); const ai = obj(raw.aiModel, 'readiness.aiModel'); const pinned = obj(raw.pinnedData, 'readiness.pinnedData');
  if (!Array.isArray(raw.replaceableValues) || raw.replaceableValues.length > MAX_SMALL_ARRAY) invalid('readiness.replaceableValues');
  const analysis = raw.analysis === undefined ? undefined : choice(raw.analysis, READINESS_ANALYSES, 'readiness.analysis');
  return { ...(analysis === undefined ? {} : { analysis }), credentials: textList(raw.credentials, 'readiness.credentials'), replaceableValues: raw.replaceableValues.map((item) => { const x = obj(item, 'readiness.replaceableValue'); return { node: reqText(x.node, 'readiness.replaceableValue.node', 512), field: reqText(x.field, 'readiness.replaceableValue.field', 2_048), kind: choice(x.kind, REPLACEABLE_KINDS, 'readiness.replaceableValue.kind') }; }), writeActions: textList(raw.writeActions, 'readiness.writeActions'), aiModel: { present: flag(ai.present, 'readiness.aiModel.present'), model: nullableText(ai.model, 'readiness.aiModel.model', 512) }, extraPackages: textList(raw.extraPackages, 'readiness.extraPackages'), versionNotes: textList(raw.versionNotes, 'readiness.versionNotes'), pinnedData: { present: flag(pinned.present, 'readiness.pinnedData.present'), nodeCount: integer(pinned.nodeCount, 'readiness.pinnedData.nodeCount') }, isSubWorkflow: flag(raw.isSubWorkflow, 'readiness.isSubWorkflow') };
}

function parseOptionalFields(raw: Record<string, unknown>, entry: Entry): void {
  if (raw.isPrerendered !== undefined) entry.isPrerendered = flag(raw.isPrerendered, 'isPrerendered');
  if (raw.descriptionProvenance !== undefined) { const x = obj(raw.descriptionProvenance, 'descriptionProvenance'); const result: NonNullable<Entry['descriptionProvenance']> = { source: choice(x.source, PROVENANCE_SOURCES, 'descriptionProvenance.source') }; for (const key of ['model', 'promptVersion', 'promptHash', 'schemaVersion', 'workflowHash', 'generatedAt'] as const) { const item = optText(x[key], `descriptionProvenance.${key}`, 256); if (item !== undefined) result[key] = item; } entry.descriptionProvenance = result; }
  if (raw.descriptionContent !== undefined) entry.descriptionContent = parseDescription(raw.descriptionContent);
  if (raw.readiness !== undefined) entry.readiness = parseReadiness(raw.readiness);
  if (raw.compatibility !== undefined) { const x = obj(raw.compatibility, 'compatibility'); entry.compatibility = { targetVersion: reqText(x.targetVersion, 'compatibility.targetVersion', 128), checkedAt: reqText(x.checkedAt, 'compatibility.checkedAt', 128), source: reqText(x.source, 'compatibility.source', 512), status: choice(x.status, COMPATIBILITY_STATUSES, 'compatibility.status'), reasons: textList(x.reasons, 'compatibility.reasons', 100), blockers: textList(x.blockers, 'compatibility.blockers', 100) }; }
  if (raw.hostnames !== undefined) { const x = obj(raw.hostnames, 'hostnames'); if (!Array.isArray(x.dynamic) || x.dynamic.length > MAX_SMALL_ARRAY) invalid('hostnames.dynamic'); entry.hostnames = { literal: textList(x.literal, 'hostnames.literal'), dynamic: x.dynamic.map((item) => ({ host: reqText(obj(item, 'hostnames.dynamic.item').host, 'hostnames.dynamic.host', 512) })), undeterminable: integer(x.undeterminable, 'hostnames.undeterminable') }; }
  if (raw.chartRef !== undefined) { const x = obj(raw.chartRef, 'chartRef'); entry.chartRef = { shard: integer(x.shard, 'chartRef.shard'), offset: integer(x.offset, 'chartRef.offset'), length: integer(x.length, 'chartRef.length') }; if (entry.chartRef.length === 0) invalid('chartRef.length'); }
  if (raw.download !== undefined) { const x = obj(raw.download, 'download'); const sha256 = optText(x.sha256, 'download.sha256', 64); if (sha256 !== undefined && !SHA256_HEX.test(sha256)) invalid('download.sha256'); entry.download = { pack: integer(x.pack, 'download.pack'), line: integer(x.line, 'download.line'), offset: integer(x.offset, 'download.offset'), length: integer(x.length, 'download.length'), ...(sha256 === undefined ? {} : { sha256 }) }; if (entry.download.length === 0) invalid('download.length'); }
}

/** Validates and narrows one catalogue/detail entry, dropping unknown fields. */
export function parseEntryArtifact(value: unknown): Entry {
  const raw = obj(value, 'object'); const rights = obj(raw.rights, 'rights'); const dedup = obj(raw.dedup, 'dedup');
  const entry: Entry = { id: reqText(raw.id, 'id', MAX_ID_CHARS), slug: reqText(raw.slug, 'slug', 512), title: reqText(raw.title, 'title'), summary: reqText(raw.summary, 'summary'), description: reqText(raw.description, 'description'), descriptionSource: choice(raw.descriptionSource, DESCRIPTION_SOURCES, 'descriptionSource'), source: parseSource(raw.source), rights: { status: choice(rights.status, RIGHTS_STATUSES, 'rights.status'), licence: nullableText(rights.licence, 'rights.licence', 512), licenceUrl: nullableText(rights.licenceUrl, 'rights.licenceUrl', 4_096), reason: reqText(rights.reason, 'rights.reason') }, structure: parseStructure(raw.structure), security: parseSecurity(raw.security), tags: textList(raw.tags, 'tags', MAX_SMALL_ARRAY), dedup: { fingerprint: reqText(dedup.fingerprint, 'dedup.fingerprint', 256), structuralHash: reqText(dedup.structuralHash, 'dedup.structuralHash', 256), canonical: flag(dedup.canonical, 'dedup.canonical'), ...(dedup.duplicateOf === undefined ? {} : { duplicateOf: reqText(dedup.duplicateOf, 'dedup.duplicateOf', MAX_ID_CHARS) }), alsoFoundIn: textList(dedup.alsoFoundIn, 'dedup.alsoFoundIn', MAX_SMALL_ARRAY) } };
  parseOptionalFields(raw, entry); return entry;
}

/** Validates a catalogue shard and enforces unique IDs within that artifact. */
export function parseEntryArrayArtifact(value: unknown): Entry[] {
  if (!Array.isArray(value) || value.length > MAX_ENTRY_ARRAY) invalid('array'); const seen = new Set<string>();
  return value.map((item) => { const entry = parseEntryArtifact(item); if (seen.has(entry.id)) invalid('duplicate id'); seen.add(entry.id); return entry; });
}

export function parseEntryJson(json: string): Entry { return parseEntryArtifact(parseJsonObject(json, 'entry')); }
export function parseEntryArrayJson(json: string): Entry[] {
  if (typeof json !== 'string' || json.length > MAX_CATALOGUE_ARTIFACT_CHARS) invalid('payload is too large'); let value: unknown; try { value = JSON.parse(json); } catch { invalid('invalid JSON'); } return parseEntryArrayArtifact(value);
}
