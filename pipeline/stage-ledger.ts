import { mkdir, readFile, appendFile, writeFile, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { STAGES, type Stage, type StageRecord } from '@hub/contracts';

export function makeLedgerKey(entryId: string, stage: Stage): string {
  return `${entryId}:${stage}`;
}

export async function loadLedger(ledgerPath: string): Promise<Map<string, StageRecord>> {
  const map = new Map<string, StageRecord>();
  try {
    const content = await readFile(ledgerPath, 'utf8');
    const lines = content.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const record = JSON.parse(trimmed) as StageRecord;
        if (record.entryId && STAGES.includes(record.stage as Stage) && record.inputHash && record.outputHash) {
          map.set(makeLedgerKey(record.entryId, record.stage), record);
        }
      } catch {
        // Skip malformed lines
      }
    }
  } catch {
    // Return empty map if file doesn't exist yet
  }
  return map;
}

export async function appendStageRecord(ledgerPath: string, record: StageRecord): Promise<void> {
  await mkdir(dirname(ledgerPath), { recursive: true });
  const line = JSON.stringify(record) + '\n';
  await appendFile(ledgerPath, line, 'utf8');
}

export function shouldSkipStage(
  ledger: Map<string, StageRecord>,
  entryId: string,
  stage: Stage,
  inputHash: string,
  outputHash: string,
): boolean {
  const existing = ledger.get(makeLedgerKey(entryId, stage));
  if (!existing) return false;
  return existing.ok === true && existing.inputHash === inputHash && existing.outputHash === outputHash;
}

export type AtomicWriteInputs = { nowFn?: () => number; randomFn?: () => number };

export function createAtomicTemporaryPath(filePath: string, timestamp: number, random: number): string {
  const suffix = random.toString(36).slice(2, 8);
  return `${filePath}.tmp.${timestamp}_${suffix}`;
}

export async function atomicWriteFile(
  filePath: string,
  content: string | Buffer,
  inputs: AtomicWriteInputs = {},
): Promise<void> {
  const dir = dirname(filePath);
  await mkdir(dir, { recursive: true });
  // Production fallbacks avoid temp-name collisions; tests inject stable inputs.
  const timestamp = (inputs.nowFn ?? (() => Date.now()))();
  const random = (inputs.randomFn ?? (() => Math.random()))();
  const tmpPath = createAtomicTemporaryPath(filePath, timestamp, random);
  await writeFile(tmpPath, content);
  await rename(tmpPath, filePath);
}
