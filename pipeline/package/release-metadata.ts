import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export type CompatibilityTarget = {
  version: string;
  source: string;
  checkedAt: string;
};

export type ReleaseMetadata = {
  corpusId: string;
  corpusSha256: string;
  sanitizerVersion: string;
  scannerVersion: string;
  promptVersion?: string;
  promptSha256?: string;
  descriptionSchemaVersion?: string;
  model?: string;
  compatibilityTarget?: CompatibilityTarget;
  generatedAt: string;
  producingCommit?: string;
};

export function validateReleaseTimestamp(value: string): string {
  if (!Number.isFinite(Date.parse(value))) {
    throw new Error('Release metadata requires a valid generatedAt timestamp');
  }
  return value;
}

function relativeFiles(root: string): string[] {
  const names: string[] = [];
  const visit = (directory: string) => {
    for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, item.name);
      if (item.isDirectory()) visit(absolute);
      else if (item.name !== 'manifest.json') names.push(path.relative(root, absolute).replace(/\\/g, '/'));
    }
  };
  visit(root);
  return names.sort();
}

/** Hashes the exact package bytes, excluding the manifest that stores the hash. */
export function hashReleaseDirectory(outputDir: string): string {
  const digest = crypto.createHash('sha256');
  for (const relative of relativeFiles(outputDir)) {
    digest.update(relative);
    digest.update('\0');
    digest.update(fs.readFileSync(path.join(outputDir, relative)));
    digest.update('\0');
  }
  return digest.digest('hex');
}

export function buildReleaseMetadata(input: Omit<ReleaseMetadata, 'corpusSha256'> & { outputDir: string }): ReleaseMetadata {
  if (!input.corpusId.trim()) throw new Error('Release metadata requires corpusId');
  if (!input.sanitizerVersion.trim() || input.sanitizerVersion === 'unknown') {
    throw new Error('Release metadata requires a known sanitizerVersion');
  }
  if (!input.scannerVersion.trim() || input.scannerVersion === 'unknown' || input.scannerVersion === 'mixed') {
    throw new Error('Release metadata requires a known scannerVersion');
  }
  validateReleaseTimestamp(input.generatedAt);
  if (input.model && !input.promptVersion) {
    throw new Error('Generated model metadata requires promptVersion');
  }
  return {
    corpusId: input.corpusId,
    corpusSha256: hashReleaseDirectory(input.outputDir),
    sanitizerVersion: input.sanitizerVersion,
    scannerVersion: input.scannerVersion,
    ...(input.promptVersion ? { promptVersion: input.promptVersion } : {}),
    ...(input.promptSha256 ? { promptSha256: input.promptSha256 } : {}),
    ...(input.descriptionSchemaVersion ? { descriptionSchemaVersion: input.descriptionSchemaVersion } : {}),
    ...(input.model ? { model: input.model } : {}),
    ...(input.compatibilityTarget ? { compatibilityTarget: input.compatibilityTarget } : {}),
    generatedAt: input.generatedAt,
    ...(input.producingCommit ? { producingCommit: input.producingCommit } : {}),
  };
}
