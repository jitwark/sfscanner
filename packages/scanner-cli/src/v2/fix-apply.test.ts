import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { FixPlanV1 } from '@hub/scanner-core/remediation/fix-suggestion';
import {
  applyFixV1,
  type ConditionalReplaceOutcomeV1,
  type ConditionalReplaceRequestV1,
  type FixApplyHostV1,
  type FixApplyRequestV1,
  type FixPathAdmissionHostV1,
  type FixPathStatV1,
} from './fix-apply';

// Synthetic facts only: no file, directory or temp artifact is created by this suite.
const ROOT = 'D:/fix-apply';
const TARGET = 'D:/fix-apply/workflow.json';
const SOURCE = new TextEncoder().encode('{\n  "name": "demo"\n}\n');
const RESULT = new TextEncoder().encode('{\n  "name": "demo",\n  "safe": true\n}\n');
const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const SOURCE_SHA = sha256(SOURCE);
const RESULT_SHA = sha256(RESULT);
const BACKUP = `${ROOT}/.workflow.json.${SOURCE_SHA.slice(0, 16)}.bak`;

type Entry = Readonly<{ kind: 'file' | 'directory' | 'symlink' | 'other'; nlink?: number; dev?: number; ino?: number }>;
type HarnessOptions = Readonly<{
  outcome?: string;
  noConditionalHost?: boolean;
  source?: Uint8Array;
  readError?: Error;
  stageError?: Error;
  entries?: Readonly<Record<string, Entry>>;
  abortDuringAdmission?: AbortController;
  abortDuringStage?: AbortController;
}>;

const DIRECTORY: Entry = Object.freeze({ kind: 'directory' });
const FILE: Entry = Object.freeze({ kind: 'file', nlink: 1, dev: 7, ino: 42 });

function statOf(entry: Entry): FixPathStatV1 {
  return {
    isFile: () => entry.kind === 'file',
    isDirectory: () => entry.kind === 'directory',
    isSymbolicLink: () => entry.kind === 'symlink',
    ...(entry.nlink === undefined ? {} : { nlink: entry.nlink }),
    ...(entry.dev === undefined ? {} : { dev: entry.dev }),
    ...(entry.ino === undefined ? {} : { ino: entry.ino }),
  };
}

function codedError(code: string): Error {
  return Object.assign(new Error(`synthetic ${code}`), { code });
}

type Harness = Readonly<{
  calls: string[];
  host: FixApplyHostV1;
  commit: () => ConditionalReplaceRequestV1 | undefined;
  staged: () => Readonly<{ path: string; bytes: Uint8Array }> | undefined;
}>;

function makeHarness(options: HarnessOptions = {}): Harness {
  const calls: string[] = [];
  const entries = new Map(Object.entries({
    'd:/fix-apply': DIRECTORY,
    'd:/fix-apply/workflow.json': FILE,
    ...(options.entries ?? {}),
  }).map(([key, entry]) => [key.toLowerCase(), entry]));
  let commit: ConditionalReplaceRequestV1 | undefined;
  let staged: Readonly<{ path: string; bytes: Uint8Array }> | undefined;
  let observed = 0;
  const admission: FixPathAdmissionHostV1 = {
    lstat: async (path) => {
      calls.push(`lstat:${path}`);
      observed += 1;
      if (observed === 1) options.abortDuringAdmission?.abort();
      const entry = entries.get(path.toLowerCase());
      if (entry === undefined) throw codedError('ENOENT');
      return statOf(entry);
    },
    realpath: async (path) => {
      calls.push(`realpath:${path}`);
      return path;
    },
  };
  const conditionalReplace = options.noConditionalHost ? undefined : {
    replaceIfUnchanged: async (request: ConditionalReplaceRequestV1): Promise<ConditionalReplaceOutcomeV1> => {
      calls.push('commit');
      commit = request;
      return (options.outcome ?? 'REPLACED') as ConditionalReplaceOutcomeV1;
    },
  };
  const host: FixApplyHostV1 = {
    ...(conditionalReplace === undefined ? {} : { conditionalReplace }),
    admission,
    readFile: async (path) => {
      calls.push(`read:${path}`);
      if (options.readError) throw options.readError;
      return options.source ?? SOURCE;
    },
    writeStaged: async (path, bytes) => {
      calls.push(`stage:${path}`);
      if (options.stageError) throw options.stageError;
      staged = { path, bytes };
      options.abortDuringStage?.abort();
    },
  };
  return { calls, host, commit: () => commit, staged: () => staged };
}

