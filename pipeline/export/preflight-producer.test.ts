import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeEntryWithChart } from '../__fixtures__/make-entry.js';
import { runV2Cli } from '../regenerate/v2-cli.js';
import { PREFLIGHT_SIDECAR_PATH, readPreflightSidecar } from './preflight-sidecar.js';
import type { Manifest } from '../package/manifest.js';
import { stageScannerSidecars } from '../package/scanner-sidecars.js';

const hash = (value: Uint8Array | string) => crypto.createHash('sha256').update(value).digest('hex');
const dirs: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'v4-producer-')); dirs.push(root);
  const data = path.join(root, 'data'); const bodies = path.join(root, 'bodies');
  fs.mkdirSync(path.join(data, 'charts'), { recursive: true }); fs.mkdirSync(path.join(data, 'scanner')); fs.mkdirSync(bodies);
  const item = makeEntryWithChart({ id: 'producer-one', descriptionSource: 'upstream', source: { kind: 'n8n_official', templateId: 1 }, rights: { status: 'link_only' } });
  item.entry.readiness = { analysis: 'unscanned', credentials: [], replaceableValues: [], writeActions: [],
    aiModel: { present: false, model: null }, extraPackages: [], versionNotes: [], pinnedData: { present: false, nodeCount: 0 }, isSubWorkflow: false };
  fs.writeFileSync(path.join(data, 'catalogue-0.json'), JSON.stringify([item.entry]));
  fs.writeFileSync(path.join(data, 'charts/chart-0.jsonl'), JSON.stringify(item.chart) + '\n');
  for (const file of ['advisories-v2.json', 'advisory-quarantine-v1.json', 'calibration-v2-manifest.json']) fs.writeFileSync(path.join(data, 'scanner', file), '{}');
  const bodyFile = path.join(bodies, 'official__1_one.json');
  const bytes = Buffer.from(JSON.stringify({ nodes: ['First', 'Second', 'Third'].map((name, index) => ({
    name, type: index === 0 ? 'n8n-nodes-base.manualTrigger' : 'n8n-nodes-base.set', typeVersion: 1, parameters: {},
  })), connections: { First: { main: [[{ node: 'Second', type: 'main', index: 0 }]] }, Second: { main: [[{ node: 'Third', type: 'main', index: 0 }]] } } }));
  fs.writeFileSync(bodyFile, bytes);
  const rows = [{ entryId: item.entry.id, identityKind: 'OFFICIAL_TEMPLATE', status: 'AVAILABLE', bodySha256: hash(bytes), byteLength: bytes.length, sourceCommit: null, sourcePath: null, reasonCode: null }];
  const inventoryBase = { schemaVersion: 'corpus-v2-input-inventory-v1', counts: { AVAILABLE: 1, MISSING: 0, SOURCE_UNAVAILABLE: 0, UNPARSEABLE: 0, REJECTED: 0 }, rows };
  const inventorySha256 = hash(JSON.stringify(inventoryBase));
  fs.writeFileSync(path.join(root, 'inventory.json'), JSON.stringify({ ...inventoryBase, inventorySha256 }));
  fs.writeFileSync(path.join(root, 'map.json'), JSON.stringify({ schemaVersion: 'official-body-map-v1',
    rows: [{ templateId: 1, entryId: item.entry.id, file: path.basename(bodyFile), sourceDir: bodies, provenance: 'curated_official_folder' }],
    withoutBody: [], refusedBodies: [], orphanBodies: [], counts: {
      catalogueOfficial: 1, bodyFiles: 1, ignoredBodyFiles: 0, matched: 1, withoutBody: 0, refused: 0,
      shadowedBodyFiles: 0, orphanBodyFiles: 0, duplicateCatalogueTemplateIds: 0, duplicateBodyTemplateIds: 0,
      entriesWithoutTemplateId: 0, malformedBodyFileNames: 0,
    } }));
  return { root, bodies, bodyFile, inventorySha256, id: item.entry.id };
}

describe('actual scan and records replay body producer', () => {
  it('reads each body once in scan and replay, derives readiness in hand, and owns the safe sidecar in both manifests', () => {
    const f = fixture(); const read = vi.spyOn(fs, 'readFileSync');
    const stdout: string[] = []; const stderr: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((value) => { stdout.push(String(value)); return true; });
    vi.spyOn(process.stderr, 'write').mockImplementation((value) => { stderr.push(String(value)); return true; });
    const common = ['--data', 'data', '--inventory', 'inventory.json', '--map', 'map.json', '--bodies', f.bodies, '--generated-at', '2026-11-03T00:00:00.000Z'];
    const count = () => read.mock.calls.filter(([file]) => String(file) === f.bodyFile).length;
    expect(runV2Cli([...common, '--out', 'scan-records', '--apply-data', 'candidate-a'], f.root), stderr.join('')).toBe(0);
    expect(count()).toBe(1);
    const first = fs.readFileSync(path.join(f.root, 'candidate-a', PREFLIGHT_SIDECAR_PATH), 'utf8');
    expect(runV2Cli([...common, '--out', 'replay-records', '--records', 'scan-records/v2-scan-evidence.ndjson', '--apply-data', 'candidate-b'], f.root), stderr.join('')).toBe(0);
    expect(count()).toBe(2);
    expect(fs.readFileSync(path.join(f.root, 'candidate-b', PREFLIGHT_SIDECAR_PATH), 'utf8')).toBe(first);
    for (const name of ['candidate-a', 'candidate-b']) {
      const dir = path.join(f.root, name);
      const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')) as Manifest;
      const safe = readPreflightSidecar(dir, manifest.artifacts, f.inventorySha256, [f.id]);
      expect(safe[0]?.coverage.sourceBodySha256).toBe(hash(fs.readFileSync(f.bodyFile)));
      expect(safe[0]?.coverage.coverageState).toBe('COMPLETE');
      expect(manifest.artifacts.find((row) => row.path === PREFLIGHT_SIDECAR_PATH)?.entryCount).toBe(1);
    }
    const exported = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/export-public-dataset.ts',
      '--data', path.join(f.root, 'candidate-a'), '--out', path.join(f.root, 'dataset')], {
      cwd: path.resolve(import.meta.dirname, '../..'), encoding: 'utf8', timeout: 30_000,
    });
    expect(exported.status, exported.stderr + exported.stdout).toBe(0);
    const bundle = JSON.parse(fs.readFileSync(path.join(f.root, 'dataset/public-release.json'), 'utf8'));
    expect(bundle.schemaVersion).toBe('public-data-model-v4');
    expect(Object.keys(bundle.relations)).toHaveLength(18);
    const copied = path.join(f.root, 'repackage');
    stageScannerSidecars(path.join(f.root, 'candidate-a'), copied);
    expect(fs.readFileSync(path.join(copied, PREFLIGHT_SIDECAR_PATH), 'utf8')).toBe(first);
    fs.appendFileSync(path.join(f.root, 'candidate-a', PREFLIGHT_SIDECAR_PATH), ' ');
    expect(() => stageScannerSidecars(path.join(f.root, 'candidate-a'), path.join(f.root, 'bad-copy'))).toThrow(/checksum mismatch/);
  });
});
