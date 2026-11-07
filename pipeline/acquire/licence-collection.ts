import { createHash } from 'node:crypto';

/** Runs one git command in a clone and returns its stdout, trimmed. */
export type GitRunner = (args: string[]) => Promise<string>;

export type LicenceEvidenceCollection = {
  files: Array<{ filename: string; sha256: string }>;
  readmeSnippet?: string;
};

/**
 * Licence, notice, and README evidence, read from the object database.
 *
 * Clones are `--no-checkout`, so there is no working tree to scan; a recursive
 * `ls-tree` of the commit and `cat-file` of the interesting blobs give the same
 * evidence. The listing is recursive on purpose: a licence instrument in a
 * subdirectory governs that subtree without being the repository licence, and
 * the rights decision can only compare it if acquisition records it. The README
 * snippet stays root-only, so a nested README is never mistaken for the
 * repository's own statement about itself.
 *
 * The git runner is injected rather than imported so a test can drive this
 * against a real local repository without a network clone — see
 * `clone-sources.test.ts`'s local fixture repository.
 */
export async function collectLicenceEvidence(
  git: GitRunner,
): Promise<LicenceEvidenceCollection> {
  const files: Array<{ filename: string; sha256: string }> = [];
  let readmeSnippet: string | undefined;

  const listing = await git(['ls-tree', '-r', 'HEAD']);
  for (const line of listing.split('\n')) {
    const tab = line.indexOf('\t');
    if (tab < 0) continue;
    const [, type, sha] = line.slice(0, tab).trim().split(/\s+/);
    if (type !== 'blob' || !sha) continue;

    const filename = line.slice(tab + 1).trim();
    // Classified by basename, not by full path: a licence instrument in a
    // subdirectory is a licence instrument, and matching on the path silently
    // excluded every one of them from the recorded evidence.
    const base = filename.slice(filename.lastIndexOf('/') + 1).toUpperCase();
    const isLicence =
      base.startsWith('LICENSE') || base.startsWith('COPYING') || base.startsWith('NOTICE');
    if (!isLicence && !base.startsWith('README')) continue;

    const content = await git(['cat-file', 'blob', sha]);
    if (isLicence) {
      files.push({ filename, sha256: createHash('sha256').update(content).digest('hex') });
    } else if (!filename.includes('/')) {
      readmeSnippet = content.slice(0, 4096);
    }
  }

  return { files, readmeSnippet };
}
