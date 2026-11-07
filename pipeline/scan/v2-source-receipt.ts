import { lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { canonicalizeJson } from '@hub/scanner-core/canonical-json';
import { compareCanonicalStrings } from '@hub/contracts/stable-order';
import { DEFAULT_SCANNER_LIMITS_V2 } from '@hub/contracts';
import {
  ADMITTED_ENGINE_VERSION,
  ADMITTED_PROFILE_ID,
  ADMITTED_PROFILE_VERSION,
  BUILTIN_RULESET_AUTHORITY_V2,
  BUILTIN_SEMANTICS_AUTHORITY_V2,
  ENGINE_BUILD_DIGEST_V2,
} from '../../packages/scanner-core/src/v2/admitted-registry.js';
import { collectV2ScannerSourceFiles, sha256, type V2SourceFileRecord } from './v2-source-files.js';
import { ENTRY_SECURITY_PROJECTION_VERSION } from './v2-corpus-adapter.js';

export const V2_SOURCE_RECEIPT_SCHEMA_VERSION = 'v2-source-receipt' as const;

export type { V2SourceFileRecord } from './v2-source-files.js';

export type V2SourceReceipt = Readonly<{
  schemaVersion: typeof V2_SOURCE_RECEIPT_SCHEMA_VERSION;
  sourceBuildDigest: string;
  sourceFiles: readonly V2SourceFileRecord[];
  lockfileDigest: string;
  runtimeVersion: string;
  engineVersion: string;
  effectiveConfigDigest: string;
  inputInventoryDigest?: string;
  runId?: string;
  createdAt?: string;
}>;

const DIGEST_REGEX = /^[0-9a-f]{64}$/;

export function computeEffectiveConfigDigest(): string {
  return sha256(
    canonicalizeJson({
      engineBuildDigest: ENGINE_BUILD_DIGEST_V2,
      engineVersion: ADMITTED_ENGINE_VERSION,
      limitsDigest: sha256(canonicalizeJson(DEFAULT_SCANNER_LIMITS_V2)),
      profileId: ADMITTED_PROFILE_ID,
      profileVersion: ADMITTED_PROFILE_VERSION,
      projectionVersion: ENTRY_SECURITY_PROJECTION_VERSION,
      rulesetDigest: BUILTIN_RULESET_AUTHORITY_V2.digest,
      semanticsDigest: BUILTIN_SEMANTICS_AUTHORITY_V2.digest,
    }),
  );
}

export function computeSourceBuildDigest(params: {
  sourceFiles: readonly V2SourceFileRecord[];
  lockfileDigest: string;
  runtimeVersion: string;
  effectiveConfigDigest: string;
}): string {
  const sortedFiles = [...params.sourceFiles].sort((a, b) => compareCanonicalStrings(a.path, b.path));
  return sha256(
    canonicalizeJson({
      effectiveConfigDigest: params.effectiveConfigDigest,
      lockfileDigest: params.lockfileDigest,
      runtimeVersion: params.runtimeVersion,
      sourceFiles: sortedFiles,
    }),
  );
}

export function validateV2SourceReceipt(value: unknown): V2SourceReceipt {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Source receipt must be a plain object.');
  }
  const obj = value as Record<string, unknown>;
  if (obj.schemaVersion !== V2_SOURCE_RECEIPT_SCHEMA_VERSION) {
    throw new TypeError(`Invalid receipt schemaVersion: ${String(obj.schemaVersion)}`);
  }
  if (typeof obj.sourceBuildDigest !== 'string' || !DIGEST_REGEX.test(obj.sourceBuildDigest)) {
    throw new TypeError('Invalid receipt sourceBuildDigest.');
  }
  if (typeof obj.lockfileDigest !== 'string' || !DIGEST_REGEX.test(obj.lockfileDigest)) {
    throw new TypeError('Invalid receipt lockfileDigest.');
  }
  if (typeof obj.effectiveConfigDigest !== 'string' || !DIGEST_REGEX.test(obj.effectiveConfigDigest)) {
    throw new TypeError('Invalid receipt effectiveConfigDigest.');
  }
  if (typeof obj.runtimeVersion !== 'string' || obj.runtimeVersion.length === 0) {
    throw new TypeError('Invalid receipt runtimeVersion.');
  }
  if (!Array.isArray(obj.sourceFiles)) {
    throw new TypeError('Invalid receipt sourceFiles.');
  }
  const normalizedFiles: V2SourceFileRecord[] = [];
  for (const item of obj.sourceFiles) {
    if (
      !item ||
      typeof item !== 'object' ||
      typeof item.path !== 'string' ||
      typeof item.sha256 !== 'string' ||
      !DIGEST_REGEX.test(item.sha256)
    ) {
      throw new TypeError('Invalid receipt sourceFile entry.');
    }
    normalizedFiles.push(Object.freeze({ path: item.path, sha256: item.sha256 }));
  }
  normalizedFiles.sort((a, b) => compareCanonicalStrings(a.path, b.path));

  const expectedDigest = computeSourceBuildDigest({
    sourceFiles: normalizedFiles,
    lockfileDigest: obj.lockfileDigest,
    runtimeVersion: obj.runtimeVersion,
    effectiveConfigDigest: obj.effectiveConfigDigest,
  });
  if (expectedDigest !== obj.sourceBuildDigest) {
    throw new TypeError('Receipt sourceBuildDigest does not match computed source files digest.');
  }

  return Object.freeze({
    schemaVersion: V2_SOURCE_RECEIPT_SCHEMA_VERSION,
    sourceBuildDigest: obj.sourceBuildDigest,
    sourceFiles: Object.freeze(normalizedFiles),
    lockfileDigest: obj.lockfileDigest,
    runtimeVersion: obj.runtimeVersion,
    engineVersion: typeof obj.engineVersion === 'string' ? obj.engineVersion : ADMITTED_ENGINE_VERSION,
    effectiveConfigDigest: obj.effectiveConfigDigest,
    ...(typeof obj.inputInventoryDigest === 'string' ? { inputInventoryDigest: obj.inputInventoryDigest } : {}),
    ...(typeof obj.runId === 'string' ? { runId: obj.runId } : {}),
    ...(typeof obj.createdAt === 'string' ? { createdAt: obj.createdAt } : {}),
  });
}

