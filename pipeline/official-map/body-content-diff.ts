import { compareCanonicalStrings } from '@hub/contracts/stable-order';
import { isWorkflowBody } from './admissible-body.js';

/**
 * Comparing two workflow bodies as *content*.
 *
 * Two bodies can differ in three ways, and only one of them is a content
 * difference: the JSON values can differ (the body says something else), the top
 * level keys can be in another order, or the bytes can be laid out another way
 * (indent, line endings). The first is real; the second and third are the same
 * content wearing different clothes, so they must never be reported as the first.
 *
 * `canonicalJson` sorts keys at every level and serialises, which collapses
 * order and layout: two bodies that canonicalise alike hold the same values.
 * Byte comparison needs the original bytes, and is done by the caller against
 * `encodeCorpusBodyFile`; the two are kept apart on purpose.
 */

/** Keys sorted at every level, so two bodies that differ only in key order serialise alike. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isWorkflowBody(value)) {
    const members = Object.keys(value)
      .sort(compareCanonicalStrings)
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`);
    return `{${members.join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/**
 * The parsed body, or `undefined` when the bytes are not JSON. A body file that
 * does not parse is not the same finding as a body file that does not exist, and
 * this keeps the caller from having to catch a throw to tell them apart.
 */
export function parseBodyBytes(bytes: Buffer): unknown {
  try {
    return JSON.parse(bytes.toString('utf8')) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * The first differing leaf paths between two bodies, up to `limit`, so a real
 * content difference can be named — `nodes[3].credentials.jiraSoftwareCloudApi.name`
 * says which field drifted, where "1 mismatch" says only that something did.
 */
export function firstDifferingPaths(left: unknown, right: unknown, limit: number): string[] {
  const found: string[] = [];
  const walk = (a: unknown, b: unknown, here: string): void => {
    if (found.length >= limit) return;
    if (Array.isArray(a) && Array.isArray(b)) {
      if (a.length !== b.length) found.push(`${here}.length`);
      for (let index = 0; index < Math.min(a.length, b.length) && found.length < limit; index += 1) {
        walk(a[index], b[index], `${here}[${index}]`);
      }
      return;
    }
    if (isWorkflowBody(a) && isWorkflowBody(b)) {
      const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort(compareCanonicalStrings);
      for (const key of keys) {
        walk(a[key], b[key], here === '' ? key : `${here}.${key}`);
        if (found.length >= limit) return;
      }
      return;
    }
    if (canonicalJson(a) !== canonicalJson(b)) found.push(here === '' ? '<root>' : here);
  };
  walk(left, right, '');
  return found;
}
