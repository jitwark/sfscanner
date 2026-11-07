import { FIELD_FLOW_SANITIZER_MODELS_V1 } from '../../../../../contracts/scanner-v2-field-flow';
import type { TaintSinkKind } from './taint-lattice';

type SanitizerEntry = { callee: string; clears: readonly TaintSinkKind[]; reason: string };

const SANITIZER_REASONS: readonly Omit<SanitizerEntry, 'clears'>[] = [
  {
    callee: 'encodeURIComponent',
    reason: 'Percent-encodes CR and LF, so header injection cannot survive, and no HTTP client decodes a header value before sending it. It does not clear PATH or SSRF because the receiving server decodes the URL, restoring traversal and authority delimiters. It does not clear SQL or COMMAND because the apostrophe is left unencoded and can still break out of a quoted context.',
  },
  {
    callee: 'encodeURI',
    reason: 'Preserves the reserved set — slash, question mark, hash, ampersand, semicolon, colon, and the apostrophe — so it neutralizes nothing at any sink.',
  },
  { callee: 'String', reason: 'Type conversion, not escaping. Every injection character survives it.' },
  {
    callee: 'JSON.stringify',
    reason: 'Escapes for a JSON document only. The result still carries quotes and shell metacharacters once it is interpolated anywhere other than JSON.',
  },
  { callee: 'decodeURIComponent', reason: 'Listed so the contract records the decision rather than falling through: decoding can only reintroduce syntax, never remove it.' },
  { callee: 'decodeURI', reason: 'Same as decodeURIComponent — decoding never sanitizes.' },
  {
    callee: 'Number',
    reason: 'Yields a number or NaN. No injection syntax can survive numeric coercion, so the result is safe at every sink including SQL. PROMPT is cleared on a content argument rather than a reversibility one: numeric output carries no injectable text at all. Recorded separately because Phase 8 calibration reviews these reasons, not just the cleared sets.',
  },
  { callee: 'parseInt', reason: 'Numeric coercion, as Number.' },
  { callee: 'parseFloat', reason: 'Numeric coercion, as Number.' },
];

const reviewedModels = new Map<string, (typeof FIELD_FLOW_SANITIZER_MODELS_V1)[number]>(
  FIELD_FLOW_SANITIZER_MODELS_V1.map((model) => [model.callee, model]),
);
const SANITIZERS: readonly SanitizerEntry[] = Object.freeze(SANITIZER_REASONS.map((entry) => {
  const model = reviewedModels.get(entry.callee);
  if (model === undefined) throw new TypeError('Sanitizer model identity is not reviewed');
  return Object.freeze({ callee: entry.callee, clears: model.clears, reason: entry.reason });
}));

const sanitizersByCallee = new Map(SANITIZERS.map((entry) => [entry.callee, entry]));
const NOTHING_SANITIZED: ReadonlySet<TaintSinkKind> = new Set();

export function resolveSanitizedSinks(callee: string | undefined): ReadonlySet<TaintSinkKind> {
  const entry = callee === undefined ? undefined : sanitizersByCallee.get(callee);
  return entry ? new Set(entry.clears) : NOTHING_SANITIZED;
}

export function resolveWrapperChainSanitization(calleesOutermostFirst: readonly string[]): ReadonlySet<TaintSinkKind> {
  return resolveSanitizedSinks(calleesOutermostFirst[0]);
}

export function sanitizerContract(): readonly SanitizerEntry[] {
  return SANITIZERS;
}
