import { createHash } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import {
  candidateDescriptorDigest,
  createCandidateDescriptor,
  createGateAttestation,
  sealCandidate,
  verifyCandidateSeal,
} from './candidate-identity.mjs';
import { canonicalJson } from './scanner-result-digest.mjs';

/**
 * Q10.0 candidate identity is a three-edge, acyclic chain: the descriptor names
 * the frozen inputs, the seal names the exact candidate bytes, and the
 * attestation records one gate result against that seal. These tests pin the
 * canonical encodings, every refusal that keeps the chain from pointing at
 * itself, and the fact that verification is a read-only recomputation rather
 * than trust in the record it is handed.
 */

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

const hex = (seed, length = 64) => seed.repeat(length).slice(0, length);
const hashOf = (value) => createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
const descriptorInput = (overrides = {}) => ({
  sourceCommit: hex('a', 40),
  sourceFilesDigest: hex('1'),
  lockfileDigest: hex('2'),
  toolchainDigest: hex('3'),
  rulesDigest: hex('4'),
  semanticsDigest: hex('5'),
  profileDigest: hex('6'),
  limitsDigest: hex('7'),
  targetDigest: hex('8'),
  advisoryDigest: hex('9'),
  inventoryDigest: hex('0'),
  ...overrides,
});
const artifact = (path, bytes = 1, sha256 = hex('d')) => ({ path, bytes, sha256 });
const gateInput = (overrides = {}) => ({
  gate: 'check:candidate-identity',
  commandDigest: hex('a'),
  environmentDigest: hex('b'),
  exitCode: 0,
  outcome: 'PASS',
  evidenceDigest: hex('c'),
  ...overrides,
});

const descriptor = createCandidateDescriptor(descriptorInput());
const artifacts = Object.freeze([artifact('data/z.json', 2), artifact('data/a.json', 1)]);
const seal = sealCandidate(descriptor, artifacts);

describe('candidate descriptor', () => {
  test('builds exactly the contract keys, frozen and versioned', () => {
    expect(Object.keys(descriptor).sort()).toEqual(['schemaVersion', ...DESCRIPTOR_FIELDS].sort());
    expect(descriptor.schemaVersion).toBe('1');
    expect(Object.isFrozen(descriptor)).toBe(true);
    expect(candidateDescriptorDigest(descriptor)).toMatch(/^[a-f0-9]{64}$/u);
  });

  test('hashes the canonical descriptor independently of key insertion order', () => {
    const reversed = createCandidateDescriptor(Object.fromEntries(Object.entries(descriptorInput()).reverse()));

    expect(candidateDescriptorDigest(reversed)).toBe(candidateDescriptorDigest(descriptor));
    expect(candidateDescriptorDigest(descriptor)).toBe(hashOf(descriptor));
  });

  test('refuses malformed or unexpected identity fields', () => {
    expect(() => createCandidateDescriptor(null)).toThrow(/must be an object/u);
    expect(() => createCandidateDescriptor(descriptorInput({ sourceCommit: 'A'.repeat(40) }))).toThrow(/sourceCommit/u);
    expect(() => createCandidateDescriptor(descriptorInput({ rulesDigest: hex('4', 63) }))).toThrow(/rulesDigest/u);
    expect(() => createCandidateDescriptor(descriptorInput({ inventoryDigest: undefined }))).toThrow(/inventoryDigest/u);
    expect(() => createCandidateDescriptor({ ...descriptorInput(), sealed: true })).toThrow(/unknown key/u);
    expect(() => createCandidateDescriptor(descriptorInput({ schemaVersion: '2' }))).toThrow(/schemaVersion/u);
    const missing = descriptorInput();
    delete missing.limitsDigest;
    expect(() => createCandidateDescriptor(missing)).toThrow(/limitsDigest/u);
  });

  test('requires a versioned descriptor from every consumer but not from the writer input', () => {
    const unversioned = descriptorInput();

    expect(createCandidateDescriptor(unversioned).schemaVersion).toBe('1');
    expect(() => candidateDescriptorDigest(unversioned)).toThrow(/schemaVersion/u);
    expect(() => sealCandidate(unversioned, artifacts)).toThrow(/schemaVersion/u);
    expect(() => createGateAttestation(unversioned, seal, gateInput())).toThrow(/schemaVersion/u);
    const result = verifyCandidateSeal(unversioned, seal, artifacts);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/schemaVersion/u);
  });
});

