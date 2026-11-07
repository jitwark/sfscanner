import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';
import { posix, win32 } from 'node:path';
import type { FixPlanV1, Sha256V1 } from '@hub/scanner-core/remediation/fix-suggestion';
import { defaultInputReadHost } from './input-read';
import { admitFixTarget, type FixPathAdmissionHostV1, type FixPathDetailV1 } from './fix-path-admission';

export type { FixPathAdmissionHostV1, FixPathStatV1 } from './fix-path-admission';

/**
 * Transaction orchestration for an already-planned fix. This module owns no patch algorithm and no
 * path policy: it admits the target, proves the bytes still match the plan, stages the planned
 * result, and delegates the commit to a conditional-replace host.
 *
 * A conditional replacement is not something Node offers. Rehashing the target and renaming a
 * staged file over it leaves a window in which a concurrent writer loses its bytes, so the default
 * host has no implementation at all: without an injected host this function reports
 * `HOST_UNSUPPORTED/NO_CONDITIONAL_REPLACE` before staging, backing up or opening the source.
 */

export type ConditionalReplaceOutcomeV1 = 'REPLACED' | 'SOURCE_CONFLICT' | 'UNSUPPORTED' | 'RECOVERY_REQUIRED';

export type ConditionalReplaceRequestV1 = Readonly<{
  targetIdentity: string;
  targetPath: string;
  sourceSha256: Sha256V1;
  stagedPath: string;
  backupPath: string;
  resultSha256: Sha256V1;
}>;

export type ConditionalReplaceHostV1 = Readonly<{
  /** Replaces `targetPath` only while it still has this identity and source digest. */
  replaceIfUnchanged: (request: ConditionalReplaceRequestV1) => Promise<ConditionalReplaceOutcomeV1>;
}>;

export type FixApplyHostV1 = Readonly<{
  conditionalReplace?: ConditionalReplaceHostV1;
  admission?: FixPathAdmissionHostV1;
  readFile?: (path: string) => Promise<Uint8Array>;
  writeStaged?: (path: string, bytes: Uint8Array) => Promise<void>;
}>;

export type FixApplyRequestV1 = Readonly<{
  plan: Extract<FixPlanV1, { status: 'READY' }>;
  root: string;
  target: string;
  /** Serialized patched document; its SHA-256 must equal `plan.resultSha256`. */
  result: Uint8Array;
  signal?: AbortSignal;
}>;

export type FixApplyStatusV1 =
  | 'WRITTEN' | 'REFUSED' | 'CANCELLED' | 'HOST_UNSUPPORTED'
  | 'SOURCE_CONFLICT' | 'WRITE_FAILED_UNCHANGED' | 'RECOVERY_REQUIRED';

export type FixApplyRefusalV1 =
  | 'INVALID_PLAN' | 'RESULT_MISMATCH' | 'READ_FAILED' | 'UNSAFE_PATH' | 'SOURCE_CHANGED'
  | 'STAGE_FAILED' | 'NO_CONDITIONAL_REPLACE' | 'RESTORE_FAILED' | 'CONCURRENT_CHANGE' | 'CANCELLED';

export type FixApplyResultV1 =
  | Readonly<{ status: 'WRITTEN'; sourceSha256: Sha256V1; resultSha256: Sha256V1; backupSha256: Sha256V1 }>
  | Readonly<{ status: Exclude<FixApplyStatusV1, 'WRITTEN'>; reason: FixApplyRefusalV1; detail?: FixPathDetailV1 }>;

const SHA256 = /^[0-9a-f]{64}$/u;
const STAGE = 'stage';
const BACKUP = 'bak';

