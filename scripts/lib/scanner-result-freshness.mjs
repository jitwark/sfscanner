import { boundResults, isPlainObject, resultsDigest, scopeCounts } from './scanner-result-digest.mjs';
import { auditDerivationCoverage, derivationCoverage } from './scanner-result-derivation.mjs';

/**
 * Bind the shipped catalogue's scanner results to a scanner identity.
 *
 * The claim-freshness gate already proves every published graph is drawable. It says nothing about the
 * `security` block, which is a *claim about code we did not write*: 11,464 grades and finding lists,
 * produced by a scanner at some moment in the scanner's history. Nothing bound those numbers to the
 * scanner that produced them, so a scanner change could leave stale verdicts in the catalogue with no
 * gate noticing.
 *
 * Two identities are involved and must not be confused:
 *
 *   - The **engine identity** (`scanner-beta-1`) is the project's own version string, the same one
 *     `check:scanner-goldens` pins in `RELEASE_GOLDEN_IDENTITY`. That is what this gate compares.
 *   - The **recorded result stamp** on the shipped artifacts is `c998701` — a git commit abbreviation from
 *     the legacy `getScannerVersion()` (`git log -1 --format=%h -- app/src/scanner`). It is a build
 *     stamp, not an identity, and it says nothing about which rules ran.
 *
 * So the gate records the engine identity, requires every stamp found on the shipped results — catalogue
 * entries and the manifest metadata alike — to be declared or to equal the current identity, and pins a
 * digest of the bound results so regenerating them requires a deliberate record update.
 */

export const SCANNER_RESULT_FRESHNESS_SCHEMA_VERSION = 'scanner-result-freshness-v1';

/** Read the shipped engine identity out of its source of truth. */
export function readScannerVersionFromSource(sourceText) {
  const match = /SCANNER_VERSION\s*=\s*'([^']+)'/.exec(String(sourceText));
  return match ? match[1] : null;
}

function declaredStamps(record) {
  const stamps = Array.isArray(record?.recordedResultStamps) ? record.recordedResultStamps : [];
  return stamps.filter(isPlainObject);
}

