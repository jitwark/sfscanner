import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_SCANNER_LIMITS_V2 } from '@hub/contracts';
import { parseArgumentsV2 } from './arguments';
import { runCliV2 } from './cli-runner';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function workspace(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'sf-flags-'));
  roots.push(dir);
  await writeFile(path.join(dir, 'wf.json'), '{"nodes":[{"id":"a","name":"A","type":"n8n-nodes-base.manualTrigger","typeVersion":1,"parameters":{}},{"id":"b","name":"B","type":"n8n-nodes-base.noOp","typeVersion":1,"parameters":{}}],"connections":{}}');
  await writeFile(path.join(dir, 'limits.json'), JSON.stringify({ ...DEFAULT_SCANNER_LIMITS_V2, maxNodes: 1 }));
  await writeFile(path.join(dir, 'target.json'), JSON.stringify({ schemaVersion: 'scanner-target-v3', edition: 'ENTERPRISE', deployment: 'SELF_HOSTED', role: 'ADMIN', taskRunner: 'NATIVE', communityPackages: [], configuration: [] }));
  return dir;
}

function usage(message: string): { exitCode: 2; stdout: ''; stderr: string } {
  return { exitCode: 2, stdout: '', stderr: `${message}\n` };
}

async function scan(dir: string, extra: readonly string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const parsed = parseArgumentsV2(['--schema', 'v2', 'scan', 'wf.json', '--format', 'json', ...extra]);
  if (!parsed.ok) return usage(parsed.error.message);
  if (parsed.command.kind !== 'scan') return usage('expected a scan command');
  return runCliV2(parsed.command, { cwd: dir });
}

describe('v2 target, limits, and approved domains', () => {
  it('loads a local limits document and enforces its maxNodes', async () => {
    const dir = await workspace();
    const result = await scan(dir, ['--limits', 'limits.json']);
    expect(result.exitCode).toBe(3);
    expect(result.stdout).toContain('WORKFLOW_TOO_COMPLEX');
  });

  it('keeps --limits builtin working', async () => {
    const dir = await workspace();
    expect((await scan(dir, ['--limits', 'builtin'])).exitCode).toBe(0);
  });

  it('applies target-file facts and CLI overrides to the result', async () => {
    const dir = await workspace();
    const result = await scan(dir, ['--target', 'target.json', '--edition', 'COMMUNITY', '--n8n-version', '1.100.0']);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      results: [{ result: { target: { schemaVersion: 'scanner-target-v3', edition: 'COMMUNITY', deployment: 'SELF_HOSTED', role: 'ADMIN', n8nVersion: '1.100.0' } } }],
      invocation: { sources: { target: 'CLI' } },
    });
  });

  it('makes UNAPPROVED_DOMAIN reachable through the engine', async () => {
    const dir = await workspace();
    await writeFile(path.join(dir, 'wf.json'), JSON.stringify({ nodes: [{ id: 'h', name: 'H', type: 'n8n-nodes-base.httpRequest', typeVersion: 1, parameters: { url: 'https://unlisted.example.invalid/x' } }], connections: {} }));
    const result = await scan(dir, ['--approved-domain', 'approved.example']);
    expect(result.stdout).toContain('UNAPPROVED_DOMAIN');
  });

  it('rejects invalid JSON, non-object targets, unknown limits keys, and oversized documents', async () => {
    const dir = await workspace();
    await writeFile(path.join(dir, 'not-json.json'), '{"edition":');
    await writeFile(path.join(dir, 'array.json'), '[]');
    await writeFile(path.join(dir, 'extra.json'), JSON.stringify({ ...DEFAULT_SCANNER_LIMITS_V2, surprise: 1 }));
    await writeFile(path.join(dir, 'oversize.json'), Buffer.alloc(1_048_577, 0x20));
    expect((await scan(dir, ['--target', 'not-json.json'])).exitCode).toBe(2);
    expect((await scan(dir, ['--limits', 'not-json.json'])).exitCode).toBe(2);
    expect((await scan(dir, ['--target', 'array.json'])).exitCode).toBe(2);
    expect((await scan(dir, ['--limits', 'extra.json'])).exitCode).toBe(2);
    expect((await scan(dir, ['--limits', 'oversize.json'])).exitCode).toBe(2);
  });

  it('rejects an invalid approved domain at the parser boundary', () => {
    const parsed = parseArgumentsV2(['--schema', 'v2', 'scan', 'wf.json', '--approved-domain', 'https://bad.example']);
    expect(parsed).toEqual({ ok: false, error: { code: 'INVALID_VALUE', message: 'Approved domain is invalid.', argument: '--approved-domain' } });
  });

  it('rejects an invalid target document as usage', async () => {
    const dir = await workspace();
    await writeFile(path.join(dir, 'bad.json'), '{"edition":"NOPE"}');
    expect((await scan(dir, ['--target', 'bad.json'])).exitCode).toBe(2);
    await writeFile(path.join(dir, 'unknown-key.json'), JSON.stringify({
      edition: 'COMMUNITY', deployment: 'SELF_HOSTED', role: 'ADMIN', taskRunner: 'NATIVE',
      schemaVersion: 'scanner-target-v3', communityPackages: [], configuration: [{ key: 'NOT_IN_CATALOGUE', state: 'UNKNOWN' }],
    }));
    expect((await scan(dir, ['--target', 'unknown-key.json'])).exitCode).toBe(2);
  });

  it('splits validated community-package name and version for both forms', async () => {
    const dir = await workspace();
    expect((await scan(dir, ['--community-package', 'example-package'])).exitCode).toBe(0);
    const versioned = await scan(dir, ['--community-package', 'example-package@1.2.3']);
    expect(versioned.exitCode).toBe(0);
    expect(JSON.parse(versioned.stdout)).toMatchObject({
      results: [{ result: { target: { communityPackages: [{ name: 'example-package', version: '1.2.3' }] } } }],
    });
    const scoped = await scan(dir, ['--community-package', '@scope/example@1.2.3']);
    expect(scoped.exitCode).toBe(0);
    expect(JSON.parse(scoped.stdout)).toMatchObject({
      results: [{ result: { target: { communityPackages: [{ name: '@scope/example', version: '1.2.3' }] } } }],
    });
    expect((await scan(dir, ['--community-package', 'example-package@not-a-version'])).exitCode).toBe(2);
  });
});
