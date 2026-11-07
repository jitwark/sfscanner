/**
 * Static, string-only detector for catastrophic (exponential) regex
 * backtracking — ReDoS. No `RegExp` is ever constructed or executed here;
 * everything works on the pattern's *source text*, so a genuinely malicious
 * pattern can never run against real input during the audit itself.
 *
 * Scope, deliberately narrow: this flags the two textbook exponential-blowup
 * shapes, and nothing else.
 *
 *   1. Nested quantifiers  — a group repeated an unbounded number of times
 *      whose own body is *also* repeated: `(a+)+`, `(a*)*`, `(a+)*`. Each
 *      extra character can be attributed to the inner or outer repetition in
 *      exponentially many ways.
 *   2. Overlapping alternation under a quantifier — `(a|a)*`, `(\w|\d)+`.
 *      When two branches can match the same text, an unbounded repeat of the
 *      group can partition a run of input between them in exponentially many
 *      ways.
 *
 * A group is only inspected when it carries an *unbounded* outer repetition
 * (`*`, `+`, or `{n,}` with no upper bound). `?` and any `{n,m}`/`{n}` with an
 * explicit upper bound are bounded — capped repetition cannot blow up
 * exponentially, so `(?:foo){1,64}` and `group?` are never flagged, matching
 * how this codebase actually writes its bounded quantifiers (see
 * provider-token-patterns.ts). A group with no trailing quantifier at all
 * (most groups in this codebase — plain alternation used once, like
 * `(?:api-key|token|secret)`) is likewise never inspected: without repetition
 * there is nothing to blow up.
 */

const OVERLAPPING_SHORTHAND_GROUPS = [
  ['\\w', '\\d', '\\S'],
  ['\\W', '\\D'],
];

/** Every top-level (unescaped, not inside a `[...]` class) `(` in `pattern`, paired with its matching `)`. Nested groups are included independently, so a deeply nested vulnerable group is still found. */
function findGroups(pattern) {
  const groups = [];
  const stack = [];
  let inClass = false;
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i];
    if (ch === '\\') { i += 1; continue; }
    if (!inClass && ch === '[') { inClass = true; continue; }
    if (inClass && ch === ']') { inClass = false; continue; }
    if (inClass) continue;
    if (ch === '(') stack.push(i);
    else if (ch === ')' && stack.length > 0) groups.push({ start: stack.pop(), end: i });
  }
  return groups;
}

/** Where a group's *body* starts — past a `(?:`, `(?=`, `(?!`, `(?<=`, `(?<!`, or `(?<name>` prefix, or just past `(` for a plain capturing group. */
function groupBodyStart(pattern, start) {
  const rest = pattern.slice(start + 1);
  const named = /^\?<[^=!][^>]*>/.exec(rest);
  if (named) return start + 1 + named[0].length;
  const flagged = /^\?(?:[:=!]|<[=!])/.exec(rest);
  if (flagged) return start + 1 + flagged[0].length;
  return start + 1;
}

/** The quantifier immediately following a group's closing `)`, or null. `bounded` is true for anything whose repeat count has a finite ceiling (`?`, `{n}`, `{n,m}`) — the only kind this codebase's real patterns use. */
function quantifierAfter(pattern, end) {
  const match = /^(\*|\+|\?|\{\d+(?:,\d*)?\})\??/.exec(pattern.slice(end + 1));
  if (!match) return null;
  const token = match[1];
  if (token === '*' || token === '+') return { bounded: false, text: match[0] };
  if (token === '?') return { bounded: true, text: match[0] };
  const range = /^\{(\d+)(?:,(\d*))?\}$/.exec(token);
  const hasOpenUpperBound = range[2] === '';
  return { bounded: !hasOpenUpperBound, text: match[0] };
}

/**
 * One pass over a group's body: collects whether it contains its own
 * top-level quantifier (`nested quantifier` risk) and its top-level `|`
 * branches (`overlapping alternation` risk). "Top level" excludes anything
 * inside a nested `(...)` subgroup or a `[...]` character class — those are
 * each other groups, evaluated independently by the caller.
 */
function analyzeGroupBody(body) {
  let depth = 0;
  let inClass = false;
  let hasTopLevelQuantifier = false;
  const branches = [''];
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    if (ch === '\\') { branches[branches.length - 1] += ch + (body[i + 1] ?? ''); i += 1; continue; }
    if (!inClass && ch === '[') { inClass = true; branches[branches.length - 1] += ch; continue; }
    if (inClass && ch === ']') { inClass = false; branches[branches.length - 1] += ch; continue; }
    if (!inClass && ch === '(') { depth += 1; branches[branches.length - 1] += ch; continue; }
    if (!inClass && ch === ')') { depth -= 1; branches[branches.length - 1] += ch; continue; }
    if (!inClass && depth === 0 && ch === '|') { branches.push(''); continue; }
    if (!inClass && depth === 0 && (ch === '*' || ch === '+')) { hasTopLevelQuantifier = true; branches[branches.length - 1] += ch; continue; }
    if (!inClass && depth === 0 && ch === '{') {
      const quantifier = /^\{\d+(?:,\d*)?\}\??/.exec(body.slice(i));
      if (quantifier) { hasTopLevelQuantifier = true; branches[branches.length - 1] += quantifier[0]; i += quantifier[0].length - 1; continue; }
    }
    branches[branches.length - 1] += ch;
  }
  return { hasTopLevelQuantifier, branches };
}

function overlapGroupIndex(branch) {
  return OVERLAPPING_SHORTHAND_GROUPS.findIndex((group) => group.includes(branch));
}

/** True if any two top-level alternation branches can match the same text. */
function branchesOverlap(branches) {
  for (let i = 0; i < branches.length; i += 1) {
    for (let j = i + 1; j < branches.length; j += 1) {
      if (branches[i] === branches[j]) return true;
      const left = overlapGroupIndex(branches[i]);
      const right = overlapGroupIndex(branches[j]);
      if (left !== -1 && left === right) return true;
    }
  }
  return false;
}

/**
 * Returns a list of human-readable reasons a pattern's source text is
 * vulnerable to catastrophic backtracking; an empty array means clean.
 * `pattern` is the regex *source* (no leading/trailing `/`, no flags).
 */
export function detectCatastrophicPatterns(pattern) {
  const reasons = [];
  for (const { start, end } of findGroups(pattern)) {
    const quantifier = quantifierAfter(pattern, end);
    if (!quantifier || quantifier.bounded) continue;
    const bodyStart = groupBodyStart(pattern, start);
    const body = pattern.slice(bodyStart, end);
    const { hasTopLevelQuantifier, branches } = analyzeGroupBody(body);
    const construct = `(${body})${quantifier.text}`;
    if (hasTopLevelQuantifier) reasons.push(`nested quantifier in '${construct}'`);
    if (branches.length > 1 && branchesOverlap(branches)) reasons.push(`overlapping alternation in '${construct}'`);
  }
  return reasons;
}
