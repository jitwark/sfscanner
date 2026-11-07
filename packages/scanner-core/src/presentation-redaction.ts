import { redactText } from './redaction/redaction';
import { redactSecretShapedText } from './result-v2/display-label';

/**
 * R6-F2. Redaction removes secrets but said nothing about length, so a
 * user-controlled string arrived at the JSON sinks at whatever size it was
 * authored. `AnalysisDiagnostic.location.path` is a JSON pointer built from raw
 * node names, and a 5,000-character node name produced a 5,028-character
 * pointer in the browser's downloadable report and the CLI's `--format=json`.
 *
 * The SARIF exporter already bounded these (240 for `path`, 160 for
 * `nodeName`/`nodeId`), so the two JSON sinks were the asymmetric ones. Bound
 * them here, at the shared boundary every sink passes through, rather than
 * repeating the cap per exporter — SARIF's own bound then becomes belt and
 * braces rather than the only guard.
 *
 * Only location-ish fields are bounded. Findings' evidence and display text are
 * deliberately left alone: they have their own truncation rules, and silently
 * shortening them here would change what a report says a policy found.
 */
const LOCATION_FIELD_LIMITS: Readonly<Record<string, number>> = {
  path: 240,
  nodeName: 160,
  nodeId: 160,
};

const TRUNCATION_SUFFIX = '…';

/**
 * Q06. Node ids/names and edge endpoint labels are identifiers, not prose: an
 * `api_key_canary_…`-shaped one names a credential without a `name: value` declaration, so the
 * generic secret patterns cannot see it. Composition already applies the non-anchored
 * `redactSecretShapedText` to those fields; this reapplication covers a caller that hands the
 * presentation layer a result produced before that redaction. The matcher is unanchored because a
 * canary can be embedded in a larger label (`job-api_key_canary_…` publishes as `job-[REDACTED]`).
 * `nodeId`/`nodeName` are the v1 location's copies of the same node text. Derived prose gets the
 * same rule too, but only in the report's free-text fields: the rule also matches machine tokens —
 * `RAW_SECRET_INDICATOR` is a rule id and `SECRET_INDICATOR` a fact enum — which consumers still
 * require verbatim. A `name` outside a node/edge ref is display metadata and is left alone by the
 * label rule.
 */
const SECRET_SHAPED_LABEL_FIELDS: Readonly<Record<string, true>> = {
  explicitId: true,
  sourceLabel: true,
  targetLabel: true,
  nodeId: true,
  nodeName: true,
  sourceNodeId: true,
  sourceNodeName: true,
};

/** The report's reader-facing prose. Machine identifiers and enum tokens must survive verbatim. */
const SECRET_SHAPED_PROSE_FIELDS: Readonly<Record<string, true>> = {
  headline: true,
  verdict: true,
  riskNarrative: true,
  recommendedActions: true,
  findingHighlights: true,
  title: true,
  message: true,
  explanation: true,
  whyItMatters: true,
  possibleImpact: true,
  remediation: true,
  remediationSteps: true,
  basicPurpose: true,
  triggerDescription: true,
  dataFlowSummary: true,
  usage: true,
  riskNotes: true,
  topRisks: true,
  dataExposure: true,
  complexityDrivers: true,
};

/** The ref predicates of canonical composition's `redactLabelRefs`: only these `name`s are node text. */
const isLabelRef = (value: Record<string, unknown>): boolean => {
  const source = value.source;
  const hasSource = typeof source === 'object' && source !== null && !Array.isArray(source);
  return typeof value.sourceLabel === 'string' && typeof value.connectionType === 'string' && hasSource
    || typeof value.ordinal === 'number' && typeof value.identityDigest === 'string' && hasSource;
};

/** Redacts every string in a scanner result without changing its object shape. */
export function redactScanPresentation<T>(value: T): T {
  return redactStrings(value) as T;
}

function boundLocationField(key: string, value: string): string {
  const limit = LOCATION_FIELD_LIMITS[key];
  if (limit === undefined || value.length <= limit) return value;
  return value.slice(0, limit - TRUNCATION_SUFFIX.length) + TRUNCATION_SUFFIX;
}

function redactStrings(value: unknown, key?: string, label = false): unknown {
  if (typeof value === 'string') {
    const labelled = label || (key !== undefined && SECRET_SHAPED_LABEL_FIELDS[key] === true)
      ? redactSecretShapedText(value)
      : value;
    const redacted = key !== undefined && SECRET_SHAPED_PROSE_FIELDS[key] === true
      ? redactSecretShapedText(labelled)
      : labelled;
    return key === undefined ? redactText(redacted) : boundLocationField(key, redactText(redacted));
  }
  if (Array.isArray(value)) return value.map((child) => redactStrings(child, key));
  if (typeof value !== 'object' || value === null) return value;
  const record = value as Record<string, unknown>;
  const labelRef = isLabelRef(record);
  return Object.fromEntries(
    Object.entries(record).map(([childKey, child]) => [
      childKey,
      redactStrings(child, childKey, childKey === 'name' && labelRef),
    ]),
  );
}
