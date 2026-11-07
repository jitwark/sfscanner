/**
 * Count personal and credential-shaped strings in the published corpus.
 *
 * 11,464 entries carry text written by 13,221 acquisitions of other people's
 * work — descriptions, sticky-note prose, hostnames, source metadata. The
 * sanitizer redacts what it recognises during acquisition; nothing has ever
 * measured what survives into the artifacts we actually publish.
 *
 * This counts and never prints a value. A privacy sweep that logs the email
 * addresses it found has published them a second time, into CI output that is
 * retained for weeks — so the report is shapes and totals, plus the entry ids
 * needed to go and look, and nothing else.
 */

/**
 * Each matcher is anchored and bounded. The scanner reads untrusted text, and a
 * pattern with unbounded overlapping repetition is a denial-of-service waiting
 * for the right input — `npm run check:regex-safety` enforces that rule across
 * the scanner and these are held to it too.
 */
export const MATCHERS = Object.freeze([
  {
    name: 'email-address',
    // Bounded on both sides of the @; no nested quantifier.
    pattern: /[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,255}\.[A-Za-z]{2,24}/g,
    what: 'an email address, which may identify a person',
  },
  {
    name: 'bearer-or-api-key',
    pattern: /\b(?:bearer\s+[A-Za-z0-9._~+/-]{16,512}|sk-[A-Za-z0-9_-]{16,256}|gh[pousr]_[A-Za-z0-9]{16,256}|AKIA[A-Z0-9]{16})/gi,
    what: 'a credential-shaped token',
  },
  {
    name: 'private-ip',
    // RFC1918 and loopback. A private address in published text says something
    // about someone's internal network, however little.
    pattern: /\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|127\.0\.0\.1)\b/g,
    what: 'a private or loopback IP address',
  },
  {
    name: 'internal-hostname',
    pattern: /\b[A-Za-z0-9-]{1,63}\.(?:local|internal|intranet|lan|corp)\b/gi,
    what: 'a hostname on a private network',
  },
]);

/**
 * Placeholders are the dominant signal in workflow documentation, and counting
 * them as findings would bury the real ones. These are recognised as examples,
 * not as data.
 */
const PLACEHOLDER = /(example|yourdomain|your-domain|your_email|placeholder|changeme|xxx+|<[^>]{1,64}>|\{\{|test@|foo@|user@domain)/i;

/**
 * `report_2024.summary@invoice.pdf` is a filename, not an address. Workflow
 * prose is full of them, and counting one as a person makes the number that is
 * supposed to mean something mean nothing.
 */
const FILENAME_SUFFIX = /\.(?:pdf|png|jpe?g|gif|svg|csv|xlsx?|docx?|zip|json|txt|md|mp[34]|html?)$/i;

/**
 * @param {Iterable<{ id: string, text: string }>} documents
 * @returns {{ totals: Record<string, number>, entriesAffected: Record<string, string[]>, scanned: number }}
 */
export function sweepCorpusPrivacy(documents) {
  const totals = Object.fromEntries(MATCHERS.map((matcher) => [matcher.name, 0]));
  const entriesAffected = Object.fromEntries(MATCHERS.map((matcher) => [matcher.name, []]));
  let scanned = 0;

  for (const { id, text } of documents) {
    scanned += 1;
    if (typeof text !== 'string' || text.length === 0) continue;
    for (const matcher of MATCHERS) {
      matcher.pattern.lastIndex = 0;
      let hits = 0;
      for (const match of text.matchAll(matcher.pattern)) {
        if (PLACEHOLDER.test(match[0])) continue;
        if (matcher.name === 'email-address' && FILENAME_SUFFIX.test(match[0])) continue;
        hits += 1;
      }
      if (hits === 0) continue;
      totals[matcher.name] += hits;
      if (!entriesAffected[matcher.name].includes(id)) entriesAffected[matcher.name].push(id);
    }
  }

  return { totals, entriesAffected, scanned };
}
