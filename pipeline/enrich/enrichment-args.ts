import { resolveReleaseTimestamp } from '../package/release-clock.js';

/**
 * Command-line surface for `run-enrichment.ts`.
 *
 * Kept beside the runner rather than inside it: argument parsing is the one
 * part of the runner with no I/O and no model dependency, so it is the part
 * worth testing in isolation.
 */

export type EnrichmentArgs = {
  runId: string;
  limit?: number;
  describeLimit?: number;
  enrichmentBatchSize: number;
  skipDescribe: boolean;
  batchSize: number;
  concurrency: number;
  timeoutMs: number;
  retryFallbacks: boolean;
  regenerateDescriptions: boolean;
  onlyDescribed: boolean;
  describeOnly: boolean;
  allowLiveGemini: boolean;
  stagingDir?: string;
  acceptPartial: boolean;
  requireGemini: boolean;
  verifyOnly: boolean; preflightOnly: boolean; batchLedgerPath?: string; checkpointPath?: string; batchManifestPath?: string;
  generatedAt?: string;
};
export function parseArgs(argv: string[]): EnrichmentArgs {
  const value = (flag: string) => {
    const index = argv.indexOf(flag);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const runId = value('--run');
  if (!runId) throw new Error('--run <runId> is required');
  const limit = value('--limit');
  const describeLimit = value('--describe-limit');
  return {
    runId,
    limit: limit ? Number(limit) : undefined,
    describeLimit: describeLimit ? Number(describeLimit) : undefined,
    enrichmentBatchSize: Number(value('--enrichment-batch-size') ?? 25),
    skipDescribe: argv.includes('--skip-describe'),
    batchSize: Number(value('--batch') ?? 8),
    concurrency: Number(value('--concurrency') ?? 16),
    timeoutMs: Number(value('--timeout') ?? 300) * 1000,
    retryFallbacks: argv.includes('--retry-fallbacks'),
    regenerateDescriptions: argv.includes('--regenerate-descriptions'),
    onlyDescribed: argv.includes('--only-described'),
    describeOnly: argv.includes('--describe-only'),
    allowLiveGemini: argv.includes('--allow-live-gemini'),
    stagingDir: value('--staging-dir'),
    acceptPartial: argv.includes('--accept-partial'),
    requireGemini: argv.includes('--require-gemini'),
    verifyOnly: argv.includes('--verify-only'),
    preflightOnly: argv.includes('--preflight'),
    batchLedgerPath: value('--batch-ledger'),
    checkpointPath: value('--checkpoint'),
    batchManifestPath: value('--batch-manifest'),
    generatedAt: resolveReleaseTimestamp(value('--generated-at')),
  };
}
