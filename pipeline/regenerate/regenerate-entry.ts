import type { Candidate, Entry, EntryReadiness, WorkflowChart } from '@hub/contracts';
import { deriveStructure, deriveChart } from '../derive/structure.js';
import { deriveReadiness } from '../derive/readiness.js';
import { deriveHostnames } from '../derive/hostnames.js';
import { deriveCompatibility } from '../derive/compatibility.js';
import { normalizeIntegrationLabels } from '../derive/integration-labels.js';
import type { CompatibilityTarget } from '../compatibility-types.js';
import { scanCandidate, type ScanCandidateOptions } from '../scan/scan-entry.js';

/**
 * One entry's regenerated deterministic facts.
 *
 * Two inputs are possible and they are not interchangeable:
 *
 *  - **A body.** Everything the pipeline derives is recomputed from it:
 *    structure, chart, readiness, hostnames, compatibility and the scanner
 *    verdict. This is the path the 9,385 matched official entries take.
 *  - **No body.** Nothing can be recomputed, so the only honest operation is
 *    vocabulary normalisation: the published integration labels go through the
 *    same canonical mapping a body's node types go through, the entry keeps the
 *    metadata it already had, and its readiness report is marked `unscanned` so
 *    an empty credential list cannot read as "needs nothing".
 */
export type RegenerationOutcome = 're-derived' | 'labels-only';

export type RegenerateEntryOptions = {
  entry: Entry;
  body: unknown;
  chart: WorkflowChart;
  compatibilityTarget: CompatibilityTarget;
  scan?: ScanCandidateOptions['scan'];
  scannerVersion: string;
  /** Forwarded to the scan so the caller can ledger bodies the parser could not read. */
  onUnparseable?: ScanCandidateOptions['onUnparseable'];
};

export type RegeneratedEntry = {
  entry: Entry;
  chart: WorkflowChart;
  outcome: RegenerationOutcome;
};

/**
 * An explicit "we could not look" report. It is never a claim that a workflow
 * needs nothing: every list is empty because nothing was read, and `analysis`
 * says so. The disclaimer travels with the entry rather than living only in a
 * report, so a reader of one entry sees the reason.
 */
export function unscannedReadiness(): EntryReadiness {
  return {
    analysis: 'unscanned',
    credentials: [],
    replaceableValues: [],
    writeActions: [],
    aiModel: { present: false, model: null },
    extraPackages: [],
    versionNotes: [],
    pinnedData: { present: false, nodeCount: 0 },
    isSubWorkflow: false,
  };
}

function withNormalisedIntegrations(entry: Entry, analysis: NonNullable<EntryReadiness['analysis']>): Entry {
  const readiness = entry.readiness ? { ...entry.readiness, analysis } : unscannedReadiness();
  return {
    ...entry,
    structure: { ...entry.structure, integrations: normalizeIntegrationLabels(entry.structure?.integrations ?? []) },
    readiness,
  };
}

/**
 * No body exists at all, so nothing can be recomputed: normalise the published
 * vocabulary and mark the readiness report unscanned, which is the honest state
 * for an entry whose empty credential list would otherwise read as "needs
 * nothing".
 */
export function normaliseWithoutBody(entry: Entry): Entry {
  return withNormalisedIntegrations(entry, 'unscanned');
}

/**
 * A committed body exists but is not the body the published facts were derived
 * from — the repository ships this class of entry sanitized, and re-deriving from
 * the sanitized copy demonstrably loses signals the published values carry
 * (legacy-expression notes and compatibility blockers among them). Only the
 * vocabulary is moved, and the readiness report keeps its `derived` state: a body
 * did produce it.
 */
export function normaliseWithCommittedBody(entry: Entry): Entry {
  return withNormalisedIntegrations(entry, 'derived');
}

/** Recompute every derived fact group from the body. */
export async function regenerateFromBody(options: RegenerateEntryOptions): Promise<RegeneratedEntry> {
  const { entry, body, compatibilityTarget, scan, scannerVersion } = options;
  // `scanCandidate` reads `id` and `json` only, but its parameter is the
  // acquisition-time `Candidate`, which an already-published entry is not. The
  // candidate is stated explicitly rather than cast from the whole entry, so the
  // two fields the scan actually depends on are visible at the call site.
  const candidate: Candidate = {
    id: entry.id,
    source: entry.source,
    rights: entry.rights,
    title: entry.title,
    json: body,
    bytes: 0,
  };
  const security = await scanCandidate(candidate, { scan, scannerVersion, onUnparseable: options.onUnparseable });
  return {
    entry: {
      ...entry,
      structure: deriveStructure(body),
      readiness: deriveReadiness(body),
      hostnames: deriveHostnames(body),
      compatibility: deriveCompatibility(body, compatibilityTarget),
      security,
    },
    chart: deriveChart(body),
    outcome: 're-derived',
  };
}
