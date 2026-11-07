import { PROVIDER_TOKEN_PATTERNS, redactionPattern } from '../provider-token-patterns';
import {
  REDACTED,
  isPiiContainerKey,
  isStickyNoteRecord,
  redactContextualPii,
  redactStructuredUrlText,
} from './structured-redaction';

export type ScannerFinding = {
  policyId: string;
  title: string;
  severity: string;
  location: {
    nodeId?: string;
    nodeName?: string;
    path?: string;
    sourceSpan?: unknown;
  };
  evidence: Record<string, unknown>;
  message: string;
  explanation: string;
  whyItMatters: string;
  possibleImpact: string;
  remediation: string;
  remediationSteps: string[];
  confidence: string;
};

const sensitiveKeyPatterns = [
  /authorization/i, /^auth$/i, /api[-_ ]?key/i, /access[-_ ]?token/i,
  /refresh[-_ ]?token/i, /id[-_ ]?token/i, /token$/i, /secret/i, /password/i,
  /passwd/i, /^pass(?:phrase)?$/i, /^pwd$/i, /credential/i, /cookie/i,
  /private[-_ ]?key/i, /client[-_ ]?secret/i,
];
const PAIRED_SENSITIVE_FIELDS: Readonly<Record<string, true>> = {
  value: true, val: true, headervalue: true, content: true,
};
// `redactionPattern` already returns a global (`/g`, `/gi`) matcher, so compile each pattern once
// here instead of rebuilding an equivalent RegExp on every call, pattern and string.
const sensitiveValueMatchers = PROVIDER_TOKEN_PATTERNS
  .filter((entry) => entry.surfaces.some((surface) => surface === 'redact'))
  .map(redactionPattern);

export function redactFinding(finding: ScannerFinding): ScannerFinding {
  return {
    ...finding,
    title: redactText(finding.title),
    location: {
      nodeId: redactOptionalText(finding.location.nodeId),
      nodeName: redactOptionalText(finding.location.nodeName),
      path: redactOptionalText(finding.location.path),
    },
    evidence: redactEvidence(finding.evidence),
    message: redactText(finding.message),
    explanation: redactText(finding.explanation),
    whyItMatters: redactText(finding.whyItMatters),
    possibleImpact: redactText(finding.possibleImpact),
    remediation: redactText(finding.remediation),
    remediationSteps: finding.remediationSteps.map(redactText),
  };
}

export function redactEvidence<T>(value: T): T {
  return redactValue(value, undefined, false) as T;
}

export function redactWorkflowJson(raw: string): string {
  return JSON.stringify(redactValue(JSON.parse(raw), undefined, false));
}

export function redactText(value: string): string {
  return sensitiveValueMatchers.reduce((redacted, matcher) => {
    // The matcher is module-scope and stateful (`/g`), so reset its cursor before every use; a
    // leaked `lastIndex` would make a later call skip the match at the stale offset.
    matcher.lastIndex = 0;
    return redacted.replace(matcher, REDACTED);
  }, redactStructuredUrlText(value));
}

function redactValue(value: unknown, key: string | undefined, piiContext: boolean): unknown {
  if (isSensitiveKey(key)) return REDACTED;
  if (typeof value === 'string') {
    const redacted = redactText(value);
    return piiContext ? redactContextualPii(redacted) : redacted;
  }
  if (Array.isArray(value)) return value.map((child) => redactValue(child, undefined, piiContext));
  if (!isRecord(value)) return value;
  return redactRecord(value, piiContext);
}

function redactRecord(value: Record<string, unknown>, piiContext: boolean): Record<string, unknown> {
  const sensitiveName = getSensitiveNameValue(value);
  const nextPiiContext = piiContext || isStickyNoteRecord(value);
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [
    key,
    sensitiveName !== null && PAIRED_SENSITIVE_FIELDS[key.toLowerCase()] === true
      ? REDACTED
      : redactValue(child, key, nextPiiContext || isPiiContainerKey(key)),
  ]));
}

function getSensitiveNameValue(value: Record<string, unknown>): string | null {
  const name = value.name;
  return typeof name === 'string' && isSensitiveKey(name.trim()) ? name.trim() : null;
}

function isSensitiveKey(key: string | undefined): boolean {
  return Boolean(key && key !== 'secretKind' && sensitiveKeyPatterns.some((pattern) => pattern.test(key)));
}

function redactOptionalText(value: string | undefined): string | undefined {
  return value === undefined ? undefined : redactText(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
