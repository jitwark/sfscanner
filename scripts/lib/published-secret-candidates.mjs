/**
 * Candidate secret values carried by the unsanitized official workflow bodies.
 *
 * Two rule sets are extracted, and they answer different questions:
 *
 * - **strict** — a literal value that is defensible as "a secret": an HTTP
 *   header whose value is a literal basic-auth or bearer token, or a literal
 *   value stored inside a node's `credentials` block. This set is the assertion.
 * - **loose** — the widened sweep: any authorization-shaped `name`/`value`
 *   pair, whatever the value looks like. It over-approximates the strict set by
 *   two orders of magnitude (448 files / 1,072 pairs against 3 files / 4
 *   values), so it is reported separately and never decides the verdict alone.
 *
 * Both rule sets reproduce the phase-4 canary measurement so this gate's counts
 * reconcile with the recorded risk statement rather than restating it:
 * `.superpowers/sdd/2026-09-24-step4-regeneration-canary-report.md`.
 *
 * Extracted values are handed to the caller and are never logged, stored in a
 * fixture, or echoed in an error message: a sweep that prints the secret it
 * found has published it a second time, into output that is retained.
 */

/** Header names that carry a credential, matched as n8n stores them. */
const AUTHORIZATION_HEADER_NAME =
  /^(authorization|auth|x-api-key|api-key|x-auth-token|proxy-authorization|x-api-token|x-access-token)$/i;

/** Credential-block fields that may hold the secret itself, not a reference. */
const CREDENTIAL_VALUE_KEY =
  /^(user|password|pass|secret|token|apikey|api_key|private_key|client_secret|access_token|auth)$/i;

/**
 * An n8n expression is resolved at run time, so it stores no literal. `$env` and
 * `$credentials` are included because they are the reference forms that look
 * least like `{{ }}`.
 */
