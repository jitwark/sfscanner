/**
 * Declared dependency inventory for the scanner SBOM: resolves the packed workspace package's full
 * dependency closure from a `package-lock.json` (`packages` map, lockfileVersion 2/3) and maps each
 * entry to a CycloneDX 1.5 component. Split out of scripts/generate-scanner-sbom.mjs to keep each
 * file within the repository's 250-line budget; no I/O happens here.
 *
 * The shipped/declared distinction is the whole point of the component scope:
 *   observed in the packed artifact   -> `required`  (the code ships inside the tarball)
 *   declared runtime, not observed    -> `optional`  (installed for the workspace but tree-shaken out of this build)
 *   dev-only tooling                  -> `excluded`  (build/test only)
 * "Observed" is supplied by the caller from shipped source-map evidence
 * (scripts/lib/scanner-packed-artifact.mjs), never derived from what a package declares.
 */
// SPDX license ids verified against https://spdx.org/licenses/licenses.json (license list 3.29.0).
// A declared licence outside this set becomes CycloneDX `license.name`, never a guessed id, because
// `license.id` is validated against the SPDX license list enum.
const SPDX_LICENSE_IDS = new Set(['0BSD', 'AGPL-3.0-only', 'AGPL-3.0-or-later', 'Apache-2.0', 'Artistic-2.0', 'BSD-2-Clause', 'BSD-3-Clause', 'BSD-3-Clause-Clear', 'BlueOak-1.0.0', 'CC-BY-4.0', 'CC0-1.0', 'GPL-3.0-only', 'GPL-3.0-or-later', 'ISC', 'LGPL-2.1-only', 'LGPL-3.0-only', 'LGPL-3.0-or-later', 'MIT', 'MIT-0', 'MPL-2.0', 'NCSA', 'OFL-1.1', 'Python-2.0', 'Unlicense', 'UPL-1.0', 'WTFPL', 'Zlib']);
const HASH_ALGORITHMS = Object.freeze({ sha1: 'SHA-1', sha256: 'SHA-256', sha384: 'SHA-384', sha512: 'SHA-512' });
const compare = (left, right) => (left < right ? -1 : left > right ? 1 : 0);
const property = (name, value) => ({ name, value: String(value) });
const sortProperties = (properties) => properties.filter(Boolean).sort((left, right) => compare(left.name, right.name));

// npm node_modules resolution over a lockfile v3 `packages` map.
function resolveEntry(packages, fromPath, name) {
  for (let current = fromPath; ; ) {
    const candidate = current === '' ? `node_modules/${name}` : `${current}/node_modules/${name}`;
    const entry = packages[candidate];
    if (entry) {
      if (!entry.link) return { path: candidate, entry };
      return packages[entry.resolved] ? { path: entry.resolved, entry: packages[entry.resolved] } : null;
    }
    if (current === '') return null;
    current = current.includes('/') ? current.slice(0, current.lastIndexOf('/')) : '';
  }
}

const entryName = (entryPath, entry) => (entryPath.startsWith('node_modules/')
  ? entryPath.slice(entryPath.lastIndexOf('node_modules/') + 'node_modules/'.length)
  : entry.name);

/** Package name a repository-relative path belongs to, or null when the path is not installed code. */
function installedPackageName(relativePath) {
  const marker = relativePath.lastIndexOf('node_modules/');
  if (marker === -1) return null;
  const remainder = relativePath.slice(marker + 'node_modules/'.length);
  const segments = remainder.split('/');
  return segments[0].startsWith('@') ? segments.slice(0, 2).join('/') : segments[0];
}

// Package URL type `npm`: the scope's `@` is always percent-encoded as `%40`
// (https://github.com/package-url/purl-spec/blob/main/docs/types/definitions/npm-definition.md).
export const purlFor = (name, version) => `pkg:npm/${name.startsWith('@') ? `%40${name.slice(1)}` : name}${version ? `@${version}` : ''}`;

const hashesFromIntegrity = (integrity) => (typeof integrity === 'string'
  ? integrity.split(/\s+/u).flatMap((record) => {
    const [algorithm, encoded] = record.split('-');
    return HASH_ALGORITHMS[algorithm] && encoded ? [{ alg: HASH_ALGORITHMS[algorithm], content: Buffer.from(encoded, 'base64').toString('hex') }] : [];
  })
  : []);

export const licensesFor = (declared) => (typeof declared === 'string' && declared.length > 0
  ? [{ license: SPDX_LICENSE_IDS.has(declared) ? { id: declared } : { name: declared } }]
  : []);

