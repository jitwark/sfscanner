import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { createRetainedOfflineGuard, checkRetainedOfflineGuard } from './retained-offline-guard.mjs';

const owned = [];
const temporary = () => { const root = mkdtempSync(path.join(os.tmpdir(), 'retained guard ')); owned.push(root); return root; };
const run = (command, args, options = {}) => spawnSync(command, args, { encoding: 'utf8', timeout: 5000, ...options });
afterEach(() => { for (const root of owned.splice(0)) rmSync(root, { recursive: true, force: true }); });

it('blocks named ESM, socket, DNS promise, HTTP2 and global fetch routes', () => {
  const root = temporary(); const guarded = createRetainedOfflineGuard(root, run);
  expect(checkRetainedOfflineGuard(root, guarded)).toEqual({ id: 'offline-guard-positive-routes', status: 'pass' });
});

it('rejects a module-initialization network call through a named builtin import', () => {
  const root = temporary(); const guarded = createRetainedOfflineGuard(root, run);
  const exportFile = path.join(root, 'archive-export.mjs');
  writeFileSync(exportFile, "import { connect } from 'node:net'; connect();");
  expect(() => guarded(process.execPath, [exportFile], { cwd: root })).toThrow('attempted network access');
});

it('detects an absent guard without initiating any network positive-control traffic', () => {
  const root = temporary();
  expect(checkRetainedOfflineGuard(root, run)).toEqual({ id: 'offline-guard-positive-routes', status: 'fail' });
});
