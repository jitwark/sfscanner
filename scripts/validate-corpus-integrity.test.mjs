import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '..');
const VALIDATOR = join(ROOT, 'scripts/validate-corpus-integrity.mjs');

function fixture({ entries = [{ id: 'entry-1' }], sidecars = false, extraFiles = [] } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'corpus-integrity-'));
  const catalogue = Buffer.from(JSON.stringify(entries));
  writeFileSync(join(dataDir, 'catalogue-0.json'), catalogue);
  for (const file of extraFiles) writeFileSync(join(dataDir, file), '{}');
  if (sidecars) {
    mkdirSync(join(dataDir, 'scanner'));
    for (const name of ['advisories-v2.json', 'advisory-quarantine-v1.json', 'calibration-v2-manifest.json']) {
      writeFileSync(join(dataDir, 'scanner', name), JSON.stringify({ credentials: { token: 'scanner-sidecar-fixture' } }));
    }
  }
  writeFileSync(join(dataDir, 'manifest.json'), JSON.stringify({
    totalEntries: entries.length,
    artifacts: [{
      path: 'catalogue-0.json',
      byteSize: catalogue.length,
      sha256: createHash('sha256').update(catalogue).digest('hex'),
    }],
    catalogueShards: Object.fromEntries(entries.map((entry) => [entry.id, 0])),
  }));
  return dataDir;
}

function runValidator(dataDir) {
  return spawnSync(process.execPath, [VALIDATOR, dataDir], { encoding: 'utf8' });
}

describe('corpus integrity scanner sidecars', () => {
  it('accepts explicit scanner sidecars outside the corpus manifest', () => {
    const dataDir = fixture({ sidecars: true });
    try {
      const result = runValidator(dataDir);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain('Corpus integrity passed: 1 entries, 1 manifest ID mappings.');
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('continues rejecting unowned non-scanner data files', () => {
    const dataDir = fixture({ extraFiles: ['unexpected.json'] });
    try {
      const result = runValidator(dataDir);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('manifest does not own artifact: unexpected.json');
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('continues rejecting privacy violations in corpus data', () => {
    const dataDir = fixture({ entries: [{ id: 'entry-1', credentials: { token: 'not-allowed' } }] });
    try {
      const result = runValidator(dataDir);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('privacy audit credential object at catalogue-0.json[0].credentials');
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