const READY: Extract<FixPlanV1, { status: 'READY' }> = Object.freeze({
  status: 'READY',
  suggestionId: 'fix-1',
  sourceSha256: SOURCE_SHA,
  resultSha256: RESULT_SHA,
  patch: Object.freeze([Object.freeze({ op: 'add' as const, path: '/safe', value: true })]),
});

function request(overrides: Partial<FixApplyRequestV1> = {}): FixApplyRequestV1 {
  return { plan: READY, root: ROOT, target: TARGET, result: RESULT, ...overrides };
}

describe('fix apply transaction', () => {
  it('returns HOST_UNSUPPORTED/NO_CONDITIONAL_REPLACE without any host call', async () => {
    const harness = makeHarness({ noConditionalHost: true });
    expect(await applyFixV1(request(), harness.host))
      .toEqual({ status: 'HOST_UNSUPPORTED', reason: 'NO_CONDITIONAL_REPLACE' });
    expect(harness.calls).toEqual([]);
  });

  it('refuses a plan that is not READY before touching the filesystem', async () => {
    const harness = makeHarness();
    const plan = { status: 'REFUSED', reason: 'STALE_SOURCE' } as unknown as FixApplyRequestV1['plan'];
    expect(await applyFixV1(request({ plan }), harness.host)).toEqual({ status: 'REFUSED', reason: 'INVALID_PLAN' });
    expect(harness.calls).toEqual([]);
  });

  it('refuses malformed plan digests and payloads', async () => {
    const harness = makeHarness();
    const badDigest = { ...READY, sourceSha256: 'not-a-digest' } as unknown as FixApplyRequestV1['plan'];
    expect(await applyFixV1(request({ plan: badDigest }), harness.host)).toEqual({ status: 'REFUSED', reason: 'INVALID_PLAN' });
    const badPatch = { ...READY, patch: 'nope' } as unknown as FixApplyRequestV1['plan'];
    expect(await applyFixV1(request({ plan: badPatch }), harness.host)).toEqual({ status: 'REFUSED', reason: 'INVALID_PLAN' });
    const badPayload = { ...request(), result: 'text' } as unknown as FixApplyRequestV1;
    expect(await applyFixV1(badPayload, harness.host)).toEqual({ status: 'REFUSED', reason: 'INVALID_PLAN' });
    expect(harness.calls).toEqual([]);
  });

  it('refuses a payload whose digest is not the planned result', async () => {
    const harness = makeHarness();
    expect(await applyFixV1(request({ result: SOURCE }), harness.host))
      .toEqual({ status: 'REFUSED', reason: 'RESULT_MISMATCH' });
    expect(harness.calls).toEqual([]);
  });

  it('cancels before admission when the signal is already aborted', async () => {
    const harness = makeHarness();
    const controller = new AbortController();
    controller.abort();
    expect(await applyFixV1(request({ signal: controller.signal }), harness.host))
      .toEqual({ status: 'CANCELLED', reason: 'CANCELLED' });
    expect(harness.calls).toEqual([]);
  });

  it('refuses an unsafe path without reading or writing the source', async () => {
    const harness = makeHarness({ entries: { 'd:/fix-apply/workflow.json': { kind: 'symlink' } } });
    expect(await applyFixV1(request(), harness.host))
      .toEqual({ status: 'REFUSED', reason: 'UNSAFE_PATH', detail: 'SYMLINK' });
    expect(harness.calls.some((call) => call.startsWith('read:'))).toBe(false);
    expect(harness.calls.some((call) => call.startsWith('stage:'))).toBe(false);
    expect(harness.commit()).toBeUndefined();
  });

  it('refuses when the source no longer matches the plan', async () => {
    const harness = makeHarness({ source: new TextEncoder().encode('{"name":"edited"}\n') });
    expect(await applyFixV1(request(), harness.host)).toEqual({ status: 'REFUSED', reason: 'SOURCE_CHANGED' });
    expect(harness.calls.some((call) => call.startsWith('stage:'))).toBe(false);
    expect(harness.commit()).toBeUndefined();
  });

  it('reports an unreadable source without staging', async () => {
    const harness = makeHarness({ readError: codedError('EACCES') });
    expect(await applyFixV1(request(), harness.host)).toEqual({ status: 'REFUSED', reason: 'READ_FAILED' });
    expect(harness.calls.some((call) => call.startsWith('stage:'))).toBe(false);
    expect(harness.commit()).toBeUndefined();
  });

  it('stages the result beside the target and commits with the admitted identity', async () => {
    const harness = makeHarness();
    expect(await applyFixV1(request(), harness.host)).toEqual({
      status: 'WRITTEN',
      sourceSha256: SOURCE_SHA,
      resultSha256: RESULT_SHA,
      backupSha256: SOURCE_SHA,
    });
    const staged = harness.staged();
    expect(staged?.path).toBe(`${ROOT}/.workflow.json.${RESULT_SHA.slice(0, 16)}.stage`);
    expect([...(staged?.bytes ?? [])]).toEqual([...RESULT]);
    expect(harness.commit()).toEqual({
      targetIdentity: 'inode:7:42',
      targetPath: TARGET,
      sourceSha256: SOURCE_SHA,
      stagedPath: staged?.path,
      backupPath: BACKUP,
      resultSha256: RESULT_SHA,
    });
    expect(harness.calls.at(-1)).toBe('commit');
  });

  it('proves the backup name is absent during admission', async () => {
    const harness = makeHarness();
    await applyFixV1(request(), harness.host);
    expect(harness.calls).toContain(`lstat:${BACKUP}`);
  });

  it('refuses a pre-existing backup and never stages', async () => {
    const harness = makeHarness({ entries: { [BACKUP.toLowerCase()]: { kind: 'file', nlink: 1, dev: 7, ino: 99 } } });
    expect(await applyFixV1(request(), harness.host))
      .toEqual({ status: 'REFUSED', reason: 'UNSAFE_PATH', detail: 'COLLISION' });
    expect(harness.calls.some((call) => call.startsWith('stage:'))).toBe(false);
    expect(harness.commit()).toBeUndefined();
  });

  it('cancels after staging without committing', async () => {
    const controller = new AbortController();
    const harness = makeHarness({ abortDuringStage: controller });
    expect(await applyFixV1(request({ signal: controller.signal }), harness.host))
      .toEqual({ status: 'CANCELLED', reason: 'CANCELLED' });
    expect(harness.staged()).toBeDefined();
    expect(harness.commit()).toBeUndefined();
  });

  it('cancels after admission but before reading the source', async () => {
    const controller = new AbortController();
    const harness = makeHarness({ abortDuringAdmission: controller });
    expect(await applyFixV1(request({ signal: controller.signal }), harness.host))
      .toEqual({ status: 'CANCELLED', reason: 'CANCELLED' });
    expect(harness.calls.some((call) => call.startsWith('read:'))).toBe(false);
  });

  it('reports a staging failure as unchanged', async () => {
    const harness = makeHarness({ stageError: codedError('EEXIST') });
    expect(await applyFixV1(request(), harness.host))
      .toEqual({ status: 'WRITE_FAILED_UNCHANGED', reason: 'STAGE_FAILED' });
    expect(harness.commit()).toBeUndefined();
  });

  it('maps every conditional-replace outcome', async () => {
    const cases: readonly [string, Readonly<{ status: string; reason: string }>][] = [
      ['SOURCE_CONFLICT', { status: 'SOURCE_CONFLICT', reason: 'SOURCE_CHANGED' }],
      ['UNSUPPORTED', { status: 'HOST_UNSUPPORTED', reason: 'NO_CONDITIONAL_REPLACE' }],
      ['RECOVERY_REQUIRED', { status: 'RECOVERY_REQUIRED', reason: 'RESTORE_FAILED' }],
      ['SOMETHING_NEW', { status: 'RECOVERY_REQUIRED', reason: 'CONCURRENT_CHANGE' }],
    ];
    for (const [outcome, expected] of cases) {
      expect(await applyFixV1(request(), makeHarness({ outcome }).host), outcome).toEqual(expected);
    }
  });

  it('treats a thrown commit as an uncertain outcome that must be recovered', async () => {
    const harness = makeHarness();
    const failing: FixApplyHostV1 = {
      ...harness.host,
      conditionalReplace: { replaceIfUnchanged: async () => { throw new Error('handle lost'); } },
    };
    expect(await applyFixV1(request(), failing))
      .toEqual({ status: 'RECOVERY_REQUIRED', reason: 'CONCURRENT_CHANGE' });
  });

  it('never reports a written transaction from a refusal', async () => {
    const harness = makeHarness({ outcome: 'SOURCE_CONFLICT' });
    const result = await applyFixV1(request(), harness.host);
    expect(result.status).not.toBe('WRITTEN');
    expect('backupSha256' in result).toBe(false);
  });
});