describe('artifact seal', () => {
  test('sorts artifacts into UTF-16 path order deterministically', () => {
    const forward = sealCandidate(descriptor, artifacts);
    const reversed = sealCandidate(descriptor, [...artifacts].reverse());

    expect(reversed).toEqual(forward);
    expect(forward.artifacts.map(({ path }) => path)).toEqual(['data/a.json', 'data/z.json']);
    expect(forward.descriptorDigest).toBe(hashOf(descriptor));
    expect(forward.sealDigest).toBe(hashOf({ descriptorDigest: forward.descriptorDigest, artifacts: forward.artifacts }));
    expect(Object.keys(forward).sort()).toEqual(['artifacts', 'descriptorDigest', 'sealDigest']);
    expect(Object.keys(forward.artifacts[0]).sort()).toEqual(['bytes', 'path', 'sha256']);
  });

  test('orders paths by UTF-16 code unit, not locale collation', () => {
    const cased = sealCandidate(descriptor, [artifact('a/a.json'), artifact('a/B.json')]);

    expect(cased.artifacts.map(({ path }) => path)).toEqual(['a/B.json', 'a/a.json']);
  });

  test('seals only its descriptor digest and artifact tuples, never itself or an attestation', () => {
    expect(seal.sealDigest).not.toBe(hashOf(seal));
    expect(verifyCandidateSeal(descriptor, seal, artifacts)).toEqual({ ok: true });

    const selfReferenced = verifyCandidateSeal(descriptor, { ...seal, attestation: { outcome: 'PASS' } }, artifacts);
    expect(selfReferenced.ok).toBe(false);
    expect(selfReferenced.reason).toMatch(/keys outside the contract/u);
    expect(() => sealCandidate(descriptor, [{ path: 'seal.json', bytes: 0, sha256: hex('d'), sealDigest: hex('f') }]))
      .toThrow(/keys outside the contract/u);
    expect(() => sealCandidate(descriptor, [seal])).toThrow(/keys outside the contract/u);
  });

  test('allows an empty artifact list', () => {
    const empty = sealCandidate(descriptor, []);

    expect(empty.artifacts).toEqual([]);
    expect(verifyCandidateSeal(descriptor, empty, [])).toEqual({ ok: true });
  });

  const reversedArtifacts = [...seal.artifacts].reverse();
  const unsorted = {
    ...seal,
    artifacts: reversedArtifacts,
    sealDigest: hashOf({ descriptorDigest: seal.descriptorDigest, artifacts: reversedArtifacts }),
  };
  const tamperedArtifacts = [artifact('data/a.json', 9), artifact('data/z.json', 2)];
  const storedTampered = {
    ...seal,
    artifacts: tamperedArtifacts,
    sealDigest: hashOf({ descriptorDigest: seal.descriptorDigest, artifacts: tamperedArtifacts }),
  };

  test.each([
    ['a changed descriptor field', () => [createCandidateDescriptor(descriptorInput({ rulesDigest: hex('e') })), seal, artifacts], /descriptor digest/u],
    ['changed artifact bytes', () => [descriptor, seal, [artifact('data/a.json', 1), artifact('data/z.json', 9)]], /artifacts do not match/u],
    ['a changed artifact hash', () => [descriptor, seal, [artifact('data/a.json', 1), artifact('data/z.json', 2, hex('e'))]], /artifacts do not match/u],
    ['a missing artifact', () => [descriptor, seal, [artifact('data/a.json', 1)]], /artifacts do not match/u],
    ['an extra artifact', () => [descriptor, seal, [...artifacts, artifact('data/m.json')]], /artifacts do not match/u],
    ['a duplicate artifact', () => [descriptor, seal, [...artifacts, artifact('data/a.json')]], /duplicate artifact path/u],
    ['a tampered seal digest', () => [descriptor, { ...seal, sealDigest: hex('f') }, artifacts], /seal digest/u],
    ['a stored artifact list with a recomputed digest', () => [descriptor, storedTampered, artifacts], /artifacts do not match/u],
    ['a stored artifact list out of canonical order', () => [descriptor, unsorted, artifacts], /canonical order/u],
    ['a seal carrying an attestation', () => [descriptor, { ...seal, attestation: {} }, artifacts], /keys outside the contract/u],
    ['a seal that is not an object', () => [descriptor, null, artifacts], /must be an object/u],
  ])('refuses %s', (_label, build, reason) => {
    const [descriptorArg, sealArg, artifactsArg] = build();
    const result = verifyCandidateSeal(descriptorArg, sealArg, artifactsArg);

    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(reason);
  });

  test.each([
    ['a fractional byte count', artifact('data/a.json', 1.5), /bytes/u],
    ['a negative byte count', artifact('data/a.json', -1), /bytes/u],
    ['an uppercase artifact hash', artifact('data/a.json', 1, hex('D')), /sha256/u],
  ])('refuses %s', (_label, entry, reason) => {
    expect(() => sealCandidate(descriptor, [entry])).toThrow(reason);
    const result = verifyCandidateSeal(descriptor, seal, [entry]);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(reason);
  });

  test.each([
    '../escape.json',
    'data/../../escape.json',
    '/absolute.json',
    'C:/absolute.json',
    'data\\file.json',
    'data/report.json:secret',
    'NUL',
    'data/NUL.txt',
    'com1.txt',
    'data/LPT9.log',
    '',
    '.',
    '..',
    './data/a.json',
    'data/./a.json',
    'data//a.json',
    'data/',
  ])('refuses the non-canonical artifact path %j', (invalidPath) => {
    expect(() => sealCandidate(descriptor, [artifact(invalidPath)])).toThrow(/canonical POSIX relative path/u);
    const result = verifyCandidateSeal(descriptor, seal, [artifact(invalidPath)]);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/canonical POSIX relative path/u);
  });

  test('keeps ordinary names that merely resemble a Windows device', () => {
    const accepted = sealCandidate(descriptor, [
      artifact('data/console.txt'),
      artifact('data/com10.txt'),
      artifact('data/NULish.log'),
      artifact('data/con-sole.txt'),
    ]);

    expect(accepted.artifacts.map(({ path }) => path)).toEqual([
      'data/NULish.log',
      'data/com10.txt',
      'data/con-sole.txt',
      'data/console.txt',
    ]);
    expect(verifyCandidateSeal(descriptor, accepted, accepted.artifacts)).toEqual({ ok: true });
  });

  test('verification recomputes from frozen inputs and mutates nothing', () => {
    const before = JSON.stringify({ descriptor, seal, artifacts });

    expect(verifyCandidateSeal(descriptor, seal, [...artifacts].reverse())).toEqual({ ok: true });
    expect(JSON.stringify({ descriptor, seal, artifacts })).toBe(before);
  });
});