export async function applyFixV1(request: FixApplyRequestV1, host: FixApplyHostV1 = {}): Promise<FixApplyResultV1> {
  const conditionalReplace = host?.conditionalReplace;
  if (conditionalReplace === undefined) return refusal('HOST_UNSUPPORTED', 'NO_CONDITIONAL_REPLACE');
  if (request === null || typeof request !== 'object') return refusal('REFUSED', 'INVALID_PLAN');
  if (request.signal?.aborted) return refusal('CANCELLED', 'CANCELLED');
  if (!isReadyPlan(request.plan) || !(request.result instanceof Uint8Array)) {
    return refusal('REFUSED', 'INVALID_PLAN');
  }
  if (typeof request.root !== 'string' || typeof request.target !== 'string') {
    return refusal('REFUSED', 'INVALID_PLAN');
  }
  if (sha256Hex(request.result) !== request.plan.resultSha256) return refusal('REFUSED', 'RESULT_MISMATCH');

  const admission = await admitFixTarget({
    root: request.root,
    target: request.target,
    backup: artifactPath(request.target, request.plan.sourceSha256, BACKUP),
    host: host.admission,
  });
  if (!admission.ok) return refusal('REFUSED', 'UNSAFE_PATH', admission.detail);
  if (request.signal?.aborted) return refusal('CANCELLED', 'CANCELLED');

  const readFile = host.readFile ?? defaultInputReadHost.readFile;
  let source: Uint8Array;
  try {
    source = await readFile(admission.targetRealPath);
  } catch {
    return refusal('REFUSED', 'READ_FAILED');
  }
  if (sha256Hex(source) !== request.plan.sourceSha256) return refusal('REFUSED', 'SOURCE_CHANGED');
  if (request.signal?.aborted) return refusal('CANCELLED', 'CANCELLED');

  // The admitted directory has no symlink or reparse segment, so the resolved and lexical parents
  // are the same directory; artifacts stay beside the target for an atomic commit.
  const stagedPath = artifactPath(admission.targetRealPath, request.plan.resultSha256, STAGE);
  const backupPath = artifactPath(admission.targetRealPath, request.plan.sourceSha256, BACKUP);
  try {
    await (host.writeStaged ?? writeStagedFile)(stagedPath, new Uint8Array(request.result));
  } catch {
    return refusal('WRITE_FAILED_UNCHANGED', 'STAGE_FAILED');
  }
  if (request.signal?.aborted) return refusal('CANCELLED', 'CANCELLED');

  let outcome: unknown;
  try {
    outcome = await conditionalReplace.replaceIfUnchanged({
      targetIdentity: admission.targetIdentity,
      targetPath: admission.targetRealPath,
      sourceSha256: request.plan.sourceSha256,
      stagedPath,
      backupPath,
      resultSha256: request.plan.resultSha256,
    });
  } catch {
    // The commit outcome is unknown; never retry blindly and never report success.
    return refusal('RECOVERY_REQUIRED', 'CONCURRENT_CHANGE');
  }
  if (outcome === 'REPLACED') {
    return Object.freeze({
      status: 'WRITTEN' as const,
      sourceSha256: request.plan.sourceSha256,
      resultSha256: request.plan.resultSha256,
      backupSha256: request.plan.sourceSha256,
    });
  }
  if (outcome === 'SOURCE_CONFLICT') return refusal('SOURCE_CONFLICT', 'SOURCE_CHANGED');
  if (outcome === 'UNSUPPORTED') return refusal('HOST_UNSUPPORTED', 'NO_CONDITIONAL_REPLACE');
  return refusal('RECOVERY_REQUIRED', outcome === 'RECOVERY_REQUIRED' ? 'RESTORE_FAILED' : 'CONCURRENT_CHANGE');
}

function refusal(
  status: Exclude<FixApplyStatusV1, 'WRITTEN'>,
  reason: FixApplyRefusalV1,
  detail?: FixPathDetailV1,
): FixApplyResultV1 {
  return Object.freeze({ status, reason, ...(detail === undefined ? {} : { detail }) });
}

function isReadyPlan(value: unknown): value is Extract<FixPlanV1, { status: 'READY' }> {
  if (typeof value !== 'object' || value === null) return false;
  const plan = value as Record<string, unknown>;
  return plan.status === 'READY'
    && typeof plan.suggestionId === 'string' && plan.suggestionId.length > 0
    && typeof plan.sourceSha256 === 'string' && SHA256.test(plan.sourceSha256)
    && typeof plan.resultSha256 === 'string' && SHA256.test(plan.resultSha256)
    && Array.isArray(plan.patch);
}

function artifactPath(target: string, digest: string, suffix: string): string {
  const api = /^[a-z]:\//iu.test(target) ? win32 : posix;
  const directory = api.dirname(target);
  const name = `.${api.basename(target)}.${digest.slice(0, 16)}.${suffix}`;
  return `${directory}${directory.endsWith('/') ? '' : '/'}${name}`;
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

async function writeStagedFile(path: string, bytes: Uint8Array): Promise<void> {
  const handle = await open(path, 'wx');
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}
