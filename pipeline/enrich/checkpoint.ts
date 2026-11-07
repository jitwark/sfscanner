import * as fs from 'node:fs';
import * as path from 'node:path';
import type { DescriptionProvenance, GeneratedDescription } from '@hub/contracts';
import type { EnrichmentIdentity } from './enrichment-identity';

export type CheckpointEntry = {
  summary: string;
  description: string;
  descriptionContent?: GeneratedDescription;
  descriptionSource: 'upstream' | 'generated' | 'fallback';
  descriptionProvenance?: DescriptionProvenance;
  /** Source-workflow identity used to invalidate stale prose after corpus changes. */
  workflowFingerprint?: string;
  /** Full model/input/prompt/schema identity for safe checkpoint reuse. */
  identity?: EnrichmentIdentity;
};

export type CheckpointMap = Record<string, CheckpointEntry>;

export function loadCheckpoint(filePath?: string): CheckpointMap {
  if (!filePath) return {};
  try {
    if (fs.existsSync(filePath)) {
      const raw = fs.readFileSync(filePath, 'utf-8');
      return JSON.parse(raw);
    }
  } catch {
    // ignore read errors
  }
  return {};
}

export function saveCheckpoint(filePath: string | undefined, map: CheckpointMap): void {
  if (!filePath) return;
  try {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const tmp = `${filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(map, null, 2), 'utf-8');
    fs.renameSync(tmp, filePath);
  } catch {
    // ignore write errors
  }
}