// Every dependency the packed package can reach through declared runtime, optional or dev edges.
function collectClosure({ packages, workspacePath, workspaceManifest }) {
  const records = new Map();
  const enqueue = (queue, fromPath, manifest) => {
    for (const field of ['dependencies', 'optionalDependencies', 'devDependencies']) {
      for (const name of Object.keys(manifest[field] ?? {})) queue.push({ from: fromPath, name });
    }
  };
  const queue = [];
  enqueue(queue, workspacePath, workspaceManifest);
  while (queue.length > 0) {
    const { from, name } = queue.shift();
    const resolved = resolveEntry(packages, from, name);
    if (!resolved || records.has(resolved.path)) continue;
    records.set(resolved.path, {
      path: resolved.path,
      entry: resolved.entry,
      children: Object.keys(resolved.entry.dependencies ?? {})
        .map((child) => resolveEntry(packages, resolved.path, child)?.path)
        .filter(Boolean),
    });
    enqueue(queue, resolved.path, resolved.entry);
  }
  return records;
}

// Paths reachable from the packed package and the workspace packages it is built with, through
// runtime edges only: the *declared* runtime closure. Whether that code is in the artifact is a
// separate question, answered by the shipped source-map evidence.
function declaredRuntimePaths({ records, packages, workspacePath, workspaceManifest }) {
  const declared = new Set();
  const queue = [workspacePath, ...records.keys()].filter((entryPath, index, all) => all.indexOf(entryPath) === index && !entryPath.startsWith('node_modules/'));
  while (queue.length > 0) {
    const entryPath = queue.shift();
    if (declared.has(entryPath)) continue;
    declared.add(entryPath);
    const manifest = entryPath === workspacePath ? workspaceManifest : records.get(entryPath)?.entry;
    for (const field of ['dependencies', 'optionalDependencies']) {
      for (const name of Object.keys(manifest?.[field] ?? {})) {
        const child = resolveEntry(packages, entryPath, name);
        if (child && !declared.has(child.path)) queue.push(child.path);
      }
    }
  }
  return declared;
}

function buildComponent({ record, observedPath, isDeclaredRuntime, lockfileLabel }) {
  const { path: entryPath, entry } = record;
  const name = entryName(entryPath, entry);
  const version = typeof entry.version === 'string' ? entry.version : null;
  const ref = purlFor(name, version);
  const hashes = hashesFromIntegrity(entry.integrity);
  const licenses = licensesFor(entry.license);
  return {
    type: 'library',
    'bom-ref': ref,
    name,
    ...(version ? { version } : {}),
    purl: ref,
    scope: observedPath ? 'required' : isDeclaredRuntime ? 'optional' : 'excluded',
    ...(hashes.length > 0 ? { hashes } : {}),
    ...(licenses.length > 0 ? { licenses } : {}),
    ...(typeof entry.resolved === 'string' ? { externalReferences: [{ type: 'distribution', url: entry.resolved }] } : {}),
    properties: sortProperties([
      licenses.length === 0 && property('sfscanner:license-declared', `none declared in ${lockfileLabel} or ${entryPath}/package.json`),
      typeof entry.integrity === 'string' && property('sfscanner:lockfile-integrity', entry.integrity),
      property('sfscanner:lockfile-path', entryPath),
      property('sfscanner:observed-in-packed-artifact', Boolean(observedPath)),
      observedPath && property('sfscanner:observed-source-path', observedPath),
    ]),
  };
}

/**
 * Maps the closure to sorted, purl-keyed components plus the runtime edge map used for `dependencies`.
 * `observedPaths` are repository-relative files named by the packed bundle's source maps; a component
 * is shipped only when one of them belongs to it (its workspace directory, or its installed name).
 */
export function collectDependencyComponents({ packages, workspacePath, workspaceManifest, lockfileLabel, observedPaths = [] }) {
  const records = collectClosure({ packages, workspacePath, workspaceManifest });
  const declared = declaredRuntimePaths({ records, packages, workspacePath, workspaceManifest });
  const observedFor = (record) => (record.path.startsWith('node_modules/')
    ? observedPaths.find((candidate) => installedPackageName(candidate) === entryName(record.path, record.entry))
    : observedPaths.find((candidate) => candidate.startsWith(`${record.path}/`)));
  const byPurl = new Map();
  for (const record of records.values()) {
    const observedPath = observedFor(record);
    const component = buildComponent({ record, observedPath, isDeclaredRuntime: declared.has(record.path), lockfileLabel });
    const seen = byPurl.get(component.purl);
    if (seen) seen.properties.find(({ name }) => name === 'sfscanner:lockfile-path').value += `, ${record.path}`;
    else byPurl.set(component.purl, component);
  }
  const refsByPath = new Map([...records].map(([entryPath, record]) => [entryPath, purlFor(entryName(entryPath, record.entry), record.entry.version)]));
  return {
    components: [...byPurl.values()].sort((left, right) => compare(left.purl, right.purl)),
    refsByPath,
    edges: [...records.values()].filter(({ children }) => children.length > 0)
      .map(({ path: entryPath, children }) => ({ purl: refsByPath.get(entryPath), dependsOn: [...new Set(children)].map((child) => refsByPath.get(child)).filter(Boolean).sort() })),
  };
}
