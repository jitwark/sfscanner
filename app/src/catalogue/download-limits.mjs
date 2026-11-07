/**
 * The one bound on the full-pack download fallback, in plain JavaScript so the
 * browser bundle (`download.ts`) and the release gate
 * (`scripts/check-rights-invariant.mjs`) read the same number.
 *
 * The bound applies only to the fallback path — a host that ignores Range and
 * makes the reader take the whole pack. A verified `206` for a pack larger than
 * this is still a legitimate download, which is why the check sits after the
 * ranged attempt rather than at the top of the function.
 */
export const MAX_FALLBACK_PACK_BYTES = 32 * 1024 * 1024;
