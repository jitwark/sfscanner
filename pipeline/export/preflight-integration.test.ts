import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PUBLIC_DATA_MODEL_SCHEMA_VERSION_V4, readPublicWorkflowRows } from '@hub/contracts/public-data-model';
import type { CorpusV2InputReceipt } from '../../scripts/lib/corpus-v2-input-inventory.js';
import { makeEntry } from '../__fixtures__/make-entry.js';
import { releaseForEntries } from '../__fixtures__/scan-provenance-cases.js';
import { deriveCapturedBody, publicSourceId } from './body-derived-metadata.js';
import { buildPublicProjectionV4 } from './public-projection-v4.js';
import { buildPublicProjection } from './public-projection.js';
import { writePreflightSidecar, readPreflightSidecar, PREFLIGHT_SIDECAR_PATH } from './preflight-sidecar.js';
import { writePublicRelease } from './public-release.js';
import { verifyNdjsonRelease } from './ndjson.js';
import { verifySqliteRelease } from './sqlite.js';
import { verifyExcelRelease } from './excel.js';
import { readZip } from './xlsx-zip.js';
import { projectionSections, sealedDatasetId, verifyDatasetReleaseId } from '../../scripts/lib/public-dataset-identity.js';

const SECRET = 'SECRET_canary_do_not_publish_72483';
const hash = (v: Uint8Array | string) => crypto.createHash('sha256').update(v).digest('hex');
const inventorySha256 = 'b'.repeat(64);
const dirs: string[] = [];
const scratch = () => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dataset-v4-')); dirs.push(dir); return dir; };
const entry = makeEntry({ id: 'safe-one', title: '=1+1', download: undefined });
const body = { nodes: [
  { name: SECRET, type: 'n8n-nodes-base.httpRequest', typeVersion: 1, credentials: { [SECRET]: { id: SECRET, name: SECRET } }, parameters: { url: '={{$env.' + SECRET + '}}' } },
  { name: SECRET, type: 'n8n-nodes-base.executeWorkflow', parameters: { workflowId: SECRET } },
  { name: SECRET, type: 'n8n-nodes-base.executeWorkflow', parameters: {} },
  { name: SECRET, type: SECRET + '.custom' },
], connections: {} };
const bytes = new TextEncoder().encode(JSON.stringify(body));
const receipt = (overrides: Partial<CorpusV2InputReceipt> = {}): CorpusV2InputReceipt => ({
  entryId: entry.id, identityKind: 'GITHUB', status: 'AVAILABLE', bodySha256: hash(bytes), byteLength: bytes.length,
  sourceCommit: 'private', sourcePath: 'private', reasonCode: null, ...overrides,
});
const safe = () => deriveCapturedBody(receipt(), inventorySha256, publicSourceId(entry), bytes).preflight;
afterEach(() => { vi.restoreAllMocks(); for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

describe('source-bound safe preflight', () => {
  it('emits one real credential container, exact pointers and canonical measured omissions', () => {
    const record = safe();
    expect(record.evidence.filter((row) => row.category === 'credential')).toMatchObject([
      { pointerScope: 'CONTAINER', detailPointer: '/nodes/0/credentials', observation: 'observed', observationOrdinal: 0, credentialReference: null },
    ]);
    expect(record.evidence.filter((row) => row.category === 'subworkflow')).toMatchObject([
      { pointerScope: 'NODE', detailPointer: '/nodes/2', subworkflowResolution: 'ABSENT', observation: 'unresolved' },
      { pointerScope: 'FIELD', detailPointer: '/nodes/1/parameters/workflowId', subworkflowResolution: 'LITERAL' },
    ]);
    expect(record.coverage.coverageState).toBe('PARTIAL');
    expect(record.coverage.omissionCounts).toContainEqual({ code: 'CREDENTIAL_POINTER_WITHHELD', count: 1, basis: 'EXACT' });
    expect(record.coverage.omissionCounts.find((row) => row.code === 'NODE_NAME_WITHHELD')?.count).toBe(record.evidence.length);
    expect(record.evidence.every((row) => row.nodeName === null && row.requirement === 'unknown' && row.installation === 'UNKNOWN')).toBe(true);
    expect(JSON.stringify(record)).not.toContain(SECRET);
  });

  it.each(['MISSING', 'SOURCE_UNAVAILABLE', 'UNPARSEABLE', 'REJECTED'] as const)('keeps %s unknown with the actual read-body hash', (status) => {
    const read = status === 'UNPARSEABLE' || status === 'REJECTED';
    const captured = read ? new TextEncoder().encode('not json') : undefined;
    const metadata = deriveCapturedBody(receipt({ status, bodySha256: captured ? hash(captured) : null, byteLength: captured?.length ?? null }), inventorySha256, publicSourceId(entry), captured);
    expect(metadata.preflight.coverage.coverageState).toBe('UNKNOWN');
    expect(metadata.preflight.coverage.sourceBodySha256).toBe(captured ? hash(captured) : null);
    expect(metadata.preflight.evidence).toEqual([]);
  });

  it('refuses mismatching hash or length and distinguishes examined empty from rejected collector', () => {
    expect(() => deriveCapturedBody(receipt({ bodySha256: 'a'.repeat(64) }), inventorySha256, publicSourceId(entry), bytes)).toThrow(/hash\/length/);
    const empty = new TextEncoder().encode('{"nodes":[]}');
    const clean = deriveCapturedBody(receipt({ bodySha256: hash(empty), byteLength: empty.length }), inventorySha256, publicSourceId(entry), empty);
    expect(clean.preflight.coverage.coverageState).toBe('COMPLETE');
    const malformed = new TextEncoder().encode('{}');
    const unknown = deriveCapturedBody(receipt({ bodySha256: hash(malformed), byteLength: malformed.length }), inventorySha256, publicSourceId(entry), malformed);
    expect(unknown.preflight.coverage.coverageState).toBe('UNKNOWN');
  });

  it('withholds unsafe paths and counts truncated/computed evidence honestly', () => {
    const unsafe = Buffer.from(JSON.stringify({ nodes: [{ name: SECRET, type: 'n8n-nodes-base.set',
      credentials: [SECRET], parameters: { [SECRET]: '={{$env.' + SECRET + '}}', text: '={{$env["' + SECRET + '"]}}' } }], connections: {} }));
    const result = deriveCapturedBody(receipt({ bodySha256: hash(unsafe), byteLength: unsafe.length }), inventorySha256, publicSourceId(entry), unsafe).preflight;
    expect(result.coverage.omissionCounts).toEqual(expect.arrayContaining([
      { code: 'UNSAFE_PARAMETER_PATH', count: 1, basis: 'LOWER_BOUND' },
      { code: 'COMPUTED_ACCESS', count: 1, basis: 'LOWER_BOUND' },
      { code: 'INVALID_EXPORT_EVIDENCE', count: 1, basis: 'EXACT' },
    ]));
    expect(result.coverage.coverageState).toBe('PARTIAL');
    expect(result.evidence).toEqual([]);
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  it('keeps evidence IDs independent of withheld credential identifiers and names', () => {
    const changed = Buffer.from(JSON.stringify(body).replaceAll(SECRET, 'different_private_token'));
    const result = deriveCapturedBody(receipt({ bodySha256: hash(changed), byteLength: changed.length }), inventorySha256, publicSourceId(entry), changed).preflight;
    expect(result.evidence.map((row) => row.evidenceId)).toEqual(safe().evidence.map((row) => row.evidenceId));
  });

  it('withholds credential-key and package fallback tokens from legacy V4 relations too', () => {
    const token = 'private_canary_token_992';
    const raw = Buffer.from(JSON.stringify({ nodes: [{ name: 'Node', type: 'n8n-nodes-base.set', parameters: {}, credentials: { [token]: { id: token } } },
      { name: 'Community', type: token + '.custom', parameters: {}, credentials: { [token]: { id: token } } }], connections: {} }));
    const captured = deriveCapturedBody(receipt({ bodySha256: hash(raw), byteLength: raw.length }), inventorySha256, publicSourceId(entry), raw, true);
    const updated = { ...entry, readiness: captured.replacement!.readiness };
    const projection = buildPublicProjectionV4([updated], { release: { ...releaseForEntries([updated]), schemaVersion: PUBLIC_DATA_MODEL_SCHEMA_VERSION_V4 }, preflight: [captured.preflight], inventorySha256 });
    expect(JSON.stringify(projection).toLowerCase()).not.toContain(token);
    expect(projection.requirements.filter((row) => row.kind === 'credential')).toHaveLength(2);
    expect(projection.requirements.filter((row) => row.kind === 'community-node')).toHaveLength(1);
  });

  it('replaces legacy node/field/version-note exposure with closed labels and distinct safe IDs', () => {
    const privateEntry = { ...entry, readiness: {
      analysis: 'derived' as const, credentials: [], replaceableValues: [
        { node: SECRET, field: SECRET, kind: 'url' as const }, { node: SECRET, field: SECRET, kind: 'url' as const },
      ], writeActions: [], aiModel: { present: false, model: null }, extraPackages: [], versionNotes: [SECRET],
      pinnedData: { present: false, nodeCount: 0 }, isSubWorkflow: false,
    } };
    const projection = buildPublicProjection([privateEntry], { release: releaseForEntries([privateEntry]), linkOnly: true });
    expect(projection.requirements.map((row) => row.label).sort()).toEqual(['Replaceable workflow value', 'Replaceable workflow value', 'Workflow version note']);
    expect(new Set(projection.requirements.map((row) => row.requirementId)).size).toBe(3);
    expect(JSON.stringify(projection)).not.toContain(SECRET);
  });

  it('binds a single sidecar read to manifest bytes, inventory and exact population', () => {
    const dir = scratch();
    const artifact = writePreflightSidecar(dir, [safe()], inventorySha256, [entry.id]);
    const spy = vi.spyOn(fs, 'readFileSync');
    expect(readPreflightSidecar(dir, [artifact], inventorySha256, [entry.id])).toEqual([safe()]);
    expect(spy.mock.calls.filter(([file]) => String(file).replaceAll('\\', '/').endsWith(PREFLIGHT_SIDECAR_PATH)).length).toBe(1);
    expect(() => readPreflightSidecar(dir, [], inventorySha256, [entry.id])).toThrow(/rerun corpus maintenance/);
    expect(() => readPreflightSidecar(dir, [artifact], 'a'.repeat(64), [entry.id])).toThrow(/rerun corpus maintenance/);
    expect(() => writePreflightSidecar(dir, [safe(), safe()], inventorySha256, [entry.id])).toThrow();
    fs.appendFileSync(path.join(dir, PREFLIGHT_SIDECAR_PATH), ' ');
    expect(() => readPreflightSidecar(dir, [artifact], inventorySha256, [entry.id])).toThrow();
  });
});

describe('actual V4 public format integration', () => {
  it('writes and reopens 18 NDJSON relations, SQLite v3/FKs and twelve formula-safe Excel sheets with sealed identity', () => {
    const dir = path.join(scratch(), 'release');
    const dataEntry = { ...entry, readiness: deriveCapturedBody(receipt(), inventorySha256, publicSourceId(entry), bytes, true).replacement!.readiness };
    const metadata = { ...releaseForEntries([dataEntry]), schemaVersion: PUBLIC_DATA_MODEL_SCHEMA_VERSION_V4 };
    const pending = buildPublicProjectionV4([dataEntry], { release: metadata, preflight: [safe()], inventorySha256 });
    const releaseId = sealedDatasetId(metadata, projectionSections(pending));
    const projection = buildPublicProjectionV4([dataEntry], { release: { ...metadata, releaseId }, preflight: [safe()], inventorySha256 });
    const bundle = writePublicRelease(projection, dir);
    expect(Object.keys(bundle.relations)).toHaveLength(18);
    expect(bundle.schemaVersion).toBe(PUBLIC_DATA_MODEL_SCHEMA_VERSION_V4);
    expect(Object.keys(bundle.formats.excel.sheetRowCounts)).toHaveLength(12);
    const ndjson = JSON.parse(fs.readFileSync(path.join(dir, 'ndjson/public-release.json'), 'utf8'));
    expect(verifyNdjsonRelease(projection, path.join(dir, 'ndjson'), ndjson)).toBe(true);
    expect(verifySqliteRelease(projection, path.join(dir, 'release.sqlite'))).toBe(true);
    expect(verifyExcelRelease(projection, path.join(dir, 'release.xlsx'))).toBe(true);
    expect(bundle.formats.sqlite.logicalSha256).toBe(bundle.formats.excel.logicalSha256);
    expect(verifyDatasetReleaseId(dir).matches).toBe(true);
    expect(readPublicWorkflowRows(projection).workflows).toBe(projection.workflows);
    const db = new DatabaseSync(path.join(dir, 'release.sqlite'));
    try {
      expect(db.prepare('PRAGMA user_version').get()?.user_version).toBe(3);
      expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
      expect(db.prepare('SELECT count(*) AS n FROM preflight_coverage').get()?.n).toBe(1);
    } finally { db.close(); }
    const zip = readZip(fs.readFileSync(path.join(dir, 'release.xlsx')));
    const workbook = zip.get('xl/workbook.xml')!.toString();
    expect(workbook).toContain('name="Preflight Coverage" sheetId="11"');
    expect(workbook).toContain('name="Preflight Evidence" sheetId="12"');
    for (const [name, content] of zip) if (name.endsWith('.xml')) {
      expect(content.toString()).not.toContain(SECRET);
      expect(content.toString()).not.toMatch(/<f[ >]/);
    }
    for (const relation of Object.keys(bundle.relations)) {
      expect(fs.readFileSync(path.join(dir, 'ndjson', relation + '.ndjson'), 'utf8')).not.toContain(SECRET);
    }
  });
});
