import { readFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';

export function currentSection(text) {
  const marker = text.search(/^##+\s+Historical/im);
  return marker === -1 ? text : text.slice(0, marker);
}

export function statesCurrentFacts(text) {
  const status = text.match(/^> Status:\s*([^\r\n]+)/m)?.[1] ?? '';
  return !/historical|superseded|archived|proposal|draft/i.test(status);
}

export async function checkDocument({ root, file, forbidden, claims, corpus }) {
  const errors = [];
  const text = await readFile(join(root, file), 'utf8').catch(() => '');
  if (!/^> Status:\s*[^\r\n]+/m.test(text)) errors.push(`${file}: missing Status metadata`);
  if (!/^> Last verified:\s*\d{4}-\d{2}-\d{2}/m.test(text)) errors.push(`${file}: missing Last verified metadata`);
  if (!/^> Owner:\s*[^\r\n]+/m.test(text)) errors.push(`${file}: missing Owner metadata`);
  if (!/^> Source of truth:\s*[^\r\n]+/m.test(text)) errors.push(`${file}: missing Source of truth metadata`);
  for (const pattern of forbidden) if (pattern.test(text)) errors.push(`${file}: stale statement ${pattern}`);

  const current = statesCurrentFacts(text) ? currentSection(text) : '';
  for (const claim of claims) {
    for (const match of current.matchAll(claim.re)) {
      const value = Number(String(match[1]).replace(/,/g, ''));
      if (claim.allow.some((key) => corpus[key] === value)) continue;
      const line = current.slice(0, match.index).split(/\r?\n/).length;
      const allowed = claim.allow.map((key) => `${key}=${corpus[key].toLocaleString('en-US')}`).join(', ');
      errors.push(
        `${file}:${line}: "${match[0].trim()}" claims ${claim.label} = ${match[1]}, ` +
          `but the data says ${allowed}`,
      );
    }
  }

  if (corpus.searchable !== corpus.total) {
    const totality =
      /\b(?:complete|whole|entire|full|every|all)\b[^.\n]{0,40}?\b(?:catalogues?|catalogs?|corpus|workflows?|entries)\b[^.\n]{0,40}?\bsearch(?:able|ed)?\b/i;
    if (totality.test(current)) {
      errors.push(
        `${file}: claims the whole catalogue is searchable, but ` +
          `${corpus.searchable.toLocaleString('en-US')} of ${corpus.total.toLocaleString('en-US')} entries are`,
      );
    }
  }

  const linkPattern = /\]\((?!https?:\/\/|mailto:|#)([^)]+)\)/g;
  for (const match of text.matchAll(linkPattern)) {
    const target = match[1].split('#')[0].replace(/^<|>$/g, '');
    if (!target) continue;
    const absolute = resolve(join(root, file, '..'), target);
    if (!(await stat(absolute).catch(() => null))) errors.push(`${file}: broken local link ${target}`);
  }
  return errors;
}
