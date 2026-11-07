/**
 * Every contact detail the legal pages need, in one file, so a maintainer fills
 * one thing rather than hunting through prose.
 *
 * `PENDING` is deliberate and load-bearing. The 2026-08-25 audit found the only
 * removal channel on the site was a dead link; replacing it with invented
 * details would be worse. A field left `PENDING` renders as a visible
 * "not yet published" notice, and `takedown-copyright.test.tsx` fails the
 * suite if a page claims DMCA safe-harbour compliance while the agent block
 * is unfilled (`legal-contacts.test.ts` covers the underlying predicates'
 * boundaries). Separately, `scripts/check-legal-identity.mjs` fails the real
 * GitHub Pages deploy build (via `npm run release:gates`, not local
 * dev/test/build) if any field below is still `PENDING` — see that script for
 * the production signal it gates on.
 *
 * The general contact is published below for routine requests and private
 * privacy/security matters. The designated-agent block remains PENDING until
 * an actual agent and registration decision exists; this site makes no safe-
 * harbour claim while it is unfilled.
 */

export const PENDING = 'PENDING' as const;

export type PendingOr<T> = T | typeof PENDING;

/** Who operates the site: the repository owner. Required by GDPR Art. 13/14. */
export const operator: PendingOr<string> = 'jitwark (repository owner)';

/** General contact. Must accept mail from someone with no GitHub account. */
export const contactEmail: PendingOr<string> = 'voidsyntax01@gmail.com';

/** Public intake for routine requests that contain no personal or sensitive data. */
export const publicRequestEmailUrl =
  'mailto:voidsyntax01@gmail.com?subject=SecureFlow%20takedown%20request';

/**
 * DMCA designated agent. 17 U.S.C. 512(c)(2) requires name, physical address,
 * telephone number and email to be published in a publicly accessible location
 * AND registered with the Copyright Office.
 */
export const dmcaAgent: {
  name: PendingOr<string>;
  address: PendingOr<string>;
  phone: PendingOr<string>;
  email: PendingOr<string>;
} = {
  name: PENDING,
  address: PENDING,
  phone: PENDING,
  email: PENDING,
};

/** ISO date the agent designation was registered. Expires three years later. */
export const dmcaAgentRegisteredAt: PendingOr<string> = PENDING;

export function isPending(value: PendingOr<string>): boolean {
  return typeof value !== 'string' || value === PENDING || value.trim().length === 0;
}

/**
 * Registration dates are deliberately strict: a malformed, future, or
 * three-year-old registration must not enable a safe-harbour claim.
 */
export function isValidDmcaRegistrationDate(
  value: PendingOr<string>,
  now: Date = new Date(),
): boolean {
  if (isPending(value) || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;

  const registeredAt = new Date(`${value}T00:00:00.000Z`);
  if (
    Number.isNaN(registeredAt.valueOf()) ||
    registeredAt.toISOString().slice(0, 10) !== value ||
    registeredAt > now
  ) {
    return false;
  }

  const expiresAt = new Date(registeredAt);
  expiresAt.setUTCFullYear(expiresAt.getUTCFullYear() + 3);
  return now < expiresAt;
}

/**
 * True only when every field a 512(c) safe-harbour claim depends on is filled.
 * Accepts an agent to check (defaulting to the real `dmcaAgent`) so tests can
 * exercise the all-filled / one-still-PENDING boundary without mutating the
 * module's live constants.
 */
export function dmcaAgentIsPublished(agent: {
  name: PendingOr<string>;
  address: PendingOr<string>;
  phone: PendingOr<string>;
  email: PendingOr<string>;
} = dmcaAgent,
  registeredAt: PendingOr<string> = dmcaAgentRegisteredAt,
  now: Date = new Date(),
): boolean {
  return (
    !isPending(agent.name) &&
    !isPending(agent.address) &&
    !isPending(agent.phone) &&
    !isPending(agent.email) &&
    isValidDmcaRegistrationDate(registeredAt, now)
  );
}

/** The date these terms were last substantively changed. */
export const lastUpdated = '2026-10-17';
