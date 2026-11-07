import fs from 'node:fs';
import path from 'node:path';

export type BatchStatus = 'started' | 'completed' | 'failed' | 'rejected';
export type EnrichmentBatchRecord = {
  batchIndex: number;
  status: BatchStatus;
  identityHash: string;
  checkpointHash?: string;
  selectedCount: number;
  selectedIds?: string[];
  inputManifestPath?: string;
  acceptedCount?: number;
  rejectedCount?: number;
  rejectedIds?: string[];
  validationErrors?: string[];
  attemptCount: number;
  startedAt: string;
  completedAt?: string;
  errorCode?: string;
  errorMessage?: string;
};

type BatchLedger = Record<string, EnrichmentBatchRecord>;

export function loadBatchLedger(filePath: string): BatchLedger {
  try {
    const value = JSON.parse(fs.readFileSync(filePath, 'utf8')) as BatchLedger;
    return value && typeof value === 'object' ? value : {};
  } catch {
    return {};
  }
}

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(temporary, filePath);
}

function writeLedger(filePath: string, ledger: BatchLedger): void { writeJson(filePath, ledger); }

function archivePrior(filePath: string, record: EnrichmentBatchRecord): void {
  const historyPath = `${filePath}.history.json`;
  let history: EnrichmentBatchRecord[] = [];
  try { history = JSON.parse(fs.readFileSync(historyPath, 'utf8')) as EnrichmentBatchRecord[]; } catch { /* first archived record */ }
  history.push(record);
  writeJson(historyPath, history);
}

function update(filePath: string, batchIndex: number, patch: Partial<EnrichmentBatchRecord> & Pick<EnrichmentBatchRecord, 'identityHash'>): void {
  const ledger = loadBatchLedger(filePath);
  const previous = ledger[String(batchIndex)];
  const next: EnrichmentBatchRecord = {
    ...previous,
    batchIndex,
    status: patch.status ?? previous?.status ?? 'started',
    identityHash: patch.identityHash,
    selectedCount: patch.selectedCount ?? previous?.selectedCount ?? 0,
    attemptCount: patch.attemptCount ?? previous?.attemptCount ?? 0,
    startedAt: patch.startedAt ?? previous?.startedAt ?? new Date().toISOString(),
  };
  ledger[String(batchIndex)] = { ...next, ...patch };
  writeLedger(filePath, ledger);
}

export function recordBatchStart(filePath: string, input: { batchIndex: number; identityHash: string; selectedCount: number; selectedIds?: string[]; inputManifestPath?: string }): void {
  const previous = loadBatchLedger(filePath)[String(input.batchIndex)];
  if (previous && previous.identityHash !== input.identityHash) archivePrior(filePath, previous);
  update(filePath, input.batchIndex, {
    ...input,
    status: 'started',
    attemptCount: previous?.identityHash === input.identityHash ? (previous.attemptCount ?? 0) + 1 : 1,
    startedAt: new Date().toISOString(),
    checkpointHash: undefined, acceptedCount: undefined, errorCode: undefined, errorMessage: undefined,
    validationErrors: undefined, rejectedCount: undefined, rejectedIds: undefined,
  });
}

export function recordBatchCompletion(filePath: string, input: { batchIndex: number; identityHash: string; checkpointHash: string; acceptedCount: number }): void {
  update(filePath, input.batchIndex, {
    ...input, status: 'completed', completedAt: new Date().toISOString(), errorCode: undefined, errorMessage: undefined,
    validationErrors: undefined, rejectedCount: undefined, rejectedIds: undefined,
  });
}

export function recordBatchFailure(filePath: string, input: { batchIndex: number; identityHash: string; errorCode: string; errorMessage: string }): void {
  update(filePath, input.batchIndex, { ...input, status: 'failed', completedAt: new Date().toISOString(), checkpointHash: undefined, acceptedCount: undefined, validationErrors: undefined });
}

export function recordBatchRejection(filePath: string, input: {
  batchIndex: number;
  identityHash: string;
  errorCode: string;
  errorMessage: string;
  validationErrors?: string[];
  acceptedCount?: number;
  rejectedCount?: number;
  rejectedIds?: string[];
}): void {
  update(filePath, input.batchIndex, {
    ...input, status: 'rejected', completedAt: new Date().toISOString(), checkpointHash: undefined,
  });
}

export function isReusableCompletedBatch(record: EnrichmentBatchRecord | undefined, identityHash: string, checkpointHash: string): boolean {
  return record?.status === 'completed' && record.identityHash === identityHash && record.checkpointHash === checkpointHash;
}
