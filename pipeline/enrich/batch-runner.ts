import type { Entry } from '@hub/contracts';
import { describeEntries, type DescribeOptions, type DescribeResult } from './describe.js';
import { loadCheckpoint, saveCheckpoint } from './checkpoint.js';
import { verifyEnrichmentBatch } from './batch-verifier.js';
import {
  isReusableCompletedBatch, loadBatchLedger, recordBatchCompletion, recordBatchFailure,
  recordBatchRejection, recordBatchStart,
} from './batch-ledger.js';
import {
  batchIdentity, checkpointHash, fromCheckpoint, identitiesFor, readCheckpoint, safeError, wait,
  writeInputManifest,
} from './batch-runner-support.js';

export type DescribeBatchFn = (entries: Entry[], options: DescribeOptions) => Promise<DescribeResult>;
export type RunDescriptionBatchesOptions = {
  runId: string;
  entries: Entry[];
  workflowsById: ReadonlyMap<string, unknown>;
  checkpointPath: string;
  ledgerPath: string;
  batchSize: number;
  describeOptions: DescribeOptions;
  describeFn?: DescribeBatchFn;
  maxBatchAttempts?: number;
  retryDelayMs?: number;
  /** Verify completed ledger/checkpoint batches without invoking Gemini. */
  verifyOnly?: boolean;
  inputManifestPath?: string;
  preflightOnly?: boolean;
};
export type RunDescriptionBatchesResult = {
  entries: Entry[];
  completedBatches: number;
  rejectedBatches: number;
  rejectedIds: string[];
  ledgerPath: string;
};

export class EnrichmentBatchError extends Error {
  constructor(public readonly batchIndex: number, message: string) {
    super(`Enrichment batch ${batchIndex} failed: ${message}`);
    this.name = 'EnrichmentBatchError';
  }
}

function partition(entries: Entry[], size: number): Entry[][] {
  const batches: Entry[][] = [];
  for (let index = 0; index < entries.length; index += size) batches.push(entries.slice(index, index + size));
  return batches;
}

function validationMessage(errors: Array<{ id?: string; code: string }>): string {
  return errors.slice(0, 5).map((item) => `${item.code}${item.id ? `:${item.id}` : ''}`).join(', ');
}

function clearRejectedCheckpointEntries(checkpointPath: string, ids: readonly string[]): void {
  const checkpoint = loadCheckpoint(checkpointPath);
  for (const id of ids) delete checkpoint[id];
  saveCheckpoint(checkpointPath, checkpoint);
}

const STRUCTURAL_ERRORS = new Set(['count_mismatch', 'duplicate_id', 'order_mismatch', 'missing_result', 'identity_mismatch']);

function rejectedIdsForBatch(
  batch: Entry[],
  errors: Array<{ id?: string; code: string }>,
): Set<string> {
  const ids = new Set(batch.map((entry) => entry.id));
  const identified = new Set(errors.map((item) => item.id).filter((id): id is string => Boolean(id && ids.has(id))));
  if (errors.some((item) => !item.id || STRUCTURAL_ERRORS.has(item.code)) || identified.size === 0) return ids;
  return identified;
}

