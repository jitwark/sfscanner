/**
 * The rights domain: what redistribution status a workflow record carries,
 * and the one place that status is validated.
 *
 * Three known values, never two silently widened at the point of use:
 * `redistributable` (acquired evidence of permission), `link_only` (no
 * redistribution evidence, official link retained), or `excluded` (present in
 * `exclusion-registry.ts`, keyed by the same canonical identity — see that
 * module's doc comment for why exclusion is a registry lookup rather than a
 * rights-decision branch). A value outside this set is a build-time error,
 * not a fallback to `redistributable`: see spec
 * `rights-and-exclusion-registry`, "Unknown Rights Never Default to
 * Redistributable".
 *
 * This was `RightsStatus`/`EntryRights` inline in `index.ts` until `excluded`
 * was added as a third value (2026-08-27); re-exported from there so no
 * import path breaks.
 */
export const RIGHTS_STATUSES = ['redistributable', 'link_only', 'excluded'] as const;

export type RightsStatus = (typeof RIGHTS_STATUSES)[number];

export type EntryRights = {
  status: RightsStatus;
  licence: string | null;
  licenceUrl: string | null;
  /** Human-readable, rendered in the UI. Evidence, not a legal conclusion. */
  reason: string;
};

export function isKnownRightsStatus(value: string): value is RightsStatus {
  return (RIGHTS_STATUSES as readonly string[]).includes(value);
}

/**
 * Throws, naming the offending record, when `status` is not one of the three
 * known values.
 *
 * Called where a release `Entry`'s `rights` field is assembled (never only at
 * export time), so a bad value cannot survive into any downstream artifact —
 * catalogue shard, search index, download pack, or route. There is
 * deliberately no fallback branch here: a value this function does not
 * recognize is exactly the case the requirement exists to catch, and mapping
 * it to `link_only` "to be safe" would hide the same defect the loud failure
 * is meant to surface.
 */
export function assertKnownRightsStatus(status: string, recordId: string): asserts status is RightsStatus {
  if (!isKnownRightsStatus(status)) {
    throw new Error(
      `Unknown rights status "${status}" on record "${recordId}". Rights must be one of: ` +
        `${RIGHTS_STATUSES.join(', ')}. An unrecognized value is a build-time error, never a ` +
        'silent default to "redistributable".',
    );
  }
}
