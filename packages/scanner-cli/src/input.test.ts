import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LIMITS } from '@hub/contracts';
import { runCli } from './cli';
import { MAX_V1_INPUT_BYTES, readWorkflowInput } from './input';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function workspace(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sf-v1-'));
  roots.push(root);
  return root;
}

describe('v1 input ceiling', () => {
  it('uses the shared workflow-byte authority', () => {
    expect(MAX_V1_INPUT_BYTES).toBe(LIMITS.maxWorkflowBytes);
  });

  it('refuses stdin past the ceiling without retaining it all', async () => {
    let yielded = 0;
    const chunk = new Uint8Array(256_000).fill(0x20);
    async function* stream() { for (let index = 0; index < 8; index += 1) { yielded += 1; yield chunk; } }
    await expect(readWorkflowInput('-', stream())).rejects.toThrow('OVERSIZED');
    expect(yielded).toBeLessThanOrEqual(7);
  });

  it('refuses an oversized file before decoding it', async () => {
    const dir = await workspace();
    const file = path.join(dir, 'big.json');
    await writeFile(file, Buffer.alloc(MAX_V1_INPUT_BYTES + 1, 0x20));
    await expect(readWorkflowInput(file)).rejects.toThrow('OVERSIZED');
  });

  it('maps an oversized file to WORKFLOW_TOO_LARGE at the CLI boundary', async () => {
    const dir = await workspace();
    const file = path.join(dir, 'big.json');
    await writeFile(file, Buffer.alloc(MAX_V1_INPUT_BYTES + 1, 0x20));
    const result = await runCli([file]);
    expect(result.exitCode).toBe(3);
    const document = JSON.parse(result.stdout) as { error: { code: string; message: string } };
    expect(document.error).toEqual({ code: 'WORKFLOW_TOO_LARGE', message: 'Workflow exceeds maximum byte limit.' });
  });

  it('maps invalid UTF-8 to a structured input error without echoing bytes', async () => {
    const dir = await workspace();
    const file = path.join(dir, 'invalid.json');
    await writeFile(file, Buffer.from([0xff, 0xfe, 0x00]));
    const result = await runCli([file]);
    expect(result.exitCode).toBe(3);
    const document = JSON.parse(result.stdout) as { ok: boolean; error: { code: string; message: string } };
    expect(document.ok).toBe(false);
    expect(document.error).toEqual({ code: 'INPUT_READ_FAILED', message: 'Unable to read workflow input.' });
    expect(result.stdout).not.toContain('\uFFFD');
    expect(result.stdout).not.toContain('\u00ff');
  });

  it('maps invalid UTF-8 on stdin to the same structured error', async () => {
    async function* stream() { yield new Uint8Array([0xff, 0xfe]); }
    const result = await runCli(['-'], { stdin: stream() });
    expect(result.exitCode).toBe(3);
    const document = JSON.parse(result.stdout) as { ok: boolean; error: { code: string; message: string } };
    expect(document.error).toEqual({ code: 'INPUT_READ_FAILED', message: 'Unable to read workflow input.' });
  });
});
