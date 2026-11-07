/**
 * D-6 (2026-10-17). The result contract refuses text that looks like scanner-internal failure
 * output or credential material — the `SECRET` and `UNSAFE` classes in
 * `contracts/scanner-v2-result.ts`, applied to every text field through `text(value, errors, path)`.
 * That check belongs to the output surface and is deliberately left where it is: it is what keeps a
 * stack trace, a file path or a token out of a published report.
 *
 * A node name is user-chosen display text, though, and `Exception`, `Error: boom` or `Token:` are
 * ordinary labels. Because a label only reaches the result when its node carries a finding, the
 * refusal surfaced as `TOOL_INVARIANT_FAILED` from composition — the workflow got no verdict at all,
 * for a reason unrelated to its security. Five corpus rows sat in that state.
 *
 * The first repair escaped every match of the vocabulary by inserting a backslash after its first
 * character. That broke the *pattern* rather than the *payload*: `Exception` became `E\xception`
 * (fine, it is prose, and the five rescued rows grade), but `sk-live-…` became `s\k-live-…`, which
 * the contract accepts while a reader — or `replaceAll('\\', '')` — recovers the token. A credential
 * must not survive as a puzzle. So the vocabulary is split by what the match actually is:
 *
 * - `CREDENTIAL_NAME`: a credential's field name and separator (`token:`, `api_key=`) is refused by
 *   the gate even with no value behind it, so the whole match is removed. Redacting only values
 *   would leave the declaration and the workflow ungradable.
 * - `CREDENTIAL_VALUE`: the payload (`sk-…`, `AKIA…`, a JWT). The span is replaced with
 *   `[REDACTED]`; it must never ship, escaped or otherwise.
 * - `FAILURE_SHAPED`: prose such as `Exception`, `Error: boom`, `stack trace`. It carries no
 *   payload, but the contract refuses it; it is escaped exactly as before, so the five rescued rows
 *   keep grading and the label stays readable. It is not redacted: a blanket redaction would
 *   rewrite precisely those rows.
 * - `UNSAFE_SHAPE`: a URL, a `..` run or an absolute/drive path. No payload of its own, so it is
 *   escaped exactly as before.
 *
 * The escape is never trusted on its own: `composeScannerResultV2` re-validates the sanitized result
 * against the contract, and fails exactly as it did before whenever the result did not clear it.
 *
 * Locating a finding never depends on the label: every subject carries `ordinal` and
 * `identityDigest`, which are computed before composition and are not touched here, so a redacted
 * name costs a reader nothing but the display text.
 */
const REDACTED = '[REDACTED]';

/** Class 1: a credential's field name and separator. Removed whole — the value is a separate class. */
const CREDENTIAL_NAME = /(?:api[ _-]*key|password|secret|credential|authorization|cookie|bearer|token)\s*[:=]/gi;
/** Class 2: a credential value. Replaced whole — the payload must not survive in any form. */
const CREDENTIAL_VALUE = /\b(?:sk[-_][\w-]+|AKIA[0-9A-Z]{16}|eyJ[\w-]{12,}\.[\w-]{8,})\b/gi;
/** Class 3: failure-shaped prose. Escaped, not redacted (see the header). */
const FAILURE_SHAPED = /\b(?:exception|stack trace|traceback|error:| at [A-Za-z]:[/\\])/gi;
/** Class 4: shapes with no payload of their own. Escaped, as before. */
const UNSAFE_SHAPE = /(?:https?|ftp):\/\/|(?:^|[/\\])\.\.(?:[/\\]|$)|^[/\\]|^[A-Za-z]:[/\\]/gi;

function escapeMatch(match: string): string {
  // A `..` run is escaped dot-by-dot, because inserting a backslash beside a separator only
  // produces another separator that matches again; a one-character match (a leading `/`) is
  // prefixed, because inserting into it cannot remove it.
  if (match.includes('..')) return match.replace(/\./g, '\\.');
  if (match.length === 1) return `_${match}`;
  return `${match[0]}\\${match.slice(1)}`;
}

