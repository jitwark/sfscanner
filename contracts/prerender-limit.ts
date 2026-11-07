/**
 * How many detail pages Next pre-renders, in one place.
 *
 * This number was written three times: `enrich-corpus.ts` bakes
 * `entry.isPrerendered` from it, `app/src/catalogue/prerender-list.ts` decides
 * `generateStaticParams` from it, and `scripts/refresh-published-metadata.ts`
 * hard-coded `.slice(0, 250)`.
 *
 * They agreed by coincidence, and the cost of disagreeing went up on
 * 2026-08-26. `isPrerendered` used to decide *where* a workflow link pointed,
 * and a wrong value sent a reader to a page that existed anyway. It now decides
 * *how*, through `isClientRoutable`: a `<Link>` to a page Next did not write
 * asks for two RSC sidecars that do not exist, which is a 404 per card on every
 * page that lists results. Silent, and exactly the defect that took two e2e
 * tests to find.
 *
 * `indexableSlugs()` prefers the baked field when it is present, so the corpus
 * wins over the environment — which is why the two must be derived from one
 * expression rather than kept in step by hand.
 */
export const PRERENDER_DETAIL_LIMIT_DEFAULT = 250;

/**
 * The limit this process should use, honouring the environment override.
 *
 * `env` has no default here — `contracts/` is swept for Node-only globals
 * since it is bundled into the browser, so every caller must supply its own
 * environment variables explicitly.
 */
export function resolvePrerenderLimit(env: Record<string, string | undefined>): number {
  const raw = env.PRERENDER_DETAIL_LIMIT ?? env.PRERENDER_LIMIT;
  if (raw === undefined || raw === '') return PRERENDER_DETAIL_LIMIT_DEFAULT;

  const parsed = Number.parseInt(raw, 10);
  return Number.isNaN(parsed) || parsed <= 0 ? PRERENDER_DETAIL_LIMIT_DEFAULT : parsed;
}
