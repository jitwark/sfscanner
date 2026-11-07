/**
 * The assertions a rollback rehearsal makes about a restored release, and the host steps
 * it cannot perform. They live here so the rehearsal script reads as the sequence it is,
 * and so the "what a rollback must restore" rules exist in one place.
 *
 * The unit is the site *and* the corpus: a deep link that resolves against a stale corpus,
 * or an asset reference the descriptor does not bound, is the half-restored state these
 * checks exist to catch.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fail, record, sha256 } from './release-artifacts.mjs';

const DEEP_LINK_ASSET = /<script src="\/([^"]+)"/u;

/** The steps a rehearsal cannot perform, because it never reaches a host. */
export const HOST_STEPS = Object.freeze([
  'Publish the staged snapshot to a noindex preview channel, replacing the global `X-Robots-Tag: index, follow` with `noindex, nofollow` for that channel only; the descriptor records the header it must override.',
  'Fetch the preview root and one deep link with `curl -sI` and require `X-Robots-Tag: noindex` on both.',
  'Fetch the immutable asset the deep link references with `curl -s -H "Range: bytes=0-99"`, require 206 with a correct Content-Range, then fetch it whole and compare its SHA-256 with the descriptor artifact for that path; require `Accept-Ranges: bytes` and an immutable Cache-Control.',
  'Request an unsatisfiable range (`Range: bytes=99999999-`) and require 416 while the whole-file fetch still succeeds.',
  'Fetch every path in the descriptor site artifact list and compare byte size and SHA-256 with the descriptor; any mismatch is a failed promotion.',
  'Roll the host release root back with `npm run rollback:release -- --release-root <root> --release-id <prior-id>`, then re-fetch the deep link and its asset and require the prior generation\'s digests, corpus identity and pointer.',
  'Confirm the preview is not indexed and that its robots.txt disallows every agent, then delete the preview channel.',
]);

/** A refusal must be an error, never a report line a reader has to notice. */
export function assert(condition, message) {
  if (!condition) fail(message);
}

/** The recorded artifact for one released path, from the section that owns it. */
export function artifactRecord(releaseValue, sectionName, artifactPath) {
  const artifacts = record(releaseValue?.[sectionName]) ? releaseValue[sectionName].artifacts : undefined;
  const artifact = Array.isArray(artifacts) ? artifacts.find((entry) => entry.path === artifactPath) : undefined;
  assert(artifact !== undefined, `the descriptor does not bind ${sectionName}/${artifactPath}`);
  return artifact;
}

export async function assertRestoredUnit({ root, releaseValue, releaseId, generation, other }) {
  const releaseRoot = path.join(root, 'releases', releaseId);
  const deepLinkBytes = await readFile(path.join(releaseRoot, 'site', generation.deepLink));
  assert(sha256(deepLinkBytes) === artifactRecord(releaseValue, 'site', generation.deepLink).sha256,
    'the restored deep link is not the byte the descriptor binds');
  assert(deepLinkBytes.includes(Buffer.from(`data-marker="${generation.marker}"`)), 'the restored deep link belongs to a different generation');
  assert(!deepLinkBytes.includes(Buffer.from(other.marker)), 'the restored deep link still carries the other generation');

  const referenced = deepLinkBytes.toString('utf8').match(DEEP_LINK_ASSET)?.[1] ?? '';
  assert(referenced === generation.assetPath, `the restored deep link references ${referenced || 'no asset'} rather than ${generation.assetPath}`);
  const assetBytes = await readFile(path.join(releaseRoot, 'site', referenced));
  assert(assetBytes.equals(generation.assetBytes), 'the restored immutable asset is not the staged byte');
  assert(sha256(assetBytes) === artifactRecord(releaseValue, 'site', referenced).sha256, 'the restored immutable asset is not the byte the descriptor binds');

  const corpusId = releaseValue.identity.corpus.corpusId;
  assert(corpusId === generation.corpusId, `the restored corpus is ${corpusId} rather than ${generation.corpusId}`);
  const manifestBytes = await readFile(path.join(releaseRoot, 'data', 'manifest.json'));
  assert(sha256(manifestBytes) === artifactRecord(releaseValue, 'data', 'manifest.json').sha256, 'the restored corpus manifest is not the byte the descriptor binds');
  assert(!manifestBytes.includes(Buffer.from(other.corpusId)), 'the restored corpus manifest names the other generation');

  const sitePaths = releaseValue.site.artifacts.map((entry) => entry.path);
  assert(!sitePaths.includes(other.assetPath), 'the restored site still carries the other generation\'s immutable asset');
  assert(releaseValue.rollbackIdentity.unit === 'site+data+export', 'the rollback unit is not the whole release');
  assert(releaseValue.rollbackIdentity.restore.join('+') === 'data+export+site', 'the rollback does not declare that it restores every section');
}