describe('gate attestation', () => {
  const attestation = createGateAttestation(descriptor, seal, gateInput());

  test('binds a PASS result to the descriptor and seal in exact keys', () => {
    expect(Object.keys(attestation).sort()).toEqual([
      'attestationDigest',
      'commandDigest',
      'descriptorDigest',
      'environmentDigest',
      'evidenceDigest',
      'exitCode',
      'gate',
      'outcome',
      'sealDigest',
    ].sort());
    expect(attestation.descriptorDigest).toBe(seal.descriptorDigest);
    expect(attestation.sealDigest).toBe(seal.sealDigest);
    expect(attestation.outcome).toBe('PASS');
    expect(attestation.exitCode).toBe(0);
    const { attestationDigest, ...body } = attestation;
    expect(attestationDigest).toBe(hashOf(body));
  });

  test('is never sealed as an artifact and never feeds the seal digest', () => {
    expect(seal.artifacts.some(({ sha256 }) => sha256 === attestation.attestationDigest)).toBe(false);
    expect(seal.sealDigest).toBe(hashOf({ descriptorDigest: seal.descriptorDigest, artifacts: seal.artifacts }));

    const withAttestation = verifyCandidateSeal(descriptor, seal, [...artifacts, artifact('attestation.json', 0, attestation.attestationDigest)]);
    expect(withAttestation.ok).toBe(false);
    expect(withAttestation.reason).toMatch(/artifacts do not match/u);
  });

  test('records a null exit code for an interrupted run', () => {
    const interrupted = createGateAttestation(descriptor, seal, gateInput({ exitCode: null, outcome: 'INTERRUPTED' }));

    expect(interrupted.exitCode).toBeNull();
    expect(interrupted.outcome).toBe('INTERRUPTED');
  });

  test.each([
    ['an unknown outcome', { outcome: 'OK' }, /outcome/u],
    ['a malformed command digest', { commandDigest: 'abc' }, /commandDigest/u],
    ['an uppercase environment digest', { environmentDigest: hex('B') }, /environmentDigest/u],
    ['a malformed evidence digest', { evidenceDigest: 'x' }, /evidenceDigest/u],
    ['a fractional exit code', { exitCode: 1.5 }, /exitCode/u],
    ['an empty gate', { gate: '' }, /gate/u],
    ['a gate with whitespace', { gate: 'check: candidate' }, /gate/u],
    ['an undeclared attestation field', { note: 'extra' }, /keys outside the contract/u],
  ])('refuses %s', (_label, override, reason) => {
    expect(() => createGateAttestation(descriptor, seal, gateInput(override))).toThrow(reason);
  });

  test('refuses a seal or descriptor that moved after sealing', () => {
    expect(() => createGateAttestation(createCandidateDescriptor(descriptorInput({ targetDigest: hex('e') })), seal, gateInput())).toThrow(/candidate seal/u);
    expect(() => createGateAttestation(descriptor, { ...seal, sealDigest: hex('f') }, gateInput())).toThrow(/candidate seal/u);
  });
});

