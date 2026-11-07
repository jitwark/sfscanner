import fs from 'node:fs';
import { readZip } from './xlsx-zip.js';

const XML_ENTITY = /^&(?:amp|lt|gt|quot|apos);$/;

function assertXmlText(text: string, where: string): void {
  if (text.includes(']]>')) throw new Error(`XLSX: ${where} has a forbidden ]]> sequence`);
  for (const match of text.matchAll(/&[^;\s]*;?/g)) {
    if (!XML_ENTITY.test(match[0])) throw new Error(`XLSX: ${where} has a bare or unknown entity`);
  }
}

/**
 * XML 1.0 Fifth Edition §2.2 `Char`, plus the entity rules and tag balance this
 * writer can emit. U+FFFD is intentionally allowed: it is valid XML, and it is
 * what Node produces for an unpaired surrogate, which the row parity check
 * already rejects.
 */
function assertXmlPart(source: string, where: string): void {
  for (const character of source) {
    const code = character.codePointAt(0)!;
    const allowed = code === 0x9 || code === 0xa || code === 0xd
      || (code >= 0x20 && code <= 0xd7ff)
      || (code >= 0xe000 && code <= 0xfffd)
      || (code >= 0x10000 && code <= 0x10ffff);
    if (!allowed) throw new Error(`XLSX: ${where} has XML 1.0-invalid U+${code.toString(16).toUpperCase()}`);
  }
  const stack: string[] = [];
  let cursor = 0;
  for (const match of source.matchAll(/<([^>]*)>/g)) {
    assertXmlText(source.slice(cursor, match.index), where);
    cursor = match.index + match[0].length;
    const body = match[1]!;
    if (body.startsWith('?') || body.startsWith('!')) continue;
    if (body.startsWith('/')) {
      const name = body.slice(1).trim();
      if (stack.pop() !== name) throw new Error(`XLSX: ${where} has a mismatched </${name}>`);
      continue;
    }
    const name = /^([A-Za-z_][\w.:-]*)/.exec(body)?.[1];
    if (name === undefined) throw new Error(`XLSX: ${where} has a malformed start tag`);
    if (!body.endsWith('/')) stack.push(name);
  }
  assertXmlText(source.slice(cursor), where);
  if (stack.length > 0) throw new Error(`XLSX: ${where} has an unclosed <${stack.at(-1)}>`);
}

/** Conformance check over every `.xml` and `.rels` part; returns the part count. */
export function assertXmlParts(files: ReadonlyMap<string, Buffer>): number {
  let parts = 0;
  for (const [name, bytes] of files) {
    if (!name.endsWith('.xml') && !name.endsWith('.rels')) continue;
    assertXmlPart(bytes.toString('utf8'), name);
    parts += 1;
  }
  return parts;
}

/**
 * DV-4 smoke seam: the exact conformance check `verifyExcelRelease` runs, over
 * an existing archive, without needing the projection.
 */
export function verifyExcelXmlParts(archivePath: string): number {
  return assertXmlParts(readZip(fs.readFileSync(archivePath)));
}