export function sanitizeDisplayLabel(value: string): string {
  // Order matters: the credential *value* is redacted on the original string first, before any name
  // removal can delete the character its leading `\b` depends on (`db_credential:sk-live_…` used to
  // become `db_sk-live_…`, which neither the value pass nor the contract can see). After that, name
  // removal and value redaction run to a fixed point, because removal can also create new matches:
  // it can splice neighbours into a value shape (`sToken:k-live` → `sk-live`) and it can even
  // recreate a class-1 match (`toToken:ken:` → `token:`).
  //
  // Termination: a name removal strictly shortens the string, so at most `value.length` iterations
  // remove something; a value redaction cannot create a name match (the `[REDACTED]` marker contains
  // no `:`/`=`, and a value span contains none either) nor another value match (the marker contains
  // `[`/`]`, which no value alternative can span), so the first iteration that removes nothing is
  // followed by a no-op and the loop exits. Idempotence: at the fixed point a second call finds no
  // match on the original (no value: the marker cannot contain one) and no removal, and returns the
  // input unchanged.
  let sanitized = value.replace(CREDENTIAL_VALUE, REDACTED);
  for (;;) {
    const next = sanitized.replace(CREDENTIAL_NAME, '').replace(CREDENTIAL_VALUE, REDACTED);
    if (next === sanitized) break;
    sanitized = next;
  }
  // A label that was nothing but the removed declaration (`Token:`, `Authorization:`) would
  // otherwise publish as the empty string. The contract's `text()` accepts empty (verified through
  // the real gate), but empty text is a reader-visible non-answer and this codebase's other text
  // validators reject it (`advisory-admission.ts:63`, `catalogue-resolver.ts:23`), so a label the
  // passes emptied gets the same visible marker as a redacted value. A label that was already empty
  // or whitespace-only is returned untouched: nothing that used to publish is changed.
  const visible = sanitized !== value && sanitized.trim() === '' ? REDACTED : sanitized;
  // One alternative can hand off to another: escaping a leading `../` leaves the label starting
  // with the separator the leading-separator rule owns, and every pass is idempotent once no match
  // is left. Four passes cover every hand-off the two shape classes can produce, and the caller
  // validates the result against the contract rather than trusting this.
  let escaped = visible;
  for (let pass = 0; pass < 4; pass += 1) {
    const next = escaped.replace(FAILURE_SHAPED, escapeMatch).replace(UNSAFE_SHAPE, escapeMatch);
    if (next === escaped) break;
    escaped = next;
  }
  return escaped;
}

/**
 * Q06. Whole-label redaction for a published node-identifier field (`explicitId`, `name`), never
 * arbitrary prose. `api_key_canary_…` names a credential without a `name: value` declaration, so
 * the contract's `SECRET` class cannot see it. The label fields use the non-anchored
 * `redactSecretShapedText` below (a canary can be embedded in a larger label); this anchored helper
 * stays exported for callers that need an exact whole-string match.
 */
const SECRET_SHAPED_IDENTIFIER_BODY = '(?:api[_-]?key|secret|token|password|passwd|credential|authorization|cookie|bearer|access[_-]?key|private[_-]?key)[_-][A-Za-z0-9_-]{6,}';
const SECRET_SHAPED_IDENTIFIER = new RegExp(`^${SECRET_SHAPED_IDENTIFIER_BODY}$`, 'i');
const SECRET_SHAPED_IDENTIFIER_TEXT = new RegExp(SECRET_SHAPED_IDENTIFIER_BODY, 'gi');

export function redactSecretShapedLabel(value: string): string {
  return SECRET_SHAPED_IDENTIFIER.test(value) ? REDACTED : value;
}

/**
 * Q06 presentation. Replaces every secret-shaped label occurrence inside a larger string — a
 * composed node/edge label such as `job-api_key_canary_…`, or derived prose such as a summary
 * highlight that names a node — leaving the surrounding text intact. The matcher is module-scope
 * and global, so reset its cursor before use.
 */
export function redactSecretShapedText(value: string): string {
  SECRET_SHAPED_IDENTIFIER_TEXT.lastIndex = 0;
  return value.replace(SECRET_SHAPED_IDENTIFIER_TEXT, REDACTED);
}

const NODE_LABEL_FIELDS: Record<string, true> = { explicitId: true, name: true };
const FACT_SOURCE_LABEL_FIELDS: Record<string, true> = { sourceNodeId: true, sourceNodeName: true };
const EDGE_LABEL_FIELDS: Record<string, true> = { sourceLabel: true, targetLabel: true };
const isLabelRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * Q06. Redacts secret-shaped labels only on the two ref shapes that publish node text: node refs
 * (`ordinal`+`identityDigest`+`source`, fields `explicitId`/`name`) and edge refs
 * (`sourceLabel`+`connectionType`+`source`, fields `sourceLabel`/`targetLabel`), plus the fact
 * source-node fields. An unrelated `name` — a target package, a workflow name — is display
 * metadata, not a node identifier, and is left alone. The matcher is the non-anchored one: a
 * canary embedded in `job-api_key_canary_…` publishes with the anchored whole-label helper
 * (`redactSecretShapedLabel`, still exported for callers that want an exact match). Only changed
 * paths are copied; every other value and subtree is returned by reference.
 */
export function redactLabelRefs(value: unknown): unknown {
  if (Array.isArray(value)) { const next = value.map(redactLabelRefs); return next.every((item, index) => item === value[index]) ? value : next; }
  if (!isLabelRecord(value)) return value;
  const fields = typeof value.sourceLabel === 'string' && typeof value.connectionType === 'string' && isLabelRecord(value.source)
    ? EDGE_LABEL_FIELDS
    : typeof value.ordinal === 'number' && typeof value.identityDigest === 'string' && isLabelRecord(value.source) ? NODE_LABEL_FIELDS : undefined;
  let changed = false;
  const output = Object.fromEntries(Object.entries(value).map(([key, entry]): [string, unknown] => {
    const next = (fields !== undefined && fields[key] === true || FACT_SOURCE_LABEL_FIELDS[key] === true) && typeof entry === 'string' ? redactSecretShapedText(entry) : redactLabelRefs(entry);
    if (next !== entry) changed = true;
    return [key, next];
  }));
  return changed ? output : value;
}
