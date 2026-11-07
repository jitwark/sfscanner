import path from 'node:path';
import type { Entry } from '@hub/contracts';
import { runDescriptionBatches } from './batch-runner.js';
import { resolveEnrichmentModel } from './antigravity-proxy.js';

export type DescriptionBatchCliOptions = {
  runId: string;
  targets: Entry[];
  described: Entry[];
  workflowsById: ReadonlyMap<string, unknown>;
  checkpointPath: string;
  workDir: string;
  batchLedgerPath?: string;
  batchManifestPath?: string;
  enrichmentBatchSize: number;
  verifyOnly: boolean;
  preflightOnly: boolean;
  batchSize: number;
  concurrency: number;
  timeoutMs: number;
  retryFallbacks: boolean;
  regenerateDescriptions: boolean;
  generatedAt?: string;
  /** Preserve an incomplete checkpoint for resume instead of packaging it. */
  failOnRejection?: boolean;
};

export async function runDescriptionBatch(options: DescriptionBatchCliOptions): Promise<Entry[]> {
  const started = Date.now();
  const ledgerPath = options.batchLedgerPath
    ? path.resolve(process.cwd(), options.batchLedgerPath)
    : path.join(options.workDir, 'enrichment-batches.json');
  const result = await runDescriptionBatches({
    runId: options.runId,
    entries: options.targets,
    workflowsById: options.workflowsById,
    checkpointPath: options.checkpointPath,
    ledgerPath,
    inputManifestPath: options.batchManifestPath
      ? path.resolve(process.cwd(), options.batchManifestPath)
      : path.join(options.workDir, 'enrichment-input-manifest.json'),
    batchSize: options.enrichmentBatchSize,
    verifyOnly: options.verifyOnly,
    preflightOnly: options.preflightOnly,
    describeOptions: {
      systemPromptPath: path.resolve(process.cwd(), 'pipeline/enrich/describe-system.txt'),
      model: resolveEnrichmentModel(),
      batchSize: options.batchSize,
      concurrency: options.concurrency,
      timeoutMs: options.timeoutMs,
      maxRetries: 1,
      maxFallbackRate: 0,
      retryFallbacks: options.retryFallbacks,
      ...(options.generatedAt ? { generatedAt: options.generatedAt } : {}),
      // Production batches must regenerate upstream prose; otherwise the
      // model would receive no chance to replace stale website descriptions.
      regenerateUpstream: true,
    },
  });
  process.stdout.write(
    `${options.verifyOnly ? 'verified' : 'enriched'} ${result.entries.length} entries in ${result.completedBatches} batch(es), ` +
      `${result.rejectedBatches} rejected, ${((Date.now() - started) / 1000).toFixed(0)}s; ledger ${ledgerPath}\n`,
  );
  if (result.rejectedBatches > 0 && options.failOnRejection !== false) {
    throw new Error(`Enrichment completed with ${result.rejectedBatches} rejected batch(es) and ${result.rejectedIds.length} unresolved workflow(s); resume from the checkpoint before packaging.`);
  }
  const updates = new Map(result.entries.map((entry) => [entry.id, entry]));
  return options.described.map((entry) => updates.get(entry.id) ?? entry);
}
