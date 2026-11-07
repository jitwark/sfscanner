import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { compareCanonicalStrings } from '@hub/contracts/stable-order';

export type AcquisitionFailure = { key: string; error: string };

export type AcquisitionManifest = {
  runId: string;
  requestedSourceKeys: string[];
  acquiredSourceKeys: string[];
  failures: AcquisitionFailure[];
  counts: { requested: number; acquired: number; failed: number };
  complete: boolean;
  acceptPartial: boolean;
};

const SOURCE_KEY = /^[a-z0-9][a-z0-9_-]*$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function normalizeSourceKeys(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${label} source keys must be an array`);
  const seen = new Set<string>();
  for (const key of value) {
    if (typeof key !== 'string' || !SOURCE_KEY.test(key)) {
      throw new Error(`${label} source key is malformed: ${String(key)}`);
    }
    if (seen.has(key)) throw new Error(`duplicate ${label} source key: ${key}`);
    seen.add(key);
  }
  return [...value].sort(compareCanonicalStrings);
}

function normalizeFailures(value: unknown): AcquisitionFailure[] {
  if (!Array.isArray(value)) throw new Error('failures must be an array');
  const seen = new Set<string>();
  const failures: AcquisitionFailure[] = [];
  for (const failure of value) {
    if (!isRecord(failure) || typeof failure.key !== 'string' || !SOURCE_KEY.test(failure.key) || typeof failure.error !== 'string') {
      throw new Error('failure source key or error is malformed');
    }
    if (seen.has(failure.key)) throw new Error(`duplicate failure key: ${failure.key}`);
    seen.add(failure.key);
    failures.push({ key: failure.key, error: failure.error });
  }
  return failures.sort((a, b) => compareCanonicalStrings(a.key, b.key));
}

function sameSet(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((key, index) => key === right[index]);
}

function assertRequestedMembers(
  requested: string[],
  acquired: string[],
  failures: AcquisitionFailure[],
): void {
  const requestedSet = new Set(requested);
  const unknownAcquired = acquired.find((key) => !requestedSet.has(key));
  if (unknownAcquired) throw new Error(`acquired source key is not requested: ${unknownAcquired}`);
  const unknownFailure = failures.find((failure) => !requestedSet.has(failure.key));
  if (unknownFailure) throw new Error(`failure source key is not requested: ${unknownFailure.key}`);
}

function validateManifest(value: unknown, activeSourceKeys?: string[]): AcquisitionManifest {
  if (!isRecord(value) || typeof value.runId !== 'string' || value.runId.trim().length === 0) {
    throw new Error('run identity is malformed');
  }
  const requested = normalizeSourceKeys(value.requestedSourceKeys, 'requested');
  const acquired = normalizeSourceKeys(value.acquiredSourceKeys, 'acquired');
  const failures = normalizeFailures(value.failures);
  assertRequestedMembers(requested, acquired, failures);
  if (activeSourceKeys !== undefined) {
    const active = normalizeSourceKeys(activeSourceKeys, 'active');
    if (!sameSet(requested, active)) {
      throw new Error('requested source keys must match the active source registry');
    }
  }
  if (!isRecord(value.counts) ||
      value.counts.requested !== requested.length ||
      value.counts.acquired !== acquired.length ||
      value.counts.failed !== failures.length ||
      !Number.isInteger(value.counts.requested) ||
      !Number.isInteger(value.counts.acquired) ||
      !Number.isInteger(value.counts.failed) ||
      typeof value.complete !== 'boolean' ||
      typeof value.acceptPartial !== 'boolean') {
    throw new Error('manifest counts or flags are malformed');
  }
  const complete = sameSet(requested, acquired) && failures.length === 0;
  if (value.complete !== complete) throw new Error('manifest completeness is invalid');
  return {
    runId: value.runId,
    requestedSourceKeys: requested,
    acquiredSourceKeys: acquired,
    failures,
    counts: { requested: requested.length, acquired: acquired.length, failed: failures.length },
    complete,
    acceptPartial: value.acceptPartial,
  };
}

export function makeAcquisitionManifest(
  runId: string,
  requestedSourceKeys: string[],
  acquiredSourceKeys: string[],
  failures: AcquisitionFailure[],
  acceptPartial = false,
  activeSourceKeys?: string[],
): AcquisitionManifest {
  const requested = normalizeSourceKeys(requestedSourceKeys, 'requested');
  const acquired = normalizeSourceKeys(acquiredSourceKeys, 'acquired');
  const failed = normalizeFailures(failures);
  assertRequestedMembers(requested, acquired, failed);
  if (activeSourceKeys !== undefined) {
    const active = normalizeSourceKeys(activeSourceKeys, 'active');
    if (!sameSet(requested, active)) {
      throw new Error('requested source keys must match the active source registry');
    }
  }
  return {
    runId,
    requestedSourceKeys: requested,
    acquiredSourceKeys: acquired,
    failures: failed,
    counts: { requested: requested.length, acquired: acquired.length, failed: failed.length },
    complete: sameSet(requested, acquired) && failed.length === 0,
    acceptPartial,
  };
}

export async function writeAcquisitionManifest(
  workDir: string,
  manifest: AcquisitionManifest,
): Promise<string> {
  await mkdir(workDir, { recursive: true });
  const filePath = path.join(workDir, 'acquisition-manifest.json');
  await writeFile(filePath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  return filePath;
}

export async function readAcquisitionManifest(
  filePath: string,
  activeSourceKeys?: string[],
): Promise<AcquisitionManifest> {
  const content = await readFile(filePath, 'utf8');
  try {
    return validateManifest(JSON.parse(content), activeSourceKeys);
  } catch {
    throw new Error(`Invalid acquisition manifest: ${filePath}`);
  }
}

export function assertAcquisitionComplete(manifest: AcquisitionManifest, acceptPartial: boolean): void {
  if (!manifest.complete && !acceptPartial) {
    throw new Error(
      `Cannot package incomplete acquisition (${manifest.counts.acquired}/${manifest.counts.requested} sources acquired); ` +
        'rerun acquisition or pass --accept-partial',
    );
  }
}