const EXPRESSION = /\{\{|\$\{|\$json|\$node|\$env|\$credentials/;

/**
 * Documentation placeholders dominate the corpus, and counting one as a secret
 * buries the real ones. These are examples, not data.
 *
 * The two rule sets use the two different placeholder forms their canary
 * measurements used, and the difference is load-bearing rather than sloppy: the
 * strict profile asks "is this string a literal secret", so it rejects a
 * placeholder anywhere in the value; the loose profile asks only "is this pair
 * shaped like a credential", so it rejects a value that *begins* like a
 * placeholder — `<YOUR_API_KEY>`, `your-token-here` — and keeps everything else,
 * including the n8n expressions that the strict profile drops.
 */
const STRICT_PLACEHOLDER = /(your|insert|replace|add|put|sample|example|dummy|test|fake|placeholder|redacted|changeme)/i;
const LOOSE_PLACEHOLDER =
  /^(\{\{|<|\[|your[-_ ]|my[-_ ]|xxx|todo|changeme|placeholder|example|dummy|redacted|abc123|\*{3,}|\.{3,})|(your|insert|replace|add)[-_ ](api[-_ ]?)?(key|token|secret)/i;

const BASIC = /^Basic\s+[A-Za-z0-9+/=]{12,}$/;
const BEARER = /^Bearer\s+[A-Za-z0-9\-._~+/=]{12,}$/;

/**
 * The corpus nests parameter bags about six deep. The bound is a stability
 * guard, not a discovery limit: nothing in the 9,564 bodies is cut off by it.
 */
const MAX_DEPTH = 8;

export const STRICT_RULES = Object.freeze({
  BASIC_HEADER: 'strict:basic-authorization-header',
  BEARER_HEADER: 'strict:bearer-authorization-header',
  CREDENTIAL_VALUE: 'strict:literal-credential-value',
});

export const LOOSE_RULE = 'loose:authorization-shaped-pair';

const STRICT_PREFIX = 'strict:';

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function isExpression(value) {
  return EXPRESSION.test(value);
}

export function isPlaceholder(value) {
  return STRICT_PLACEHOLDER.test(value);
}

/** The loose profile's filter: a value that opens like a placeholder is an example. */
export function isLoosePlaceholder(value) {
  return LOOSE_PLACEHOLDER.test(value);
}

export function isAuthorizationHeaderName(name) {
  return AUTHORIZATION_HEADER_NAME.test(name);
}

export function isCredentialValueKey(key) {
  return CREDENTIAL_VALUE_KEY.test(key);
}

/** A value is literal only when it is neither a run-time reference nor a placeholder. */
export function isLiteralValue(value) {
  return typeof value === 'string' && value.length > 0 && !isExpression(value) && !isPlaceholder(value);
}

/**
 * The candidate index: one row per distinct value, holding the rule classes it
 * was extracted under, the body field paths that carried it, and the bodies it
 * came from. The value itself is the map key so a body that repeats a value
 * dedupes to a single needle.
 */
export function createCandidateIndex() {
  return new Map();
}

function record(index, value, rule, fieldPath, source) {
  if (typeof value !== 'string' || value.length === 0) return;
  let entry = index.get(value);
  if (!entry) {
    entry = { value, rules: new Set(), fieldPaths: new Set(), sources: new Set() };
    index.set(value, entry);
  }
  entry.rules.add(rule);
  entry.fieldPaths.add(fieldPath);
  entry.sources.add(source);
}

/**
 * Walk an object graph and visit every record, with arrays collapsed to `[]` in
 * the path so paths aggregate across the corpus instead of naming one node.
 */
function walk(value, path, depth, visit) {
  if (depth > MAX_DEPTH) return;
  if (isRecord(value)) {
    visit(value, path);
    for (const [key, child] of Object.entries(value)) walk(child, `${path}.${key}`, depth + 1, visit);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) walk(item, `${path}[]`, depth + 1, visit);
  }
}

/** The widened sweep: any authorization-shaped `name`/`value` pair. */
function visitHeaderPair(index, record_, path, source) {
  const name = typeof record_.name === 'string' ? record_.name : '';
  if (!name || !AUTHORIZATION_HEADER_NAME.test(name)) return;
  const value = record_.value;
  if (typeof value !== 'string' || value.length === 0) return;
  const fieldPath = `${path}.value`;
  if (isLiteralValue(value)) {
    if (BASIC.test(value)) record(index, value, STRICT_RULES.BASIC_HEADER, fieldPath, source);
    else if (BEARER.test(value)) record(index, value, STRICT_RULES.BEARER_HEADER, fieldPath, source);
  }
  if (!isLoosePlaceholder(value)) record(index, value, LOOSE_RULE, fieldPath, source);
}

/**
 * A credential block holds either a reference (`id`/`name`) or, in the file the
 * canary found, the literal user and password. Only the literal fields count.
 */
function collectCredentialValues(node, source, index) {
  if (!isRecord(node.credentials)) return;
  for (const [credentialName, definition] of Object.entries(node.credentials)) {
    if (!isRecord(definition)) continue;
    for (const [key, value] of Object.entries(definition)) {
      if (!CREDENTIAL_VALUE_KEY.test(key) || !isLiteralValue(value)) continue;
      record(index, value, STRICT_RULES.CREDENTIAL_VALUE, `workflow.nodes[].credentials.${credentialName}.${key}`, source);
    }
  }
}

/**
 * Collect every candidate one raw body carries.
 *
 * @param {unknown} workflow parsed raw body
 * @param {string} source body file name, the only identity reported
 * @param {Map} index index to fill
 */
export function collectCandidates(workflow, source, index) {
  if (!isRecord(workflow)) return index;
  walk(workflow, 'workflow', 0, (record_, path) => visitHeaderPair(index, record_, path, source));
  const nodes = Array.isArray(workflow.nodes) ? workflow.nodes : [];
  for (const node of nodes) {
    if (isRecord(node)) collectCredentialValues(node, source, index);
  }
  return index;
}

/**
 * Split the index into the assertion and the widened sweep. An entry that is
 * both — a `Basic` header value is a strict class and a loose pair — belongs to
 * strict, and the loose count then excludes it, so the two totals stay
 * independently readable.
 */
export function partitionCandidates(index) {
  const strict = [];
  const loose = [];
  const entries = [...index.values()].sort((a, b) => (a.value < b.value ? -1 : a.value > b.value ? 1 : 0));
  for (const entry of entries) {
    const strictRules = [...entry.rules].filter((rule) => rule.startsWith(STRICT_PREFIX)).sort();
    if (strictRules.length > 0) strict.push({ entry, strictRules });
    else loose.push({ entry, strictRules });
  }
  return { strict, loose };
}

/**
 * Turn the index into the needles the sweep scans for. Ids are positional and
 * the order is the value order, so two runs over the same corpus hand the
 * matcher byte-identical needles in byte-identical order.
 */
export function buildNeedles(index) {
  return [...index.values()]
    .sort((a, b) => (a.value < b.value ? -1 : a.value > b.value ? 1 : 0))
    .map((entry, id) => ({
      id,
      value: entry.value,
      strictRules: [...entry.rules].filter((rule) => rule.startsWith(STRICT_PREFIX)).sort(),
      fieldPaths: [...entry.fieldPaths].sort(),
      sources: [...entry.sources].sort(),
    }));
}

/** The rule classes a matched needle belongs to. The strict class wins when it has one. */
export function ruleClassesOf(needle) {
  return needle.strictRules.length > 0 ? needle.strictRules : [LOOSE_RULE];
}

/** Shape counts for the report: files and field paths, never values. */
export function summarizeCandidates(index) {
  const values = [...index.values()];
  const paths = new Set();
  const sources = new Set();
  const rules = new Map();
  for (const entry of values) {
    for (const path of entry.fieldPaths) paths.add(path);
    for (const source of entry.sources) sources.add(source);
    for (const rule of entry.rules) rules.set(rule, (rules.get(rule) ?? 0) + 1);
  }
  return {
    distinctValues: values.length,
    fieldPaths: [...paths].sort(),
    sources: [...sources].sort(),
    valuesByRule: Object.fromEntries([...rules].sort(([a], [b]) => (a < b ? -1 : 1))),
  };
}
