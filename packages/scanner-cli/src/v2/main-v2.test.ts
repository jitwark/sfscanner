import { afterAll, describe, expect, it, vi } from 'vitest';
import type * as NodeFs from 'node:fs';

const execution = vi.hoisted(() => {
  const { writeFileSync } = process.getBuiltinModule('node:fs') as typeof NodeFs;
  const mainFixture = `.task3-main-v2-${process.pid}.json`;
  writeFileSync(mainFixture, '{"nodes":[],"connections":{}}\n');
  const previousArgv = process.argv;
  const previousExitCode = process.exitCode;
  const stdout: string[] = [];
  const stderr: string[] = [];
  process.argv = [
    'node',
    'n8n-scan',
    '--schema',
    'v2',
    'scan',
    mainFixture,
    '--format',
    'json',
  ];
  const stdoutWrite = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => {
    stdout.push(typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk));
    return true;
  }) as typeof process.stdout.write);
  const stderrWrite = vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: string | Uint8Array) => {
    stderr.push(typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk));
    return true;
  }) as typeof process.stderr.write);
  return { previousArgv, previousExitCode, stdout, stderr, stdoutWrite, stderrWrite, mainFixture };
});

import '../main';

afterAll(() => {
  const { rmSync } = process.getBuiltinModule('node:fs') as typeof NodeFs;
  rmSync(execution.mainFixture, { force: true });
  execution.stdoutWrite.mockRestore();
  execution.stderrWrite.mockRestore();
  process.argv = execution.previousArgv;
  process.exitCode = execution.previousExitCode;
});


describe('main v2 dispatch', () => {
  it('runs a parsed v2 scan through the executable path', () => {
    expect(process.exitCode).toBe(0);
    expect(execution.stderr.join('')).toBe('');
    expect(execution.stdout.join('')).not.toContain('The v2 scan runner is not available.');
    expect(JSON.parse(execution.stdout.join(''))).toMatchObject({
      schemaVersion: 'n8n-scan-v2',
      exitReason: 'UNDER_THRESHOLD',
    });
  });
});
