/**
 * The exclusion registry: an immutable, append-only list of workflow
 * identities withheld from every downstream artifact, keyed by reason and
 * date.
 *
 * **Identity.** A record is keyed by the same canonical id every `Entry`/
 * `Candidate` already carries — the 16-hex-character output of
 * `pipeline/acquire/entry-id.ts`'s `entryId(kind, ref, path)`. No second
 * identity scheme is introduced: a title or slug can change on a re-scrape or
 * a re-describe, but `entryId` is a hash of the source coordinates
 * (kind + ref + path) that never changes for the same workflow, which is
 * exactly the stability an exclusion needs — an exclusion recorded against a
 * workflow must still match it after its title, tags, or description change.
 *
 * **Registry vs. rights status.** This module answers a different question
 * than `rights.ts`'s `excluded` status does. The registry is the *cause* and
 * the *authority*: it is consulted at the earliest possible pipeline point
 * (immediately after acquisition, before rights are even decided — see
 * `pipeline/rights/exclusion-filter.ts`), so an excluded workflow is dropped
 * before it becomes a `Candidate` that anything downstream can see. A record
 * never becomes a full `Entry` at all in the ordinary path, so
 * `EntryRights.status === 'excluded'` is not how exclusion normally
 * propagates — it exists in the rights union as a second, independent gate:
 * if a record ever reaches rights decision or entry construction carrying an
 * id this registry recognizes, that code path can name it `excluded` instead
 * of guessing, rather than treating an already-answered question as still
 * open. Two gates, not one, because the registry's contents can change
 * (append-only growth) independently of any single pipeline run, and a
 * resumed or partially-cached run is exactly the case where the earlier gate
 * could be bypassed by stale state.
 *
 * **Immutable, append-only.** A registry value is frozen and exposes no
 * mutation method. Growing it means calling `appendExclusion`, which returns
 * a *new* registry with strictly one more record — it never edits or removes
 * an existing one. There is deliberately no `remove`/`update` API: a
 * retraction is a policy decision ([B]-blocked per
 * `openspec/changes/legal-rights-and-release-integrity/tasks.md`), not a data
 * operation this module should make easy to do quietly.
 */

const ENTRY_ID_PATTERN = /^[0-9a-f]{16}$/;

export type ExclusionRecord = {
  /** Canonical `entryId(kind, ref, path)` output — see module doc comment. */
  id: string;
  /** Human-readable, non-empty. Evidence, not a legal conclusion. */
  reason: string;
  /** ISO 8601 timestamp the exclusion was recorded. */
  excludedAt: string;
};

export type ExclusionRegistry = {
  readonly records: readonly ExclusionRecord[];
  isExcluded(id: string): boolean;
  recordFor(id: string): ExclusionRecord | undefined;
};

function validateRecord(record: ExclusionRecord): void {
  if (!ENTRY_ID_PATTERN.test(record.id)) {
    throw new Error(
      `Exclusion registry record has a malformed id "${record.id}": expected the 16-hex-character ` +
        'output of entryId(kind, ref, path), not a title, slug, or free-text identifier.',
    );
  }
  if (!record.reason.trim()) {
    throw new Error(`Exclusion registry record for id "${record.id}" has no reason recorded.`);
  }
  if (!Number.isFinite(Date.parse(record.excludedAt))) {
    throw new Error(
      `Exclusion registry record for id "${record.id}" has an invalid excludedAt timestamp: "${record.excludedAt}".`,
    );
  }
}

/**
 * Builds a frozen registry from a list of records, validating every one and
 * rejecting a duplicate id outright — the registry has exactly one record per
 * excluded identity, so two different reasons for the same id is a data bug,
 * not a merge to resolve silently.
 */
export function createExclusionRegistry(records: readonly ExclusionRecord[]): ExclusionRegistry {
  const seen = new Set<string>();
  for (const record of records) {
    validateRecord(record);
    if (seen.has(record.id)) {
      throw new Error(`Exclusion registry has more than one record for id "${record.id}".`);
    }
    seen.add(record.id);
  }
  const frozenRecords = Object.freeze(records.map((record) => Object.freeze({ ...record })));
  const byId = new Map(frozenRecords.map((record) => [record.id, record]));

  return Object.freeze({
    records: frozenRecords,
    isExcluded: (id: string) => byId.has(id),
    recordFor: (id: string) => byId.get(id),
  });
}

/** The starting registry: no exclusions recorded yet (owner decision [B]-blocked). */
export const EMPTY_EXCLUSION_REGISTRY: ExclusionRegistry = createExclusionRegistry([]);

/**
 * Returns a *new* registry with `record` appended. Never mutates `registry`.
 * Throws if `record.id` is already present — append-only means every id is
 * recorded once, with one reason and one date; changing either requires a
 * conscious new record kept separately, not an overwrite of this one.
 */
export function appendExclusion(registry: ExclusionRegistry, record: ExclusionRecord): ExclusionRegistry {
  if (registry.isExcluded(record.id)) {
    throw new Error(
      `Id "${record.id}" is already recorded in the exclusion registry (reason: ` +
        `"${registry.recordFor(record.id)?.reason}"). Append-only: it cannot be re-added or overwritten.`,
    );
  }
  return createExclusionRegistry([...registry.records, record]);
}
