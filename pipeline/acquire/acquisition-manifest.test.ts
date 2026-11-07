import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  assertAcquisitionComplete,
  makeAcquisitionManifest,
  readAcquisitionManifest,
  type AcquisitionManifest,
  writeAcquisitionManifest,
} from './acquisition-manifest.js';
import { enforceAcquisitionGate } from '../run-enrichment.js';
import { parseSourcesJson } from '../sources.schema.js';

const gateWorkDir = path.join(process.cwd(), 'pipeline', '.work', 'test-acquisition-packaging-gate');
const activeSourceKeys = parseSourcesJson(
  readFileSync(path.join(process.cwd(), 'pipeline', 'sources.json'), 'utf8'),
).filter((source) => source.status === 'active').map((source) => source.key);

afterEach(async () => {
  await fs.rm(gateWorkDir, { recursive: true, force: true });
});

const complete = makeAcquisitionManifest('run', activeSourceKeys, activeSourceKeys, []);
const partial = makeAcquisitionManifest(
  'run',
  activeSourceKeys,
  activeSourceKeys.slice(0, 1),
  activeSourceKeys.slice(1).map((key) => ({ key, error: 'offline' })),
);

describe('acquisition packaging gate', () => {
  it('accepts a complete acquisition without an override', () => {
    expect(() => assertAcquisitionComplete(complete, false)).not.toThrow();
    expect(complete.complete).toBe(true);
  });
  it('accepts and preserves a complete manifest for packaging', async () => {
    await writeAcquisitionManifest(gateWorkDir, complete);
    const accepted = await enforceAcquisitionGate(gateWorkDir, false);
    expect(accepted.complete).toBe(true);
    expect(accepted.counts).toEqual({ requested: activeSourceKeys.length, acquired: activeSourceKeys.length, failed: 0 });
  });

  it('rejects a partial acquisition unless the operator accepts it', () => {
    expect(() => assertAcquisitionComplete(partial, false)).toThrow(/--accept-partial/);
    expect(() => assertAcquisitionComplete(partial, true)).not.toThrow();
    expect(partial.complete).toBe(false);
  });
  it('rejects incomplete packaging and persists an explicit partial override', async () => {
    await writeAcquisitionManifest(gateWorkDir, partial);
    const manifestPath = path.join(gateWorkDir, 'acquisition-manifest.json');

    await expect(enforceAcquisitionGate(gateWorkDir, false)).rejects.toThrow(/--accept-partial/);
    expect(JSON.parse(await fs.readFile(manifestPath, 'utf8')).acceptPartial).toBe(false);

    const accepted = await enforceAcquisitionGate(gateWorkDir, true);
    expect(accepted.complete).toBe(false);
    expect(accepted.failures).toEqual(partial.failures);
    expect(JSON.parse(await fs.readFile(manifestPath, 'utf8')).acceptPartial).toBe(true);
  });

  it('records the operator override in the manifest shape', () => {
    const accepted: AcquisitionManifest = { ...partial, acceptPartial: true };
    expect(accepted.acceptPartial).toBe(true);
  });

  it('rejects duplicate requested source keys', () => {
    expect(() => makeAcquisitionManifest('run', ['one', 'one'], ['one'], [])).toThrow(/duplicate.*requested/i);
  });

  it('rejects duplicate acquired source keys', () => {
    expect(() => makeAcquisitionManifest('run', ['one'], ['one', 'one'], [])).toThrow(/duplicate.*acquired/i);
  });

  it('rejects duplicate failure keys', () => {
    expect(() => makeAcquisitionManifest('run', ['one'], [], [
      { key: 'one', error: 'offline' },
      { key: 'one', error: 'timed out' },
    ])).toThrow(/duplicate.*failure/i);
  });

  it('rejects acquired keys that are not requested', () => {
    expect(() => makeAcquisitionManifest('run', ['one'], ['two'], [])).toThrow(/acquired.*requested/i);
  });

  it('rejects failure keys that are not requested', () => {
    expect(() => makeAcquisitionManifest('run', ['one'], [], [{ key: 'two', error: 'offline' }]))
      .toThrow(/failure.*requested/i);
  });

  it.each(['', 'bad key', 'BadKey'])('rejects malformed source key %j', (key) => {
    expect(() => makeAcquisitionManifest('run', [key], [], [])).toThrow(/source key.*malformed/i);
  });

  it('requires requested keys to match the supplied active source registry', () => {
    expect(() => makeAcquisitionManifest('run', ['one'], ['one'], [], false, ['one', 'two']))
      .toThrow(/active source/i);
    expect(() => makeAcquisitionManifest('run', ['one', 'two', 'three'], ['one', 'two'], [], false, ['one', 'two']))
      .toThrow(/active source/i);
  });

  it('rejects malformed persisted manifests', async () => {
    await fs.mkdir(gateWorkDir, { recursive: true });
    const manifestPath = path.join(gateWorkDir, 'acquisition-manifest.json');
    await fs.writeFile(manifestPath, JSON.stringify({
      runId: 'run',
      requestedSourceKeys: ['one'],
      acquiredSourceKeys: ['one'],
      failures: [{ key: '', error: 'offline' }],
      counts: { requested: 1, acquired: 1, failed: 1 },
      complete: true,
      acceptPartial: false,
    }));

    await expect(readAcquisitionManifest(manifestPath)).rejects.toThrow(/Invalid acquisition manifest/);
  });

  it('rejects persisted manifests when the active source registry has drifted', async () => {
    const driftedKeys = activeSourceKeys.slice(0, -1);
    await writeAcquisitionManifest(
      gateWorkDir,
      makeAcquisitionManifest('run', driftedKeys, driftedKeys, []),
    );

    await expect(enforceAcquisitionGate(gateWorkDir, false)).rejects.toThrow(/Invalid acquisition manifest/);
  });

  it('keeps an explicitly accepted partial manifest incomplete', () => {
    const accepted = makeAcquisitionManifest(
      'run',
      ['one', 'two'],
      ['one'],
      [{ key: 'two', error: 'offline' }],
      true,
      ['one', 'two'],
    );

    expect(accepted.complete).toBe(false);
    expect(() => assertAcquisitionComplete(accepted, true)).not.toThrow();
  });
});
