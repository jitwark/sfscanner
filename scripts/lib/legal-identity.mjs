/**
 * Pure logic for `check:legal-identity` (scripts/check-legal-identity.mjs).
 * Kept side-effect-free and testable, matching the scripts/lib/spec-validate.mjs
 * pattern: the CLI script does I/O and calls these, tests call these directly.
 */

const SCALAR_FIELDS = ['operator', 'contactEmail'];

/**
 * This repo's only real "this is the production deploy" signal. Confirmed
 * against `../../.github/workflows/deploy.yml` (standalone repo root): it is the
 * only workflow that sets either variable, and it sets both, as job-level env,
 * before running `npm run release:gates`. `ci.yml`'s per-push `gates` job sets
 * neither, and no local dev/build/test invocation does either — so `NODE_ENV`
 * is not a safe signal here (every `next build` sets that, including a local
 * one), but these two env vars are.
 */
export function isProductionRelease(env) {
  if (!env || typeof env !== 'object') return false;

  // The deploy workflow currently supplies both public URL values. GitHub's
  // immutable Actions context is the conservative fallback: if those values
  // are accidentally omitted from a release job, the gate must not silently
  // downgrade that job to local development. `gates` does not call this check.
  return Boolean(env.NEXT_PUBLIC_BASE_PATH || env.NEXT_PUBLIC_SITE_URL)
    || env.GITHUB_ACTIONS === 'true';
}

/**
 * Extracts a top-level `export const <name>: PendingOr<string> = <value>;`
 * assignment's right-hand side from `legal-contacts.ts` source text, without
 * importing/executing the module (this script stays plain-node, matching the
 * no-build-step convention every other `check:*` script follows).
 */
function scalarFieldValue(source, name) {
  const match = source.match(new RegExp(`export const ${name}:[^;=]*=\\s*([^;]+);`));
  return match ? match[1].trim() : undefined;
}

function literalValue(value) {
  const match = value?.match(/^(['"])([\s\S]*)\1$/);
  return match ? match[2] : value;
}

function isBlank(value) {
  return typeof value === 'string' && literalValue(value).trim() === '';
}

/**
 * Returns a list of human-readable failure strings — one per field that is
 * either still the literal `PENDING` sentinel or could not be located at all
 * (a located-but-unreadable field fails loud rather than silently passing).
 * An empty array means every legal-identity field is filled.
 */
export function findPendingLegalFields(source) {
  const failures = [];

  for (const name of SCALAR_FIELDS) {
    const value = scalarFieldValue(source, name);
    if (value === undefined) {
      failures.push(`${name}: could not locate its declaration in legal-contacts.ts`);
    } else if (literalValue(value) === 'PENDING') {
      failures.push(`${name} is still PENDING`);
    } else if (isBlank(value)) {
      failures.push(`${name} is blank`);
    }
  }

  // The product decision is to make no DMCA section 512(c) safe-harbour claim.
  // The optional designated-agent block is therefore intentionally excluded
  // from the production identity gate; the UI still renders it as unpublished.
  return failures;
}

/**
 * Reads the existing owner decision packet's production-release row. Contact
 * details prove reachability only; they are not permission to publish. Exact
 * matching prevents values such as "yes", "not approved", or a partial note
 * from being interpreted as release approval.
 */
export function findReleaseApprovalFailures(source) {
  if (typeof source !== 'string') {
    return ['Production promotion allowed: decision record could not be read'];
  }

  const match = source.match(/^\|\s*Production promotion allowed\s*\|\s*([^|\r\n]*)\s*\|/im);
  if (!match) return ['Production promotion allowed: could not locate its decision row'];

  return match[1].trim().toLowerCase() === 'approved'
    ? []
    : ['Production promotion allowed is not explicitly approved'];
}

/**
 * Deliberately broad claim concepts. The governing-law phrase allows a short
 * gap so dash splits, JSX `{' '}` splits and inline markup all count, and the
 * jurisdiction side also matches venue and "court(s) of" wordings. String
 * content is matched on purpose — this check errs toward failing.
 */
const GOVERNING_LAW_PATTERN = /governing.{0,16}?laws?\b|governed.{0,16}?by\b/is;
const JURISDICTION_PATTERN = /jurisdiction|\bvenue|\bcourts?\s+of\b/i;

/**
 * A4a removed the terms body's governing-law paragraph because no jurisdiction
 * has been supplied and A4b removed the field that held one. This recomputes
 * that decision from the page source: comments are stripped first, so an
 * honest comment can never fail the gate, and the remaining code and string
 * content must not re-assert a governing law, a jurisdiction, a venue, or a
 * "court(s) of" reference. Only `terms-body.tsx` is read here — the DMCA
 * counter-notice's statutory "consent to the jurisdiction of the federal
 * district court" sentence lives in `takedown-copyright.tsx`.
 */
export function findUnsupportedLegalClaims({ termsBodySource } = {}) {
  if (typeof termsBodySource !== 'string' || termsBodySource.trim() === '') {
    return ['terms body: could not read its source'];
  }

  const failures = [];
  const withoutComments = stripComments(termsBodySource);

  if (GOVERNING_LAW_PATTERN.test(withoutComments)) {
    failures.push('terms body still asserts a governing law');
  }
  if (JURISDICTION_PATTERN.test(withoutComments)) {
    failures.push('terms body still asserts a jurisdiction');
  }

  return failures;
}

/**
 * Removes real comments while leaving string literals untouched: a `//` or
 * `/*` inside a quoted or template literal is string content, not a comment
 * opener, so it must not swallow the code that follows. Single- and
 * double-quoted literals cannot span lines, so a stray apostrophe in JSX prose
 * ends at the line break instead of hiding the code below it.
 */
function stripComments(source) {
  let result = '';
  let index = 0;

  while (index < source.length) {
    const char = source[index];

    if (char === "'" || char === '"' || char === '`') {
      const end = endOfStringLiteral(source, index);
      result += source.slice(index, end);
      index = end;
    } else if (char === '/' && source[index + 1] === '/') {
      while (index < source.length && source[index] !== '\n') index += 1;
    } else if (char === '/' && source[index + 1] === '*') {
      const end = source.indexOf('*/', index + 2);
      index = end === -1 ? source.length : end + 2;
    } else {
      result += char;
      index += 1;
    }
  }

  return result;
}

function endOfStringLiteral(source, start) {
  const quote = source[start];
  let index = start + 1;

  while (index < source.length) {
    if (source[index] === '\\') {
      index += 2;
    } else if (source[index] === quote) {
      return index + 1;
    } else if (quote !== '`' && source[index] === '\n') {
      return index;
    } else {
      index += 1;
    }
  }

  return source.length;
}

/**
 * Combines the three independent production prerequisites while keeping the
 * source parsers pure. The packet is intentionally required even when a
 * contact is configured, so contactability cannot stand in for approval, and
 * a terms body that re-asserts a jurisdiction the owner never supplied fails
 * the same gate.
 */
export function findProductionLegalReleaseFailures({
  legalIdentitySource,
  decisionPacketSource,
  termsBodySource,
} = {}) {
  return [
    ...findPendingLegalFields(typeof legalIdentitySource === 'string' ? legalIdentitySource : ''),
    ...findReleaseApprovalFailures(decisionPacketSource),
    ...findUnsupportedLegalClaims({ termsBodySource }),
  ];
}
