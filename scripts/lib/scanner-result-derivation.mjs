import { isPlainObject } from './scanner-result-digest.mjs';

/**
 * Derivation coverage: which shipped entries declare how their facts were
 * produced, and whether the freshness record's claims about them hold.
 *
 * `readiness.analysis` is the published marker — `derived` when a workflow body
 * produced the readiness report, `unscanned` when none was available — and it is
 * read off the artifacts rather than trusted from the record. That is what lets
 * the gate state "1,684 official entries are explicitly unscanned" as a
 * measurement instead of a claim, and what keeps a future run from republishing
 * an empty credential list that reads as "needs nothing".
 *
 * `scanner-result-freshness.mjs` owns the audit that calls into this module.
 */

/**
 * The readiness derivation state every shipped entry must declare.
 *
 * Readiness labels a report as `derived` when a workflow body produced it and
 * `unscanned` when none was available. It is a closed vocabulary here, not a
 * free string: an unreadable value is a missing marker, not a third state.
 */
const READINESS_ANALYSES = new Set(['derived', 'unscanned']);

/**
 * What the shipped entries say about how their facts were produced.
 *
 * A missing marker is the defect this measures: an empty credential list with
 * nothing to qualify it is indistinguishable from "this workflow needs no
 * credentials", and that is a false-clean claim.
 */
export function derivationCoverage(entries) {
  const missing = [];
  let derived = 0;
  let unscanned = 0;
  let unscannedOfficial = 0;
  let unscannedLinkOnly = 0;
  for (const entry of entries) {
    const analysis = entry?.readiness?.analysis;
    if (!READINESS_ANALYSES.has(analysis)) {
      if (missing.length < 10) missing.push(entry?.id ?? '(missing id)');
      continue;
    }
    if (analysis === 'derived') {
      derived += 1;
      continue;
    }
    unscanned += 1;
    if (entry?.source?.kind === 'n8n_official') unscannedOfficial += 1;
    if (entry?.rights?.status === 'link_only') unscannedLinkOnly += 1;
  }
  return { derived, unscanned, unscannedOfficial, unscannedLinkOnly, missing, total: entries.length };
}

/**
 * Check the record's recorded derivation block against the measured coverage.
 *
 * Every shipped entry must declare whether a workflow body produced its
 * readiness report, and the record must name the scopes it counted. Both the
 * measurement and the claim are required: a count that matches the artifacts is
 * the only thing that makes "unscanned" a state rather than an excuse.
 */
export function auditDerivationCoverage({ record, coverage, linkOnlyMark, violations, report }) {
  if (coverage.missing.length > 0) {
    violations.push(
      `scanner-result freshness: ${coverage.missing.length >= 10 ? 'at least 10' : coverage.missing.length} ` +
      `entr(y|ies) carry no readiness.analysis marker (readiness is published state, not an internal note): ${coverage.missing.join(', ')}`,
    );
  }
  const derived = isPlainObject(record.derivation) ? record.derivation.verified : null;
  const unscanned = isPlainObject(record.derivation) ? record.derivation.unscanned : null;
  if (!isPlainObject(derived) || !isPlainObject(unscanned)) {
    violations.push('scanner-result freshness: record has no derivation coverage block (verified/unscanned counts)');
  } else {
    if (derived.status !== 'verified' || derived.count !== coverage.derived) {
      violations.push(
        `scanner-result freshness: derivation.verified is ${JSON.stringify(derived.status)}/${JSON.stringify(derived.count)}, measured ${coverage.derived} entries with readiness.analysis 'derived'`,
      );
    }
    if (unscanned.status !== 'unscanned' || unscanned.count !== coverage.unscanned) {
      violations.push(
        `scanner-result freshness: derivation.unscanned is ${JSON.stringify(unscanned.status)}/${JSON.stringify(unscanned.count)}, measured ${coverage.unscanned} entries with readiness.analysis 'unscanned'`,
      );
    }
    const byScope = isPlainObject(unscanned.byScope) ? unscanned.byScope : {};
    if (byScope.official_without_body !== coverage.unscannedOfficial) {
      violations.push(
        `scanner-result freshness: derivation.unscanned.byScope.official_without_body is ${JSON.stringify(byScope.official_without_body)}, measured ${coverage.unscannedOfficial} official entries with no workflow JSON`,
      );
    }
    if (byScope.community_link_only_without_body !== coverage.unscannedLinkOnly - coverage.unscannedOfficial) {
      violations.push(
        `scanner-result freshness: derivation.unscanned.byScope.community_link_only_without_body is ${JSON.stringify(byScope.community_link_only_without_body)}, measured ${coverage.unscannedLinkOnly - coverage.unscannedOfficial}`,
      );
    }
    if (typeof unscanned.reason !== 'string' || unscanned.reason.length === 0) {
      violations.push('scanner-result freshness: derivation.unscanned has no stated reason');
    }
    report.push([
      'derivation',
      `${coverage.derived} entries re-derived from an authorized body; ${coverage.unscanned} with no workflow JSON ` +
      `(${coverage.unscannedOfficial} official, ${coverage.unscannedLinkOnly - coverage.unscannedOfficial} community link-only)`,
    ]);
    if (isPlainObject(linkOnlyMark) && linkOnlyMark.count !== coverage.unscannedLinkOnly) {
      violations.push(
        `scanner-result freshness: unverified link-only count is ${JSON.stringify(linkOnlyMark.count)}, ` +
        `measured ${coverage.unscannedLinkOnly} link-only entries with no workflow JSON — the unverified set is exactly what could not be re-derived`,
      );
    }
  }
}
