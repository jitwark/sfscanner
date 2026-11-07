import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { EntryWithChart, Reject } from '@hub/contracts';
import { atomicWriteFile } from '../stage-ledger.js';
import { runCrossCheck, type CrossCheckResult } from '../cross-check.js';
import type { DedupedCandidate } from './dedup-stage.js';

/**
 * The legacy harvest the orphan analysis compares against. It is a checkout on
 * this machine rather than a run input, so a missing directory yields zeroes
 * instead of failing the build — `runCrossCheck` handles that itself.
 */
const LEGACY_VAULT_DIR = 'D:/projects/n8n-vault-core/templates';

export type OutputStageOptions = {
  /** Deduped, rights-settled candidates — the sole source of the published bodies. */
  candidates: DedupedCandidate[];
  entriesWithChart: EntryWithChart[];
  rejects: Reject[];
  workDir: string;
  entriesPath: string;
  rejectsPath: string;
};

export type OutputStageResult = {
  crossCheck: CrossCheckResult;
};

/**
 * WRITE OUTPUT — the four artifacts a run leaves for packaging and enrichment,
 * then the cross-check against the legacy harvest that the run report prints.
 *
 * Only a `redistributable` candidate's body is ever written to
 * `workflows.jsonl`; the redistributability decision was made upstream, and
 * this stage re-checks it rather than trusting that it was made.
 */
export async function writeCorpusOutputs(options: OutputStageOptions): Promise<OutputStageResult> {
  const { candidates, entriesWithChart, rejects, workDir, entriesPath, rejectsPath } = options;

  await atomicWriteFile(entriesPath, JSON.stringify(entriesWithChart, null, 2));

  // The sanitized workflow itself, one JSON object per line, keyed by entry id.
  // Packaging needs these to build the download packs; without them every
  // download served an empty `{"nodes":[],"connections":{}}`. They are kept out
  // of entries.json because that file is already hundreds of megabytes.
  const workflowLines: string[] = [];
  for (const candidate of candidates) {
    if (!candidate.json || candidate.rights.status !== 'redistributable') continue;
    workflowLines.push(JSON.stringify({ id: candidate.id, workflow: candidate.json }));
  }
  if (workflowLines.length > 0) {
    await atomicWriteFile(join(workDir, 'workflows.jsonl'), workflowLines.join('\n') + '\n');
  } else {
    await rm(join(workDir, 'workflows.jsonl'), { force: true });
  }
  // Model input bodies are retained for every rights class, but remain local
  // and are never passed to packaging. The model-safe projection removes any
  // source prose before an outbound packet is written.
  const modelWorkflowLines = candidates
    .filter((candidate) => candidate.json && candidate.dedup.canonical)
    .map((candidate) => JSON.stringify({ id: candidate.id, workflow: candidate.json }));
  if (modelWorkflowLines.length > 0) {
    await atomicWriteFile(join(workDir, 'model-workflows.jsonl'), modelWorkflowLines.join('\n') + '\n');
  } else {
    await rm(join(workDir, 'model-workflows.jsonl'), { force: true });
  }
  if (rejects.length > 0) {
    const rejectsContent = rejects.map((r) => JSON.stringify(r)).join('\n') + '\n';
    await atomicWriteFile(rejectsPath, rejectsContent);
  }

  const crossCheck = await runCrossCheck(
    new Set(candidates.map((c) => c.dedup.fingerprint)),
    { vaultDir: LEGACY_VAULT_DIR },
  );

  return { crossCheck };
}
