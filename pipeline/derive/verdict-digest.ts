import { createHash } from 'node:crypto';
import type { EntrySecurity } from '@hub/contracts';
import { canonicalizeJsonForHash } from '../dedup/signatures.js';
import type { VerdictProjection } from './verdict-adjudication.js';

/** The published-verdict half of a scanner result: what the digest covers. */
export function projectionOf(security: EntrySecurity): VerdictProjection {
  return {
    grade: security.grade,
    score: security.score,
    counts: security.counts,
    findings: security.findings,
    hardenedExtra: security.hardenedExtra,
    profile: security.profile,
    schemaVersion: security.schemaVersion,
  };
}

/**
 * Digest of the verdict a reader sees.
 *
 * Stability comes from `canonicalizeJsonForHash` over an object built in a fixed
 * key order, with findings themselves ordered by their canonical form. The stamp
 * and `analysisStatus` are excluded: the shipped legacy rows predate both, and a
 * digest that moved because the contract did would not be a verdict digest.
 */
export function digestVerdict(projection: VerdictProjection): string {
  const findings = projection.findings
    .map((finding) => ({ id: finding.id, severity: finding.severity, node: finding.node ?? null, why: finding.why, fix: finding.fix }))
    .sort((left, right) => (canonicalizeJsonForHash(left) < canonicalizeJsonForHash(right) ? -1 : 1));
  const canonical = canonicalizeJsonForHash({
    grade: projection.grade,
    score: projection.score,
    counts: {
      critical: projection.counts.critical,
      high: projection.counts.high,
      medium: projection.counts.medium,
      low: projection.counts.low,
      info: projection.counts.info,
    },
    hardenedExtra: projection.hardenedExtra,
    profile: projection.profile,
    schemaVersion: projection.schemaVersion ?? null,
    findings,
  });
  return `sha256:${createHash('sha256').update(canonical, 'utf8').digest('hex')}`;
}
