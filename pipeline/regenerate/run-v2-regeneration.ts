/**
 * The v2 regeneration run: one `v2-entry-regeneration-plan-v1` per inventory row, and the census
 * counted from the plans themselves.
 *
 * The run is what a per-entry plan cannot see — it binds three inputs to each other and refuses a
 * partial join rather than skipping a row:
 *
 *  - the retained records must have been derived from *this* inventory, and bind its rows one-to-one
 *    in both directions;
 *  - every row needs a committed subject for the readiness-contradiction check, and every subject a
 *    row, so entries the corpus carries cannot quietly fall out of the run;
 *  - no plan may claim a `CURRENT` verdict from an identity the admitted registry does not stand
 *    behind, so the retired `c998701`/`scanner-beta-1` stamps stay historical;
 *  - every count is derived from the plans, never from a fixed corpus total.
 *
 * Pure: no I/O, no clock, no randomness. `v2-cli.ts` is the layer that reads files and writes them;
 * this module only decides, and the plan order is the entry id's, so the same three inputs
 * serialize byte-identically however a caller happens to order them.
 */
import { compareCanonicalStrings } from '@hub/contracts/stable-order';
import type { CorpusV2InputInventory } from '../../scripts/lib/corpus-v2-input-inventory.js';
import { ADMITTED_V2_SCAN_IDENTITY } from '../scan/v2-corpus-adapter.js';
import {
  planV2EntryRegeneration,
  V2_ARTIFACT_GROUPS,
  type V2ArtifactDisposition,
  type V2ArtifactGroup,
  type V2EntryRegenerationPlan,
  type V2PlanReason,
  type V2RegenerationSubject,
} from './v2-regenerate-entry.js';
import type { ScanFreshness, V2ScanEvidenceRecord } from './v2-scan-evidence.js';

export const V2_REGENERATION_RUN_SCHEMA_VERSION = 'v2-regeneration-run-v1' as const;

export type V2RegenerationRunOptions = Readonly<{
  /** The C1 inventory the retained records were derived from; a plan from another binding fails. */
  inventory: CorpusV2InputInventory;
  /** The committed entries the plans are written for: one per inventory row. */
  subjects: readonly V2RegenerationSubject[];
  /** The records `buildV2ScanEvidence` produced from `inventory`. */
  records: readonly V2ScanEvidenceRecord[];
}>;

export type V2ArtifactGroupCounts = Readonly<{
  group: V2ArtifactGroup;
  regenerated: number;
  historical: number;
  unavailable: number;
}>;

/** The census a run reports: one count per state, reason, artifact disposition and current verdict. */
export type V2RegenerationRunSummary = Readonly<{
  schemaVersion: typeof V2_REGENERATION_RUN_SCHEMA_VERSION;
  inventorySha256: string;
  entryCount: number;
  states: Readonly<Record<ScanFreshness, number>>;
  reasons: Readonly<Record<V2PlanReason, number>>;
  artifactGroups: readonly V2ArtifactGroupCounts[];
  /** How many plans claim `CURRENT`, and the producing identities behind them — the admitted one, or none. */
  currentVerdicts: Readonly<{ count: number; producingIdentities: readonly string[] }>;
}>;

export type V2RegenerationRun = V2RegenerationRunSummary & Readonly<{
  plans: readonly V2EntryRegenerationPlan[];
}>;

export const V2_REGENERATION_RUN_OPTION_KEYS = Object.freeze(['inventory', 'records', 'subjects'] as const);

const DISPOSITIONS: Record<V2ArtifactDisposition, true> = Object.freeze({
  regenerated: true,
  historical: true,
  unavailable: true,
});

/** Index one item per key and refuse the second one: half a run silently winning is not a run. */
function indexOne<T>(items: readonly T[], keyOf: (item: T) => string, what: string): Map<string, T> {
  const index = new Map<string, T>();
  for (const item of items) {
    const key = keyOf(item);
    if (typeof key !== 'string' || key.length === 0) throw new TypeError(`v2 regeneration run: a ${what} carries no entry id.`);
    if (index.has(key)) throw new TypeError(`v2 regeneration run: duplicate ${what} for entry ${key}.`);
    index.set(key, item);
  }
  return index;
}

