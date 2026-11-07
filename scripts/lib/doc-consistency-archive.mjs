import { readFile, readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { statesCurrentFacts } from './doc-consistency-document.mjs';

export async function checkArchivedDocuments(archiveDir) {
  const errors = [];
  const archived = await readdir(archiveDir, { recursive: true, withFileTypes: true }).catch(() => []);
  for (const entry of archived) {
    const name = entry.parentPath ? relative(archiveDir, join(entry.parentPath, entry.name)) : entry.name;
    if (!entry.isFile() || !name.endsWith('.md') || name === 'README.md') continue;
    const text = await readFile(join(archiveDir, name), 'utf8').catch(() => null);
    if (text === null) {
      errors.push(`docs/archive/${name}: could not be read`);
      continue;
    }
    const status = text.match(/^> Status:\s*([^\r\n]+)/m)?.[1];
    if (!status) {
      errors.push(`docs/archive/${name}: missing Status metadata`);
    } else if (statesCurrentFacts(text)) {
      errors.push(`docs/archive/${name}: archived but Status says "${status}" — must read historical or superseded`);
    }
    if (!/^> Superseded by:\s*[^\r\n]+/m.test(text)) {
      errors.push(`docs/archive/${name}: missing "Superseded by" metadata naming what replaced it`);
    }
  }
  return errors;
}
