import { normalizeDisplayText } from './hostile-text';
import { truncateWordBoundary } from './text-format';

/**
 * AUDIT-SEO-001. `truncateWordBoundary` used to cut a single pre-joined
 * string (`"${name} · n8n workflow (${ints}) | ${site}"`) at 60 characters on
 * a word boundary. That has no notion of segments, so whatever character
 * preceded the cut survived — a separator 22.1% of the time across the
 * corpus (2,927 / 13,221 titles), e.g. `"...(Agent, Code) |"`.
 *
 * `composeEntryTitle` replaces that with segment composition: the workflow
 * name is mandatory and always present in full (truncated only if it alone
 * exceeds the budget); the qualifier is the richest complete one — two
 * integrations, then one, then the trigger, then a bare label — that fits
 * alongside the name; the site name is appended only when the whole string
 * still fits. Each segment is fully present or fully absent, never half.
 */
export interface TitleQualifierSource {
  /** Already-capitalized integration names, in priority order. */
  integrations: string[];
  trigger?: string;
}

const SEGMENT_SEPARATOR = ' · '; // " · "
const QUALIFIER_LABEL = 'n8n workflow';
const SITE_SEPARATOR = ' | ';

/**
 * Terminal-separator allowlist for AUDIT-SEO-001.
 *
 * These six read as "something follows" when they are the *last* visible
 * character of a title: `,` and `:` introduce a continuation, `|` and `·`
 * are our own segment joiners, `-` reads as a truncated compound or range,
 * and `/` reads as a truncated path or alternative. A closing paren (the
 * qualifier's own terminator), letters, digits, and sentence-final
 * punctuation (`.`, `!`, `?`, closing quotes) are deliberately left alone —
 * they close a segment rather than open one, so stripping them would just
 * be scrubbing punctuation generally, which AUDIT-SEO-001 explicitly rules
 * out (rule 4: internal/legitimate punctuation must survive).
 */
export const TERMINAL_SEPARATOR_CHARS = [',', '|', '·', '-', ':', '/'] as const;

const TERMINAL_SEPARATOR_RE = /[,|·\-:/\s]+$/u;

/** Removes a trailing run of separator characters (and any whitespace around them), never internal ones. */
export function stripTrailingSeparators(value: string): string {
  return value.replace(TERMINAL_SEPARATOR_RE, '');
}

const BRACKET_PAIRS = [['(', ')'], ['[', ']']] as const;

/**
 * A word-boundary cut can land *inside* a bracketed clause in the workflow's
 * own name, leaving the bracket open — `"…with multi-input (text, image &"`.
 * 85 of 13,221 corpus titles did this after the first AUDIT-SEO-001 fix, and
 * the terminal-separator rule cannot see them because the last character is an
 * ordinary letter.
 *
 * Drop the unclosed clause rather than keep half of it: an opened-but-never-
 * closed qualifier reads as truncation, which is the defect this whole rule
 * exists to remove. If dropping it would leave nothing, keep the cut text —
 * a stub title is still better than an empty one.
 */
function dropUnclosedBracketClause(value: string): string {
  let result = value;
  for (const [open, close] of BRACKET_PAIRS) {
    const lastOpen = result.lastIndexOf(open);
    if (lastOpen === -1 || result.indexOf(close, lastOpen) !== -1) continue;
    const withoutClause = result.slice(0, lastOpen);
    if (withoutClause.trim() !== '') result = withoutClause;
  }
  return result;
}

function fits(value: string, maxLen: number): boolean {
  return value.length <= maxLen;
}

/**
 * Composes an entry page title from prioritized, complete segments instead
 * of truncating a pre-joined string. See module doc for the rule.
 */
export function composeEntryTitle(
  rawName: string,
  qualifiers: TitleQualifierSource,
  siteName: string,
  maxLen = 60,
): string {
  const name = normalizeDisplayText(rawName);
  const nameFits = fits(name, maxLen);
  const base = nameFits
    ? name
    : stripTrailingSeparators(dropUnclosedBracketClause(truncateWordBoundary(name, maxLen)));

  let withQualifier = base;
  let qualifierAttached = false;

  if (nameFits) {
    const [firstInt, secondInt] = qualifiers.integrations;
    const parenthesizedCandidates: string[] = [];
    if (firstInt && secondInt) parenthesizedCandidates.push(`${firstInt}, ${secondInt}`);
    if (firstInt) parenthesizedCandidates.push(firstInt);
    if (qualifiers.trigger) parenthesizedCandidates.push(qualifiers.trigger);

    for (const candidate of parenthesizedCandidates) {
      const attempt = `${name}${SEGMENT_SEPARATOR}${QUALIFIER_LABEL} (${candidate})`;
      if (fits(attempt, maxLen)) {
        withQualifier = attempt;
        qualifierAttached = true;
        break;
      }
    }

    if (!qualifierAttached) {
      const bareAttempt = `${name}${SEGMENT_SEPARATOR}${QUALIFIER_LABEL}`;
      if (fits(bareAttempt, maxLen)) {
        withQualifier = bareAttempt;
        qualifierAttached = true;
      }
    }
  }

  const withSite = `${withQualifier}${SITE_SEPARATOR}${siteName}`;
  return fits(withSite, maxLen) ? withSite : withQualifier;
}
