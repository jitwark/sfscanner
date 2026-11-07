/**
 * The local Q10.0 candidate identity chain: a `CandidateDescriptor` names the
 * frozen inputs, an `ArtifactSeal` names the exact candidate bytes, and a
 * `GateAttestation` records one gate result against that seal.
 *
 * The chain is acyclic by construction and the digests say so. The descriptor
 * digest covers only the descriptor; the seal digest covers the descriptor
 * digest plus the sorted artifact tuples and never the seal itself; the
 * attestation digest covers the seal digest plus the observed gate result and
 * never itself or the sealed bytes. An attestation is evidence about a seal,
 * never an artifact of it, so sealing a reviewed candidate cannot require
 * sealing its own review.
 *
 * The published release schemas in `release-schemas.mjs` stay authoritative for
 * a release. This module only freezes local candidate bytes and the
 * deterministic canonical encoding the two existing primitives already define.
 */
import { comparePaths, fail, record, sha256 } from './release-artifacts.mjs';
import { canonicalJson } from './scanner-result-digest.mjs';

const DIGEST = /^[a-f0-9]{64}$/u;
const COMMIT = /^[a-f0-9]{40}$/u;
const GATE = /^[A-Za-z0-9][A-Za-z0-9._:+-]*$/u;
const RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/iu;
const SCHEMA_VERSION = '1';
const OUTCOMES = Object.freeze(['PASS', 'FAIL', 'BLOCKED', 'INTERRUPTED']);

const DESCRIPTOR_FIELDS = Object.freeze([
  'sourceCommit',
  'sourceFilesDigest',
  'lockfileDigest',
  'toolchainDigest',
  'rulesDigest',
  'semanticsDigest',
  'profileDigest',
  'limitsDigest',
  'targetDigest',
  'advisoryDigest',
  'inventoryDigest',
]);
const DESCRIPTOR_KEYS = Object.freeze(['schemaVersion', ...DESCRIPTOR_FIELDS]);
const ARTIFACT_KEYS = Object.freeze(['path', 'bytes', 'sha256']);
const SEAL_KEYS = Object.freeze(['descriptorDigest', 'artifacts', 'sealDigest']);
const ATTESTATION_INPUT_KEYS = Object.freeze([
  'gate',
  'commandDigest',
  'environmentDigest',
  'exitCode',
  'outcome',
  'evidenceDigest',
]);

function exactKeys(value, keys, label) {
  if (!record(value)) fail(`${label} must be an object`);
  const actual = Object.keys(value).sort(comparePaths);
  const expected = [...keys].sort(comparePaths);
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail(`${label} has keys outside the contract: ${actual.join(', ')}`);
  }
  return value;
}

function exactDigest(value, label) {
  if (typeof value !== 'string' || !DIGEST.test(value)) fail(`${label} must be 64 lowercase hex characters`);
  return value;
}

/** The descriptor is rebuilt field by field, so unknown keys and `undefined` can never survive. */
function normalizedDescriptor(value, { versionOptional = false } = {}) {
  if (!record(value)) fail('candidate descriptor must be an object');
  for (const key of Object.keys(value)) {
    if (!DESCRIPTOR_KEYS.includes(key)) fail(`candidate descriptor has an unknown key: ${key}`);
  }
  if (value.schemaVersion === undefined ? !versionOptional : value.schemaVersion !== SCHEMA_VERSION) {
    fail('candidate descriptor schemaVersion is invalid');
  }
  const descriptor = { schemaVersion: SCHEMA_VERSION };
  for (const field of DESCRIPTOR_FIELDS) {
    const fieldValue = value[field];
    if (typeof fieldValue !== 'string' || !(field === 'sourceCommit' ? COMMIT : DIGEST).test(fieldValue)) {
      fail(`candidate descriptor ${field} is invalid`);
    }
    descriptor[field] = fieldValue;
  }
  return Object.freeze(descriptor);
}

/**
 * A sealed artifact path is canonical POSIX relative, and it is also never a
 * Windows device name or alternate data stream: this repository stages
 * candidate bytes on Windows, where `report.json:secret` and `NUL.txt` name
 * something other than the file the seal claims. Drive syntax falls to the same
 * colon rule, and reserved stems are matched before the first dot, so
 * `NUL.tar.gz` is refused while `NULish.log` and `com10.txt` are ordinary names.
 */
function canonicalPath(value, label) {
  const segments = typeof value === 'string' ? value.split('/') : [];
  const unsafe = segments.some((segment) => segment === '' || segment === '.' || segment === '..' ||
    segment.includes(':') || RESERVED.test(segment.split('.')[0]));
  if (typeof value !== 'string' || value === '' || value.includes('\\') || value.includes('\0') ||
    value.startsWith('/') || unsafe) {
    fail(`${label} path is not a canonical POSIX relative path`);
  }
  return value;
}

