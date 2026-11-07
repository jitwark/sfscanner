import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fingerprint } from './dedup/signatures.js';

export type PrefixStats = {
  total: number;
  matched: number;
  orphan: number;
};

export type CrossCheckResult = {
  totalVaultFiles: number;
  matchedCount: number;
  orphanCount: number;
  prefixCounts: Record<string, PrefixStats>;
  orphansByPrefix: Record<string, string[]>;
};

export const KNOWN_PREFIXES = [
  'official',
  'github_ritikprog',
  'github_justincache',
  'github_zengfr',
  'github_danitilahun',
  'github_enescingoz',
  'github_scrapernode',
] as const;

export function extractFilenamePrefix(filename: string): string {
  for (const prefix of KNOWN_PREFIXES) {
    if (filename.startsWith(prefix + '__') || filename.startsWith(prefix + '_')) {
      return prefix;
    }
  }
  return 'other';
}

export async function runCrossCheck(
  runFingerprints: Set<string> | string[],
  options: { vaultDir?: string; concurrency?: number } = {}
): Promise<CrossCheckResult> {
  const vaultDir = options.vaultDir ?? 'D:/projects/n8n-vault-core/templates';
  const fpSet = runFingerprints instanceof Set ? runFingerprints : new Set(runFingerprints);

  let files: string[] = [];
  try {
    const entries = await readdir(vaultDir);
    files = entries.filter((f) => f.endsWith('.json'));
  } catch {
    return {
      totalVaultFiles: 0,
      matchedCount: 0,
      orphanCount: 0,
      prefixCounts: {},
      orphansByPrefix: {},
    };
  }

  const prefixCounts: Record<string, PrefixStats> = {};
  const orphansByPrefix: Record<string, string[]> = {};

  for (const prefix of [...KNOWN_PREFIXES, 'other']) {
    prefixCounts[prefix] = { total: 0, matched: 0, orphan: 0 };
    orphansByPrefix[prefix] = [];
  }

  const concurrency = options.concurrency ?? 100;
  let matchedCount = 0;
  let orphanCount = 0;

  for (let i = 0; i < files.length; i += concurrency) {
    const chunk = files.slice(i, i + concurrency);
    await Promise.all(
      chunk.map(async (filename) => {
        const prefix = extractFilenamePrefix(filename);
        const filePath = join(vaultDir, filename);
        let fp = '';
        try {
          const content = await readFile(filePath, 'utf8');
          const parsed = JSON.parse(content);
          fp = fingerprint(parsed);
        } catch {
          // Empty fp on parse error
        }

        prefixCounts[prefix].total += 1;
        if (fp && fpSet.has(fp)) {
          matchedCount += 1;
          prefixCounts[prefix].matched += 1;
        } else {
          orphanCount += 1;
          prefixCounts[prefix].orphan += 1;
          orphansByPrefix[prefix].push(filename);
        }
      })
    );
  }

  return {
    totalVaultFiles: files.length,
    matchedCount,
    orphanCount,
    prefixCounts,
    orphansByPrefix,
  };
}