describe('immutability', () => {
  test('freezes every published value and never freezes caller input', () => {
    const input = descriptorInput();
    const supplied = [artifact('b.json', 2), artifact('a.json', 1)];
    const snapshot = JSON.stringify({ input, supplied });
    const frozenDescriptor = createCandidateDescriptor(input);
    const frozenSeal = sealCandidate(frozenDescriptor, supplied);
    const frozenAttestation = createGateAttestation(frozenDescriptor, frozenSeal, gateInput());

    expect(JSON.stringify({ input, supplied })).toBe(snapshot);
    expect(Object.isFrozen(input)).toBe(false);
    expect(Object.isFrozen(supplied)).toBe(false);
    for (const value of [frozenDescriptor, frozenSeal, frozenSeal.artifacts, ...frozenSeal.artifacts, frozenAttestation]) {
      expect(Object.isFrozen(value)).toBe(true);
    }
    expect(() => { frozenDescriptor.rulesDigest = hex('e'); }).toThrow(TypeError);
    expect(() => { frozenSeal.sealDigest = hex('e'); }).toThrow(TypeError);
    expect(() => { frozenSeal.artifacts.push(frozenSeal.artifacts[0]); }).toThrow(TypeError);
    expect(() => { frozenAttestation.outcome = 'FAIL'; }).toThrow(TypeError);
  });

  test('rejects undefined values rather than omitting them', () => {
    expect(() => sealCandidate(descriptor, [{ path: 'a.json', bytes: 1, sha256: undefined }])).toThrow(/sha256/u);
    expect(() => createCandidateDescriptor(descriptorInput({ advisoryDigest: undefined }))).toThrow(/advisoryDigest/u);
    expect(() => createGateAttestation(descriptor, seal, gateInput({ exitCode: undefined }))).toThrow(/exitCode/u);
  });
});
