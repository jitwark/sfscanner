import fs from 'node:fs';
import path from 'node:path';

const OWNED_ARTIFACT = /^(?:catalogue-\d+|search-index|search-index-extended|semantic-index|facets|stats|analytics|manifest|missing-workflows|quarantine-report)\.(?:json|jsonl)$/;

/** Remove only generated artifact names owned by the packager. */
export function clearOwnedArtifacts(outputDir: string): void {
  const entries = fs.readdirSync(outputDir, { withFileTypes: true });
  for (const item of entries) {
    if (item.name !== 'charts' && item.name !== 'packs' && item.name !== 'previews' && !OWNED_ARTIFACT.test(item.name)) continue;
    fs.rmSync(path.join(outputDir, item.name), { recursive: true, force: true });
  }
}