export function runV2Regeneration(options: V2RegenerationRunOptions): V2RegenerationRun {
  if (options === null || typeof options !== 'object') throw new TypeError('v2 regeneration run: options are required.');
  const unknown = Object.keys(options).filter((key) => !(V2_REGENERATION_RUN_OPTION_KEYS as readonly string[]).includes(key));
  if (unknown.length > 0) {
    throw new TypeError(`v2 regeneration run: unknown option(s): ${unknown.sort(compareCanonicalStrings).join(', ')}`);
  }

  const { inventory, records, subjects } = options;
  if (inventory === null || typeof inventory !== 'object' || inventory.schemaVersion !== 'corpus-v2-input-inventory-v1') {
    throw new TypeError('v2 regeneration run: unsupported inventory schema version.');
  }
  if (!Array.isArray(inventory.rows) || !Array.isArray(records) || !Array.isArray(subjects)) {
    throw new TypeError('v2 regeneration run: the inventory rows, records and subjects are required.');
  }

  const rows = indexOne(inventory.rows, (row) => row.entryId, 'inventory row');
  const recordOf = indexOne(records, (record) => record.entryId, 'retained record');
  const subjectOf = indexOne(subjects, (subject) => subject.id, 'committed subject');
  if (rows.size !== recordOf.size) {
    throw new TypeError(`v2 regeneration run: ${recordOf.size} retained record(s) for ${rows.size} inventory row(s).`);
  }

  // Fixed key order: the serialized census reads the same way on every run, zeros included.
  const states: Record<ScanFreshness, number> = { CURRENT: 0, NO_RESULT: 0, HISTORICAL: 0, UNSCANNED: 0, SOURCE_UNAVAILABLE: 0 };
  const reasons: Record<V2PlanReason, number> = {
    'admitted-receipt': 0,
    'readiness-contradiction': 0,
    'unadmitted-receipt': 0,
    'no-result': 0,
    'retained-verdict': 0,
    'no-receipt': 0,
    'owner-ruling': 0,
  };
  const artifactGroups = V2_ARTIFACT_GROUPS.map((group) => ({
    group,
    dispositions: { regenerated: 0, historical: 0, unavailable: 0 } as Record<V2ArtifactDisposition, number>,
  }));
  const groupOf = new Map(artifactGroups.map((counts) => [counts.group, counts]));
  const producingIdentities = new Set<string>();
  const plans: V2EntryRegenerationPlan[] = [];
  let currentVerdicts = 0;

  for (const entryId of [...rows.keys()].sort(compareCanonicalStrings)) {
    const record = recordOf.get(entryId);
    if (record === undefined) throw new TypeError(`v2 regeneration run: no retained record for inventory row ${entryId}.`);
    const subject = subjectOf.get(entryId);
    if (subject === undefined) throw new TypeError(`v2 regeneration run: no committed subject for inventory row ${entryId}.`);

    const plan = planV2EntryRegeneration(subject, record);
    if (plan.inventorySha256 !== inventory.inventorySha256) {
      throw new TypeError(`v2 regeneration run: the plan for ${entryId} was derived from another inventory binding.`);
    }
    if (!(plan.state in states)) throw new TypeError(`v2 regeneration run: unknown scan freshness "${String(plan.state)}".`);
    if (!(plan.stateReason in reasons)) throw new TypeError(`v2 regeneration run: unknown plan reason "${String(plan.stateReason)}".`);
    states[plan.state] += 1;
    reasons[plan.stateReason] += 1;

    for (const artifact of plan.artifacts) {
      const counts = groupOf.get(artifact.group);
      if (counts === undefined || !DISPOSITIONS[artifact.disposition]) {
        throw new TypeError(`v2 regeneration run: unknown artifact group or disposition for ${entryId}.`);
      }
      counts.dispositions[artifact.disposition] += 1;
    }

    const assessment = plan.assessment;
    if (assessment !== null && assessment.label === 'CURRENT') {
      if (assessment.producingIdentity !== ADMITTED_V2_SCAN_IDENTITY.scannerVersion) {
        throw new TypeError(`v2 regeneration run: entry ${entryId} claims a CURRENT verdict from the non-admitted identity "${assessment.producingIdentity}".`);
      }
      currentVerdicts += 1;
      producingIdentities.add(assessment.producingIdentity);
    }
    plans.push(plan);
  }

  return Object.freeze({
    schemaVersion: V2_REGENERATION_RUN_SCHEMA_VERSION,
    inventorySha256: inventory.inventorySha256,
    entryCount: plans.length,
    states: Object.freeze(states),
    reasons: Object.freeze(reasons),
    artifactGroups: Object.freeze(artifactGroups.map(({ group, dispositions }) => Object.freeze({ group, ...dispositions }))),
    currentVerdicts: Object.freeze({
      count: currentVerdicts,
      producingIdentities: Object.freeze([...producingIdentities].sort(compareCanonicalStrings)),
    }),
    plans: Object.freeze(plans),
  });
}
