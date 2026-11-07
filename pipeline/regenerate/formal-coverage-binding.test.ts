import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_SCANNER_LIMITS_V2 } from '@hub/contracts';
import { formalCoverageBinding, formalMeasurementContext, formalProducerSourceIdentity } from './formal-coverage-binding.js';
import type { CorpusV2InputInventory } from '../../scripts/lib/corpus-v2-input-inventory.js';

const roots: string[] = [];
const hash = (value: Uint8Array | string) => crypto.createHash('sha256').update(value).digest('hex');
const scratch = () => { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'q02-binding-')); roots.push(root); return root; };
function write(root: string, file: string, text: string) {
  const target = path.join(root, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, text);
}
afterEach(() => { while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true }); });

function sourceFixture() {
  const root = scratch();
  for (const directory of ['contracts', 'packages/scanner-core/src', 'pipeline', 'scripts/lib', 'schemas']) {
    fs.mkdirSync(path.join(root, directory), { recursive: true });
  }
  for (const file of ['package.json', 'tsconfig.json', 'packages/scanner-core/package.json',
    'packages/scanner-core/tsconfig.json', 'packages/scanner-cli/package.json', 'pipeline/tsconfig.json', 'scripts/tsconfig.json']) write(root, file, '{}');
  write(root, 'packages/scanner-core/src/workflow-v2/semantic-fields.ts', 'export const version = 1;');
  return root;
}

describe('conservative formal producer identity', () => {
  it('binds transitive production sources and automatically includes newly introduced helpers', () => {
    const root = sourceFixture();
    const first = formalProducerSourceIdentity(root);
    write(root, 'packages/scanner-core/src/workflow-v2/semantic-fields.ts', 'export const version = 2;');
    const changed = formalProducerSourceIdentity(root);
    expect(changed.digest).not.toBe(first.digest);
    expect(changed.files).toContainEqual(expect.objectContaining({ file: 'packages/scanner-core/src/workflow-v2/semantic-fields.ts' }));
    write(root, 'packages/scanner-core/src/workflow-v2/new-normalizer-helper.ts', 'export const added = true;');
    expect(formalProducerSourceIdentity(root).digest).not.toBe(changed.digest);
  });

  it('excludes raw fixtures, tests and caches and does not use mtimes or enumeration order', () => {
    const root = sourceFixture();
    const first = formalProducerSourceIdentity(root);
    for (const file of ['pipeline/.work/private-body.json', 'pipeline/fixtures/body.json',
      'packages/scanner-core/src/__fixtures__/raw.json', 'pipeline/new.test.ts',
      'pipeline/tests/support.ts', 'scripts/lib/.cache/entry.json']) write(root, file, 'changed raw or test bytes');
    const source = path.join(root, 'packages/scanner-core/src/workflow-v2/semantic-fields.ts');
    fs.utimesSync(source, new Date(), new Date());
    expect(formalProducerSourceIdentity(root)).toEqual(first);
  });

  it('binds source manifests/configuration and refuses production directory indirection', () => {
    const root = sourceFixture();
    const first = formalProducerSourceIdentity(root);
    write(root, 'packages/scanner-core/package.json', '{"changed":true}');
    expect(formalProducerSourceIdentity(root).digest).not.toBe(first.digest);
    fs.symlinkSync(scratch(), path.join(root, 'pipeline/linked-production'), 'junction');
    expect(() => formalProducerSourceIdentity(root)).toThrow(/linked production source/u);
  });
});

it('binds effective limits, exact lockfile bytes, runtime and loaded tool identities deterministically', () => {
  const context = formalMeasurementContext();
  expect(context.limits).toEqual(DEFAULT_SCANNER_LIMITS_V2);
  expect(context.lockfileSha256).toBe(hash(fs.readFileSync(new URL('../../package-lock.json', import.meta.url))));
  expect(context.runtime).toMatchObject({ node: process.version, platform: process.platform, arch: process.arch });
  expect(Object.keys(context.tools)).toEqual(['@humanwhocodes/momoa', '@noble/hashes', 'tsx', 'typescript']);
  expect(formalMeasurementContext()).toEqual(context);
});

it('retains identical named-input bindings and records both source and measurement context digests', () => {
  const root = scratch();
  const inventory: CorpusV2InputInventory = { schemaVersion: 'corpus-v2-input-inventory-v1', inventorySha256: 'a'.repeat(64),
    rows: [], counts: { AVAILABLE: 0, MISSING: 0, SOURCE_UNAVAILABLE: 0, UNPARSEABLE: 0, REJECTED: 0 } };
  write(root, 'inventory.json', JSON.stringify(inventory)); write(root, 'map.json', '{}');
  const first = formalCoverageBinding(inventory, path.join(root, 'inventory.json'), path.join(root, 'map.json'));
  const second = formalCoverageBinding(inventory, path.join(root, 'inventory.json'), path.join(root, 'map.json'));
  expect(second).toEqual(first);
  expect(first.measurementContextSha256).toBe(hash(JSON.stringify(first.executionContext)));
  expect(first.producerSourceSha256).toBe(formalProducerSourceIdentity().digest);
  expect(first.bodyMapSha256).toBe(hash('{}'));
});
