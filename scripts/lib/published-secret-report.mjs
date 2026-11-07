/**
 * What the published-secret gate reports on, and how it names it.
 *
 * Three jobs live here because they are one job seen three times: enumerating the
 * published artifacts the sweep will read, counting the candidate set the report
 * describes, and turning a byte-level match into the triple a reviewer can act on
 * — artifact, field path, rule class.
 *
 * **A finding never carries a candidate value.** A leak gate that printed the
 * secret it found has published it a second time, into output retained for
 * weeks, so triage is carried by shape: a length, an expression flag, and the
 * field paths the value was extracted from.
 */
import fs from 'node:fs';
import path from 'node:path';
import { isExpression, ruleClassesOf, summarizeCandidates } from './published-secret-candidates.mjs';
import { listArtifactFiles } from './published-secret-sweep.mjs';

/** Every published surface the gate must read. Absent roots are reported, not silently skipped. */
export const ARTIFACT_ROOTS = Object.freeze([
  'data',
  'app/public/data',
  'app/out',
  'outputs',
]);

/** Project-relative when the target is inside the workspace; absolute when it is not. */
export function relative(root, target) {
  const rel = path.relative(root, target).replace(/\\/g, '/');
  return rel.startsWith('..') ? target.replace(/\\/g, '/') : rel;
}

/**
 * Resolve the artifact roots and measure them.
 *
 * @param {{root: string, override?: string}} input `override` is a `;`-separated root
 *   list, which is how the gate's own tests sweep a temporary directory instead of the corpus.
 */
export function artifactSet({ root, override }) {
  const roots = override ? override.split(';') : ARTIFACT_ROOTS.map((entry) => path.join(root, entry));
  const present = [];
  const missing = [];
  for (const candidate of roots) {
    const resolved = path.resolve(candidate);
    if (fs.existsSync(resolved)) present.push(resolved);
    else missing.push(relative(root, resolved));
  }
  const files = listArtifactFiles(present);
  let bytes = 0;
  for (const file of files) bytes += fs.statSync(file).size;
  return { present, missing, files, bytes };
}

/**
 * The candidate counts the report prints, taken from the built needles rather than
 * the index, so they describe exactly what was swept: the strict/loose split, the
 * needles below the sweep floor, and the subset long enough for the sweep to scan.
 *
 * @param {object[]} needles the built needles
 * @param {number} floor the sweep's minimum needle length
 */
export function summarizeNeedles(needles, floor) {
  const summarize = (subset) => summarizeCandidates(new Map(subset.map((needle) => [needle.value, {
    value: needle.value,
    rules: ruleClassesOf(needle),
    fieldPaths: needle.fieldPaths,
    sources: needle.sources,
  }])));
  const sweepable = needles.filter((needle) => needle.value.length >= floor);
  const below = (strict) => needles.filter((needle) => (needle.strictRules.length > 0) === strict && needle.value.length < floor).length;
  return {
    sweepNeedles: sweepable,
    strict: summarize(needles.filter((needle) => needle.strictRules.length > 0)),
    loose: summarize(needles.filter((needle) => needle.strictRules.length === 0)),
    belowFloor: { total: needles.length - sweepable.length, strict: below(true), loose: below(false) },
  };
}

/**
 * Render the human-readable report. It reads only the summary, so the JSON and
 * the prose are two views of one object and cannot drift apart.
 */
export function renderSummary(summary) {
  const { candidates, artifactsSwept, positiveControl, bodiesScanned, bodiesDir } = summary;
  const lines = [
    `Raw bodies: ${bodiesScanned} in ${bodiesDir}`,
    `  strict candidates: ${candidates.strict.distinctValues} distinct values across ${candidates.strict.sourceBodies} bodies`,
  ];
  for (const [rule, count] of Object.entries(candidates.strict.valuesByRule)) lines.push(`    ${rule}: ${count}`);
  lines.push(`  loose candidates:  ${candidates.loose.distinctValues} distinct values across ${candidates.loose.sourceBodies} bodies`);
  for (const [rule, count] of Object.entries(candidates.loose.valuesByRule)) lines.push(`    ${rule}: ${count}`);
  lines.push(
    `  strict field paths: ${candidates.strict.fieldPaths.join(', ')}`,
    `  loose field paths:  ${candidates.loose.fieldPaths.join(', ')}`,
    `  needles swept: ${candidates.needlesSwept} of ${candidates.distinctNeedles} ` +
      `(below the ${candidates.sweepFloor}-character floor: ${candidates.belowSweepFloor.total})`,
    `Artifacts: ${artifactsSwept.files} files / ${artifactsSwept.bytes} bytes`,
  );
  for (const root of artifactsSwept.roots) lines.push(`  swept ${root}`);
  for (const root of artifactsSwept.missingRoots) lines.push(`  absent (not swept) ${root}`);
  lines.push(
    `Positive control: ${positiveControl.detectedValues}/${positiveControl.plantedValues} planted values detected; ` +
    `strict classes ${positiveControl.strictClasses.join(', ')}; ` +
    `loose class ${positiveControl.looseClasses.join(', ')}; ` +
    `line artifact ${positiveControl.lineArtifactDetected ? 'detected' : 'NOT detected'}`,
  );
  return lines.join('\n');
}

/**
 * Render the findings. Every line names an artifact, a field path and a rule
 * class, and never a value: this text lands in retained output.
 */
export function renderFindings({ strict, looseOnly }) {
  const lines = strict.map((finding) => `  LEAK ${finding.artifact} ${finding.fieldPath} ${finding.ruleClass}`);
  if (looseOnly.length === 0) return lines.join('\n');
  lines.push(
    `Widened sweep (reported, not asserted): ${looseOnly.length} match(es) under ${looseOnly[0].ruleClass}.`,
  );
  for (const finding of looseOnly) {
    lines.push(
      `  ${finding.artifact} ${finding.fieldPath} ${finding.ruleClass} ` +
      `len=${finding.needleLength} expression=${finding.needleIsExpression} bodies=${finding.sourceBodyCount}`,
    );
  }
  lines.push(
    '  The loose set over-approximates the strict set by two orders of magnitude by design; ' +
    'only the strict set is defensible as "a secret", so only it decides the verdict.',
  );
  return lines.join('\n');
}

/**
 * Split matches into the assertion and the widened sweep.
 *
 * @param {{matches: {file: string, needleIds: number[]}[], needles: object[], root: string, resolve: Function}} input
 *   `resolve` is the sweep's structural resolver; it is injected so the red path
 *   can be exercised without a real artifact on disk.
 */
export function reportMatches({ matches, needles, root, resolve }) {
  const findings = matches
    .flatMap((match) => resolve({ file: match.file, needleIds: match.needleIds, needles })
      .map((located) => {
        const needle = needles[located.needleId];
        const classes = ruleClassesOf(needle);
        return {
          artifact: relative(root, match.file),
          fieldPath: located.fieldPath,
          ruleClasses: classes,
          ruleClass: classes[0],
          strict: needle.strictRules.length > 0,
          needleLength: needle.value.length,
          needleIsExpression: isExpression(needle.value),
          extractionFieldPaths: needle.fieldPaths,
          sourceBodies: needle.sources.slice(0, 10),
          sourceBodyCount: needle.sources.length,
        };
      }))
    .sort((a, b) => (a.artifact + a.fieldPath + a.ruleClass < b.artifact + b.fieldPath + b.ruleClass ? -1 : 1));
  return {
    strict: findings.filter((finding) => finding.strict),
    looseOnly: findings.filter((finding) => !finding.strict),
  };
}
