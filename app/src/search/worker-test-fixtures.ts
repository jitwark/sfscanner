import fs from 'node:fs';
import path from 'node:path';
import { makeEntry } from '../test-support/make-entry';

export const twoTierCorpus = () => Array.from({ length: 6 }, (_, index) => makeEntry({
  id: `tier-${index}`, slug: `tier-${index}`, title: `Tier workflow ${index}`,
  // Grade drives qualityScore, which decides tier membership: LOW ranks
  // above CRITICAL, so the LOW entries land in the primary tier.
  security: { grade: index < 3 ? 'LOW' : 'CRITICAL' },
  rights: { status: 'redistributable' }, structure: { nodeCount: 4, integrations: ['slack'] },
}));

export function requireSearchArtifacts(directory: string, files: string[]): void {
  const missing = files.filter((file) => !fs.existsSync(path.join(directory, file)));
  if (missing.length > 0) {
    throw new Error(`Required committed search artifacts are missing from ${directory}: ${missing.join(', ')}`);
  }
}

export function readSearchArtifact(directory: string, file: string): string {
  return fs.readFileSync(path.join(directory, file), 'utf8');
}