function normalizedArtifact(value, label) {
  exactKeys(value, ARTIFACT_KEYS, label);
  const path = canonicalPath(value.path, label);
  if (!Number.isSafeInteger(value.bytes) || value.bytes < 0) fail(`${label} bytes is not a safe non-negative integer`);
  return Object.freeze({ path, bytes: value.bytes, sha256: exactDigest(value.sha256, `${label} sha256`) });
}

/** Sorting is what makes a reordered input produce the same seal; duplicates are refused first. */
function normalizedArtifacts(artifacts) {
  if (!Array.isArray(artifacts)) fail('candidate seal artifacts must be an array');
  const normalized = artifacts.map((artifact, index) => normalizedArtifact(artifact, `candidate seal artifact ${index}`));
  const seen = new Set();
  for (const artifact of normalized) {
    if (seen.has(artifact.path)) fail(`candidate seal has a duplicate artifact path: ${artifact.path}`);
    seen.add(artifact.path);
  }
  return Object.freeze(normalized.sort((left, right) => comparePaths(left.path, right.path)));
}

/** The writer is the only entry point that may omit `schemaVersion`; every consumer requires it. */
export function createCandidateDescriptor(input) {
  return normalizedDescriptor(input, { versionOptional: true });
}

export function candidateDescriptorDigest(descriptor) {
  return sha256(canonicalJson(normalizedDescriptor(descriptor)));
}

export function sealCandidate(descriptor, artifacts) {
  const frozenDescriptor = normalizedDescriptor(descriptor);
  const frozenArtifacts = normalizedArtifacts(artifacts);
  const descriptorDigest = sha256(canonicalJson(frozenDescriptor));
  const sealDigest = sha256(canonicalJson({ descriptorDigest, artifacts: frozenArtifacts }));
  return Object.freeze({ descriptorDigest, artifacts: frozenArtifacts, sealDigest });
}

/**
 * Recomputes the whole chain and throws on the first difference. Kept separate
 * from `verifyCandidateSeal` so the attestation writer can reuse the recomputed
 * digest instead of trusting the seal it was handed.
 */
function checkedSeal(descriptor, seal, artifacts) {
  const frozenDescriptor = normalizedDescriptor(descriptor);
  exactKeys(seal, SEAL_KEYS, 'candidate seal');
  const stored = normalizedArtifacts(seal.artifacts);
  if (stored.some((artifact, index) => artifact.path !== seal.artifacts[index].path)) {
    fail('candidate seal artifact list is not in canonical order');
  }
  const expected = sealCandidate(frozenDescriptor, artifacts);
  if (seal.descriptorDigest !== expected.descriptorDigest) fail('candidate seal descriptor digest does not match its descriptor');
  if (canonicalJson(stored) !== canonicalJson(expected.artifacts)) fail('candidate seal artifacts do not match the supplied artifacts');
  if (seal.sealDigest !== expected.sealDigest) fail('candidate seal digest is invalid');
  return expected;
}

export function verifyCandidateSeal(descriptor, seal, artifacts) {
  try {
    checkedSeal(descriptor, seal, artifacts);
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

export function createGateAttestation(descriptor, seal, input) {
  if (!record(seal)) fail('candidate seal must be an object');
  const checked = checkedSeal(descriptor, seal, seal.artifacts);
  exactKeys(input, ATTESTATION_INPUT_KEYS, 'gate attestation input');
  if (typeof input.gate !== 'string' || !GATE.test(input.gate)) fail('gate attestation gate is invalid');
  const commandDigest = exactDigest(input.commandDigest, 'gate attestation commandDigest');
  const environmentDigest = exactDigest(input.environmentDigest, 'gate attestation environmentDigest');
  const evidenceDigest = exactDigest(input.evidenceDigest, 'gate attestation evidenceDigest');
  if (input.exitCode !== null && !Number.isSafeInteger(input.exitCode)) fail('gate attestation exitCode is invalid');
  if (!OUTCOMES.includes(input.outcome)) fail('gate attestation outcome is invalid');
  const body = {
    descriptorDigest: checked.descriptorDigest,
    sealDigest: checked.sealDigest,
    gate: input.gate,
    commandDigest,
    environmentDigest,
    exitCode: input.exitCode,
    outcome: input.outcome,
    evidenceDigest,
  };
  return Object.freeze({ ...body, attestationDigest: sha256(canonicalJson(body)) });
}
