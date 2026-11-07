import fs from 'node:fs';
import path from 'node:path';

import { parseManifest, type Manifest } from './manifest';

export function readManifestSync(): Manifest {
  const cwd = process.cwd();
  const candidates = [
    path.join(cwd, 'public', 'data', 'manifest.json'),
    path.join(cwd, 'app', 'public', 'data', 'manifest.json'),
    path.join(cwd, 'data', 'manifest.json'),
    path.join(cwd, '..', 'data', 'manifest.json'),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return parseManifest(JSON.parse(fs.readFileSync(candidate, 'utf8')));
    }
  }

  throw new Error(`manifest.json not found in candidate paths: ${candidates.join(', ')}`);
}
