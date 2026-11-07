import type { Entry, WorkflowChart } from '@hub/contracts';
import type { ScannerSidecarPolicy } from '../package/scanner-sidecars.js';

/**
 * Input and output shapes for `runEnrichCorpus`.
 *
 * These live beside the function rather than inside it so the enrichment
 * entrypoint stays a readable pipeline rather than a wall of declarations,
 * and so `build-corpus` can import the result shape without importing the
 * enrichment implementation.
 */

export type EnrichCorpusOptions = {
  inputPath?: string;
  entries?: Entry[];
  workflowsById?: Map<string, unknown>;
  /** Model-safe workflow bodies used only for deterministic compatibility checks. */
  compatibilityWorkflowsById?: Map<string, unknown>;
  /**
   * Charts already derived upstream. Acquisition derives a chart per candidate,
   * so re-deriving here would need the raw workflow JSON again purely to produce
   * an identical result.
   */
  chartsById?: Map<string, WorkflowChart>;
  requireGemini?: boolean;
  outputDir?: string;
  /**
   * Whether `outputDir` has to be a complete release tree, i.e. stage the declared
   * scanner sidecars the release manifest must own. Defaults to required; a caller
   * building a scratch corpus says `'optional'` by name (see `BuildManifestOptions`).
   */
  scannerSidecars?: ScannerSidecarPolicy;
  checkpointPath?: string; sampleLimit?: number; generatedAt: string;
};

export type SizeTableItem = {
  path: string;
  uncompressedBytes: number;
  compressedBytes: number;
};

export type EnrichCorpusResult = {
  totalEntries: number;
  entries: Entry[];
  manifestSha256: string;
  sizeTable: SizeTableItem[];
  budgetsMet: {
    searchIndexUnder8MB: boolean;
    homepageUnder200KB: boolean;
  };
};
