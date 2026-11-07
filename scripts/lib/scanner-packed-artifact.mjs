import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

/**
 * Readers for what the **packed artifact** actually contains, split out of the release scripts to
 * keep each file within the repository's 250-line budget and without a tar dependency:
 * - the entries of the gzipped tar written by `npm pack` (list or extract into a tree);
 * - the bundle's shipped source maps, whose `sources` name every module esbuild inlined — this is
 *   the evidence used to classify a dependency as *shipped* rather than merely declared;
 * - the minimum entry set a packed artifact must carry before it counts as build evidence.
 */
const sha256Hex = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const compare = (left, right) => (left < right ? -1 : left > right ? 1 : 0);
const posix = (value) => value.split(path.sep).join('/');
const tarField = (header, start, length) => header.subarray(start, start + length).toString('utf8').replace(/\0[\s\S]*$/u, '').trim();
const octal = (header, start, length) => parseInt(tarField(header, start, length).replace(/[^0-7]/gu, '') || '0', 8);

// One pass over a gzipped tar (npm pack output); `onEntry` also receives file bytes for extraction.
function walkPackedArchive(tarballPath, onEntry) {
  const archive = zlib.gunzipSync(fs.readFileSync(tarballPath));
  const entries = [];
  let offset = 0;
  let pax = {};
  while (offset + 512 <= archive.length) {
    const header = archive.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const size = octal(header, 124, 12);
    const typeflag = String.fromCharCode(header[156]);
    const data = archive.subarray(offset + 512, offset + 512 + size);
    if (typeflag === 'x' || typeflag === 'g') {
      pax = Object.fromEntries(data.toString('utf8').split('\n').flatMap((line) => {
        const split = line.indexOf('=');
        return split === -1 ? [] : [[line.slice(line.indexOf(' ') + 1, split), line.slice(split + 1)]];
      }));
    } else if (typeflag !== '5') {
      const base = { path: (pax.path ?? [tarField(header, 345, 155), tarField(header, 0, 100)].filter(Boolean).join('/')).replace(/^\.\//u, ''), mtime: octal(header, 136, 12), bytes: size };
      const entry = typeflag === '2'
        ? { ...base, kind: 'symlink', target: pax.linkpath ?? tarField(header, 157, 100) }
        : { ...base, kind: 'file', sha256: sha256Hex(data), data };
      entries.push(entry);
      onEntry?.(entry);
      pax = {};
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return entries.sort((left, right) => compare(left.path, right.path));
}

/** Lists a gzipped tar's regular files (path, sha256, bytes, mtime) and symlinks (path, target). */
export const readPackedEntries = (tarballPath) => walkPackedArchive(tarballPath);

/** Gzip stores a modification time in its header; it is the usual source of tarball byte drift. */
export function readGzipMtime(tarballPath) {
  const header = fs.readFileSync(tarballPath).subarray(0, 10);
  return header.length === 10 && header[0] === 0x1f && header[1] === 0x8b ? header.readUInt32LE(4) : null;
}

/** Extracts a pack tarball into a tree, refusing entries that escape the destination directory. */
export function extractPackedTarball({ tarballPath, destination }) {
  const extracted = { files: 0, symlinks: 0, refused: [] };
  walkPackedArchive(tarballPath, (entry) => {
    const normalised = entry.path.replace(/^[^/]+\//u, '').replaceAll('\\', '/');
    const unsafe = normalised.length === 0 || normalised.startsWith('/') || /^[A-Za-z]:\//u.test(normalised)
      || normalised.split('/').some((part) => part === '' || part === '.' || part === '..');
    if (unsafe) {
      extracted.refused.push(entry.path);
      return;
    }
    const target = path.join(destination, normalised);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (entry.kind === 'symlink') {
      fs.symlinkSync(entry.target, target);
      extracted.symlinks += 1;
    } else {
      fs.writeFileSync(target, entry.data);
      extracted.files += 1;
    }
  });
  return extracted;
}

/**
 * Reads every shipped `*.js.map` under `distDirectory` and returns the source files it names,
 * resolved against `rootDirectory`, plus the digest of that evidence. Declared intent is never
 * used: a dependency counts as shipped only if one of these paths names it. Sources that leave the
 * repository root (absolute paths, `data:` URLs, escapes) are counted in `unresolved`, not trusted.
 */
export function readPackedSourceMaps({ distDirectory, rootDirectory, suffix = '.js.map' }) {
  const maps = [];
  const paths = new Set();
  let unresolved = 0;
  const candidates = fs.existsSync(distDirectory) && fs.statSync(distDirectory).isDirectory()
    ? fs.readdirSync(distDirectory, { recursive: true }).map(String).filter((entry) => entry.endsWith(suffix)).map(posix).sort(compare)
    : [];
  for (const relative of candidates) {
    const mapPath = path.join(distDirectory, relative);
    const bytes = fs.readFileSync(mapPath);
    maps.push({ relative, sha256: sha256Hex(bytes) });
    for (const source of JSON.parse(bytes.toString('utf8')).sources ?? []) {
      const resolved = typeof source === 'string' && !source.startsWith('data:') ? posix(path.relative(rootDirectory, path.resolve(path.dirname(mapPath), source))) : null;
      if (resolved === null || resolved.length === 0 || resolved.startsWith('..')) unresolved += 1;
      else paths.add(resolved);
    }
  }
  const sorted = [...paths].sort(compare);
  return { maps, paths: sorted, unresolved, digest: sha256Hex(JSON.stringify({ maps, paths: sorted })) };
}

/**
 * The entries a packed artifact must carry before its identity means anything: `package.json` plus
 * every built `dist/` file. An artifact without any `dist/` entry is a failure, not an observation,
 * because two identical build-less packs prove nothing.
 */
export function requiredArtifactEntries(entries, { prefix = 'package/dist/' } = {}) {
  const requiredPaths = entries
    .filter((entry) => entry.kind === 'file' && entry.path.startsWith(prefix))
    .map((entry) => entry.path.slice('package/'.length))
    .sort(compare);
  if (requiredPaths.length === 0) {
    return { requiredPaths: [], failures: [`missing-required-entry: ${prefix.replace(/^package\//u, '')} (the packed artifact carries no built output; run npm run build:scanner before this check)`] };
  }
  return { requiredPaths: ['package.json', ...requiredPaths], failures: [] };
}