export function auditScannerResultFreshness({
  entries = [],
  record,
  currentScannerVersion,
  manifestScannerVersion,
  searchableCount,
} = {}) {
  const violations = [];
  const report = [];
  const counts = scopeCounts(entries);
  // Measured once: the unverified residual and the derivation coverage are the
  // same reading of the same entries, and comparing one against the other only
  // means something if both come from this array.
  const coverage = derivationCoverage(entries);

  if (!isPlainObject(record)) return { violations: ['scanner-result freshness: no freshness record'], report };
  if (record.schemaVersion !== SCANNER_RESULT_FRESHNESS_SCHEMA_VERSION) {
    violations.push(`scanner-result freshness: record schemaVersion is ${JSON.stringify(record.schemaVersion)}, expected ${SCANNER_RESULT_FRESHNESS_SCHEMA_VERSION}`);
  }

  // --- The binding itself: recorded identity vs the scanner on disk today. ---
  const recorded = record.scannerVersion;
  if (typeof recorded !== 'string' || recorded.length === 0) {
    violations.push('scanner-result freshness: record does not declare a scannerVersion');
  } else if (typeof currentScannerVersion !== 'string' || currentScannerVersion.length === 0) {
    violations.push('scanner-result freshness: current scanner identity could not be read from scanner-core');
  } else if (recorded !== currentScannerVersion) {
    violations.push(`scanner-result freshness: recorded scanner version '${recorded}' does not match the current scanner '${currentScannerVersion}' — results were produced by a different scanner generation; rescan and regenerate the record`);
  } else {
    report.push(['scanner version', `recorded '${recorded}' == current '${currentScannerVersion}'`]);
  }

  // --- Every stamp found on the shipped results must be declared, with a reason. ---
  const stamps = declaredStamps(record);
  const declared = new Set(stamps.map((stamp) => stamp.value));
  for (const stamp of stamps) {
    if (typeof stamp.value !== 'string' || stamp.value.length === 0 || typeof stamp.meaning !== 'string' || stamp.meaning.length === 0) {
      violations.push('scanner-result freshness: a declared result stamp is missing its value or meaning');
    }
  }
  const undeclared = new Map();
  for (const entry of entries) {
    const value = entry?.security?.scannerVersion;
    if (typeof value === 'string' && value.length > 0 && !declared.has(value) && !undeclared.has(value)) undeclared.set(value, entry.id);
  }
  for (const [value, where] of undeclared) {
    violations.push(`scanner-result freshness: undeclared result stamp '${value}' on ${where}`);
  }
  // The manifest carries its own copy of the stamp — it is the value a reader sees without opening a
  // shard — so it is asserted on its own. Checking it only when a catalogue entry happens to share the
  // value would let an edit to `metadata.scannerVersion` alone pass the gate.
  const manifestStamp = typeof manifestScannerVersion === 'string' && manifestScannerVersion.length > 0 ? manifestScannerVersion : null;
  if (manifestStamp !== null) {
    const declaredStamp = declared.has(manifestStamp);
    const isCurrent = manifestStamp === currentScannerVersion;
    if (!declaredStamp && !isCurrent) {
      violations.push(`scanner-result freshness: data/manifest.json metadata.scannerVersion is '${manifestStamp}', which is neither the current scanner '${currentScannerVersion}' nor a declared result stamp (${[...declared].sort().join(', ') || 'none declared'})`);
    }
    report.push(['manifest stamp', `${manifestStamp} (${declaredStamp ? 'declared' : isCurrent ? 'matches the current scanner identity' : 'undeclared'})`]);
  }
  if (stamps.length > 0) {
    report.push(['recorded result stamp', stamps.map((stamp) => `${stamp.value} (${stamp.kind ?? 'unknown kind'})`).join(', ')]);
  }

  // --- The bound results themselves must be unchanged since the record was written. ---
  const digest = resultsDigest(entries);
  if (record.resultsDigest !== digest) {
    violations.push(`scanner-result freshness: shipped results digest ${String(record.resultsDigest).slice(0, 20)} does not match ${digest.slice(0, 20)} for the ${counts.redistributable} redistributable entries — results changed without regenerating the record`);
  } else {
    report.push(['bound results', `${counts.redistributable} redistributable verdicts, ${digest.slice(0, 18)}…`]);
  }

  // --- The bound results must carry the profile the record declares. ---
  // The check binds shipped results to a profile, so it applies only when there
  // is something to bind. After the RULING-2 link-only flip every redistributable
  // row is gone: `profiles.size !== 1` is then unsatisfiable — no declared profile
  // could match — even though "every shipped result carries the declared profile"
  // is vacuously true. Vacuity is therefore decided by the bound-result count, not
  // by the profile set: a bound result with an absent/null/non-string profile
  // leaves that set empty too, and must stay a violation. Whenever any result is
  // bound, the strict test is reached unchanged.
  const bound = boundResults(entries);
  const profiles = new Set(bound.map((item) => item.security?.profile).filter((profile) => typeof profile === 'string'));
  if (bound.length === 0) {
    report.push(['profile', `no redistributable results to bind — profile ${JSON.stringify(record.profile)} not exercised`]);
  } else if (profiles.size !== 1 || !profiles.has(record.profile)) {
    violations.push(`scanner-result freshness: record profile ${JSON.stringify(record.profile)} does not match the shipped profiles ${JSON.stringify([...profiles].sort())}`);
  } else {
    report.push(['profile', `shipped profile ${JSON.stringify(record.profile)} matches the record`]);
  }

  const missingDownload = entries.filter((entry) => entry?.rights?.status === 'redistributable' && !isPlainObject(entry.download)).length;
  if (missingDownload > 0) {
    violations.push(`scanner-result freshness: ${missingDownload} redistributable entries carry no download pointer, so no body can be rescanned`);
  }

  // --- Scope: the two totals that are both correct for their own question. ---
  const scope = isPlainObject(record.scope) ? record.scope : {};
  for (const key of ['total', 'redistributable', 'linkOnly']) {
    if (scope[key] !== counts[key]) {
      violations.push(`scanner-result freshness: record scope.${key} is ${JSON.stringify(scope[key])}, measured ${counts[key]}`);
    }
  }
  if (searchableCount !== undefined && scope.searchable !== searchableCount) {
    violations.push(`scanner-result freshness: record scope.searchable is ${JSON.stringify(scope.searchable)}, measured ${searchableCount}`);
  }
  report.push(['scope', `${counts.total} catalogue entries = ${counts.redistributable} redistributable + ${counts.linkOnly} link-only; ${searchableCount ?? '?'} searchable`]);

  // --- Unverified scope must be marked unverified, not omitted. ---
  const unverified = Array.isArray(record.unverified) ? record.unverified.filter(isPlainObject) : [];
  const linkOnlyMark = unverified.find((item) => item.scope === 'link_only');
  if (!linkOnlyMark) {
    violations.push('scanner-result freshness: link-only results are not marked unverified in the record');
  } else {
    if (linkOnlyMark.status !== 'unverified') {
      violations.push(`scanner-result freshness: link-only scope is marked ${JSON.stringify(linkOnlyMark.status)}, expected 'unverified'`);
    }
    if (linkOnlyMark.count !== coverage.unscannedLinkOnly) {
      // The unverified set is the measured residual, not a fixed total: the
      // regeneration re-derived every link-only entry whose body is retained, so
      // claiming all 11,176 are unverified would overstate what is unknown.
      violations.push(
        `scanner-result freshness: unverified link-only count is ${JSON.stringify(linkOnlyMark.count)}, ` +
        `measured ${coverage.unscannedLinkOnly} link-only entries with no workflow JSON`,
      );
    }
    if (typeof linkOnlyMark.reason !== 'string' || linkOnlyMark.reason.length === 0) {
      violations.push('scanner-result freshness: the unverified link-only scope has no reason');
    }
    report.push(['unverified', `${linkOnlyMark.count} link-only results — ${linkOnlyMark.reason}`]);
  }

  // --- Derivation coverage: which entries know how their facts were produced. ---
  auditDerivationCoverage({ record, coverage, linkOnlyMark, violations, report });

  // --- The recorded rescan must be internally consistent, and is reported. ---
  const rescan = isPlainObject(record.rescan) ? record.rescan : null;
  if (!rescan) {
    violations.push('scanner-result freshness: record has no rescan evidence');
  } else {
    const { bodies, identical, different } = rescan;
    const ids = Array.isArray(rescan.differentIds) ? rescan.differentIds : null;
    if (bodies !== counts.redistributable || !Number.isInteger(identical) || !Number.isInteger(different) || identical + different !== bodies) {
      violations.push(`scanner-result freshness: rescan evidence does not reconcile (bodies=${bodies}, identical=${identical}, different=${different}, redistributable=${counts.redistributable})`);
    } else if (!ids || ids.length !== different || new Set(ids).size !== ids.length) {
      violations.push('scanner-result freshness: rescan difference ids do not match the recorded difference count');
    } else {
      const missing = ids.filter((id) => !entries.some((entry) => entry.id === id));
      if (missing.length > 0) violations.push(`scanner-result freshness: rescan names ${missing.length} id(s) absent from the catalogue`);
      report.push(['rescan', `${bodies} bodies: ${identical} identical, ${different} different${different > 0 ? ` (${ids.slice(0, 3).join(', ')}${different > 3 ? ', …' : ''})` : ''}`]);
      if (typeof rescan.cause === 'string' && rescan.cause.length > 0) report.push(['rescan cause', rescan.cause]);
    }
  }

  return { violations, report };
}
