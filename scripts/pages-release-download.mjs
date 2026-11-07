import { open } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { confinedPath, fail, MAX_ARCHIVE_BYTES } from './pages-release-paths.mjs';
import { verifyArchive } from './pages-release-tar.mjs';

export function releaseIdentity({ repository, tag, asset, sha256 }) {
  if (!/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(repository ?? '')) fail('invalid repository');
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/u.test(tag ?? '') || tag.includes('..')
    || /^(?:latest|refs\/)/iu.test(tag) || tag.endsWith('/')) fail('explicit release tag is required');
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\.tar$/u.test(asset ?? '')) fail('exact .tar asset name is required');
  if (!/^[a-f0-9]{64}$/u.test(sha256 ?? '')) fail('exact lowercase SHA256 is required');
  return { repository, tag, asset, sha256 };
}

export function selectReleaseAsset(release, identity) {
  if (release?.tag_name !== identity.tag || release.draft !== false || !Array.isArray(release.assets)) fail('release identity mismatch or draft');
  const matches = release.assets.filter((asset) => asset.name === identity.asset);
  if (matches.length !== 1) fail('release must contain exactly one matching asset');
  const asset = matches[0];
  if (!Number.isSafeInteger(asset.id) || asset.id <= 0 || asset.state !== 'uploaded'
    || !Number.isSafeInteger(asset.size) || asset.size < 1024 || asset.size > MAX_ARCHIVE_BYTES) fail('unsafe release asset');
  if (asset.digest != null && asset.digest !== `sha256:${identity.sha256}`) fail('release asset digest mismatch');
  return { id: asset.id, size: asset.size };
}

export async function downloadRelease(options, run = spawnSync) {
  const identity = releaseIdentity(options), archive = path.resolve(options.archive);
  await confinedPath(path.dirname(archive));
  const metadata = run('gh', ['api', `repos/${identity.repository}/releases/tags/${encodeURIComponent(identity.tag)}`],
    { encoding: 'utf8', shell: false });
  if (metadata.error || metadata.status !== 0) fail('release metadata download failed');
  const asset = selectReleaseAsset(JSON.parse(metadata.stdout), identity);
  const output = await open(archive, 'wx', 0o600);
  try {
    // Resolve an asset ID in this repository/tag; never trust a response URL as a fetch target.
    const downloaded = run('gh', ['api', `repos/${identity.repository}/releases/assets/${asset.id}`,
      '-H', 'Accept: application/octet-stream'], { shell: false, stdio: ['ignore', output.fd, 'pipe'] });
    if (downloaded.error || downloaded.status !== 0 || (await output.stat()).size !== asset.size) fail('release asset download failed or size mismatch');
  } finally { await output.close(); }
  return { ...identity, ...await verifyArchive(archive, identity.sha256) };
}