export type BuildSourceReceiptOptions = Readonly<{
  rootDir?: string;
  candidateInputs?: readonly Readonly<{ entryId: string; inputSha256: string }>[];
  runId?: string;
  createdAt?: string;
}>;

export async function buildScannerSourceReceipt(
  options: BuildSourceReceiptOptions = {},
): Promise<V2SourceReceipt> {
  const root = options.rootDir ?? join(import.meta.dirname, '../..');
  const sourceFiles = await collectV2ScannerSourceFiles(root);
  let lockfileContent: Buffer;
  try {
    const lockfilePath = join(root, 'package-lock.json');
    const lockfileInfo = await lstat(lockfilePath);
    if (lockfileInfo.isSymbolicLink() || !lockfileInfo.isFile()) throw new TypeError();
    lockfileContent = await readFile(lockfilePath);
  } catch {
    throw new TypeError('Source receipt cannot be built: package-lock.json is unreadable or missing.');
  }

  const lockfileDigest = sha256(lockfileContent);
  const runtimeVersion = process.version;
  const effectiveConfigDigest = computeEffectiveConfigDigest();
  const sourceBuildDigest = computeSourceBuildDigest({
    sourceFiles,
    lockfileDigest,
    runtimeVersion,
    effectiveConfigDigest,
  });

  let inputInventoryDigest: string | undefined;
  if (options.candidateInputs && options.candidateInputs.length > 0) {
    const sortedInputs = [...options.candidateInputs].sort((a, b) => compareCanonicalStrings(a.entryId, b.entryId));
    inputInventoryDigest = sha256(canonicalizeJson(sortedInputs));
  }

  return Object.freeze({
    schemaVersion: V2_SOURCE_RECEIPT_SCHEMA_VERSION,
    sourceBuildDigest,
    sourceFiles: Object.freeze(sourceFiles),
    lockfileDigest,
    runtimeVersion,
    engineVersion: ADMITTED_ENGINE_VERSION,
    effectiveConfigDigest,
    ...(inputInventoryDigest ? { inputInventoryDigest } : {}),
    ...(options.runId ? { runId: options.runId } : {}),
    createdAt: options.createdAt ?? new Date().toISOString(),
  });
}
