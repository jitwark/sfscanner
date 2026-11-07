import type { RedactManifestEntry } from './redact.js';
import { hashValue } from './value-hash.js';

export function removeCodeParameter(
  target: Record<string, unknown>,
  key: string,
  path: string,
  manifest: RedactManifestEntry[],
): void {
  manifest.push({
    path,
    rule: 'code_body',
    beforeSha256: hashValue(target[key]),
    after: null,
  });
  delete target[key];
}