export async function runDescriptionBatches(options: RunDescriptionBatchesOptions): Promise<RunDescriptionBatchesResult> {
  if (!Number.isInteger(options.batchSize) || options.batchSize < 1 || options.batchSize > 25) {
    throw new Error('enrichment batch size must be an integer from 1 through 25');
  }
  const identities = identitiesFor(options);
  const batches = partition(options.entries, options.batchSize);
  const manifestPath = options.inputManifestPath
    ? writeInputManifest(options.inputManifestPath, { runId: options.runId, entries: options.entries, identities, batchSize: options.batchSize })
    : undefined;
  if (options.preflightOnly) return { entries: [], completedBatches: 0, rejectedBatches: 0, rejectedIds: [], ledgerPath: options.ledgerPath };
  const describeFn = options.describeFn ?? describeEntries;
  const verified: Entry[] = [];
  let completedBatches = 0;
  let rejectedBatches = 0;
  const rejectedIds = new Set<string>();

  for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
    const batch = batches[batchIndex]!;
    const ids = batch.map((entry) => entry.id);
    const identityHash = batchIdentity(options.runId, batch, identities);
    const prior = loadBatchLedger(options.ledgerPath)[String(batchIndex)];
    const savedHash = checkpointHash(options.checkpointPath, ids);
    if (isReusableCompletedBatch(prior, identityHash, savedHash)) {
      const checkpoint = readCheckpoint(options.checkpointPath);
      const restored = batch.flatMap((entry) => {
        const saved = checkpoint[entry.id];
        const identity = identities.get(entry.id);
        return saved && identity ? [fromCheckpoint(entry, saved, identity)] : [];
      });
      const check = verifyEnrichmentBatch({ entries: batch, results: restored, identities, workflowsById: options.workflowsById });
      if (check.ok) {
        recordBatchCompletion(options.ledgerPath, { batchIndex, identityHash, checkpointHash: savedHash, acceptedCount: check.accepted.length });
        verified.push(...restored);
        completedBatches++;
        continue;
      }
      if (options.verifyOnly) throw new EnrichmentBatchError(batchIndex, `completed batch failed verification: ${validationMessage(check.errors)}`);
    }
    if (options.verifyOnly) throw new EnrichmentBatchError(batchIndex, 'batch is not a reusable completed Gemini batch');

    const maxAttempts = Math.max(1, options.maxBatchAttempts ?? 2);
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      recordBatchStart(options.ledgerPath, { batchIndex, identityHash, selectedCount: batch.length, selectedIds: ids, inputManifestPath: manifestPath });
      try {
        const result = await describeFn(batch, {
          ...options.describeOptions, workflowsById: options.workflowsById,
          checkpointPath: options.checkpointPath, requireGemini: true,
        });
        if (result.rejections.length > 0) {
          const batchIds = new Set(ids);
          const invalidIds = new Set(result.rejections.map((item) => item.id).filter((id) => batchIds.has(id)));
          if (invalidIds.size === 0 || invalidIds.size !== result.rejections.length) ids.forEach((id) => invalidIds.add(id));
          const acceptedEntries = result.entries.filter((entry) => !invalidIds.has(entry.id));
          const acceptedBatch = batch.filter((entry) => !invalidIds.has(entry.id));
          clearRejectedCheckpointEntries(options.checkpointPath, [...invalidIds]);
          const reasons = result.rejections.slice(0, 8).map((item) => `${item.id}: ${safeError(item.reason)}`);
          const reason = reasons.join('; ').slice(0, 240);
          recordBatchRejection(options.ledgerPath, {
            batchIndex, identityHash, errorCode: 'gemini_rejected',
            errorMessage: reason || 'Gemini returned rejected output', validationErrors: reasons,
            acceptedCount: acceptedBatch.length, rejectedCount: invalidIds.size, rejectedIds: [...invalidIds],
          });
          rejectedBatches++;
          invalidIds.forEach((id) => rejectedIds.add(id));
          if (acceptedBatch.length > 0) {
            const acceptedCheck = verifyEnrichmentBatch({ entries: acceptedBatch, results: acceptedEntries, identities, workflowsById: options.workflowsById });
            if (acceptedCheck.ok) verified.push(...acceptedEntries);
            else acceptedCheck.errors.forEach((error) => rejectedIds.add(error.id ?? ''));
          }
          break;
        }
        const check = verifyEnrichmentBatch({ entries: batch, results: result.entries, identities, workflowsById: options.workflowsById });
        if (!check.ok) {
          const invalidIds = rejectedIdsForBatch(batch, check.errors);
          const acceptedBatch = batch.filter((entry) => !invalidIds.has(entry.id));
          const acceptedEntries = result.entries.filter((entry) => !invalidIds.has(entry.id));
          clearRejectedCheckpointEntries(options.checkpointPath, [...invalidIds]);
          const message = validationMessage(check.errors);
          const reasons = check.errors.slice(0, 8).map((item) => `${item.id ?? 'batch'}: ${item.code}`);
          recordBatchRejection(options.ledgerPath, {
            batchIndex, identityHash, errorCode: 'validation_failed', errorMessage: message,
            validationErrors: reasons, acceptedCount: acceptedBatch.length, rejectedCount: invalidIds.size, rejectedIds: [...invalidIds],
          });
          rejectedBatches++;
          invalidIds.forEach((id) => rejectedIds.add(id));
          if (acceptedBatch.length > 0) {
            const acceptedCheck = verifyEnrichmentBatch({ entries: acceptedBatch, results: acceptedEntries, identities, workflowsById: options.workflowsById });
            if (acceptedCheck.ok) verified.push(...acceptedEntries);
            else acceptedCheck.errors.forEach((error) => rejectedIds.add(error.id ?? ''));
          }
          break;
        }
        const writtenHash = checkpointHash(options.checkpointPath, ids);
        if (!writtenHash) throw new EnrichmentBatchError(batchIndex, 'describe checkpoint was not written');
        recordBatchCompletion(options.ledgerPath, { batchIndex, identityHash, checkpointHash: writtenHash, acceptedCount: check.accepted.length });
        verified.push(...result.entries);
        completedBatches++;
        break;
      } catch (error) {
        if (error instanceof EnrichmentBatchError) throw error;
        if (attempt === maxAttempts) {
          recordBatchFailure(options.ledgerPath, { batchIndex, identityHash, errorCode: 'batch_process_error', errorMessage: safeError(error) });
          throw new EnrichmentBatchError(batchIndex, safeError(error));
        }
        await wait((options.retryDelayMs ?? 500) * 2 ** (attempt - 1));
      }
    }
  }
  return { entries: verified, completedBatches, rejectedBatches, rejectedIds: [...rejectedIds].filter(Boolean), ledgerPath: options.ledgerPath };
}
