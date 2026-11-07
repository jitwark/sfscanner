import fs from 'node:fs';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestOnlySeal,
  verifyTestOnlyConformance,
} from './dev-conformance.mjs';

describe('dev-conformance private test-only harness', () => {
  let tmpDir;
  let candidateDir;
  let sealPath;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dev-conformance-test-'));
    candidateDir = path.join(tmpDir, 'candidate');
    fs.mkdirSync(candidateDir, { recursive: true });
    fs.writeFileSync(path.join(candidateDir, 'cli.js'), 'console.log("cli");\n');
    fs.writeFileSync(path.join(candidateDir, 'worker.js'), 'console.log("worker");\n');
    sealPath = path.join(tmpDir, 'test-seal.json');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('passes conformance for a valid synthetic test seal', () => {
    const { canonicalJsonText, sealSha256 } = createTestOnlySeal(candidateDir, ['cli.js', 'worker.js']);
    fs.writeFileSync(sealPath, canonicalJsonText);

    const result = verifyTestOnlyConformance({
      sealPath,
      candidateDir,
      expectedSealSha256: sealSha256,
      isProduction: false,
    });
    expect(result.ok).toBe(true);
    expect(result.status).toBe('CONFORMANT_TEST_ONLY');
    expect(result.artifactCount).toBe(2);
  });

  it('fails if expected seal digest is omitted', () => {
    const result = verifyTestOnlyConformance({
      sealPath: path.join(tmpDir, 'absent.json'),
      candidateDir,
      isProduction: false,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('SEAL_DIGEST_REQUIRED');
  });

  it('fails if seal file is missing', () => {
    const result = verifyTestOnlyConformance({
      sealPath: path.join(tmpDir, 'absent.json'),
      candidateDir,
      expectedSealSha256: 'a'.repeat(64),
      isProduction: false,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('SEAL_MISSING');
  });

  it('fails if seal digest is mutated', () => {
    const { canonicalJsonText } = createTestOnlySeal(candidateDir, ['cli.js', 'worker.js']);
    fs.writeFileSync(sealPath, canonicalJsonText);

    const result = verifyTestOnlyConformance({
      sealPath,
      candidateDir,
      expectedSealSha256: '0'.repeat(64),
      isProduction: false,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('SEAL_DIGEST_MISMATCH');
  });

  it('fails if artifact content is modified', () => {
    const { canonicalJsonText, sealSha256 } = createTestOnlySeal(candidateDir, ['cli.js', 'worker.js']);
    fs.writeFileSync(sealPath, canonicalJsonText);
    fs.appendFileSync(path.join(candidateDir, 'cli.js'), '// mutated\n');

    const result = verifyTestOnlyConformance({
      sealPath,
      candidateDir,
      expectedSealSha256: sealSha256,
      isProduction: false,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('ARTIFACT_SIZE_MISMATCH');
  });

  it('fails if an artifact file is deleted', () => {
    const { canonicalJsonText, sealSha256 } = createTestOnlySeal(candidateDir, ['cli.js', 'worker.js']);
    fs.writeFileSync(sealPath, canonicalJsonText);
    fs.rmSync(path.join(candidateDir, 'worker.js'));

    const result = verifyTestOnlyConformance({
      sealPath,
      candidateDir,
      expectedSealSha256: sealSha256,
      isProduction: false,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('ARTIFACT_MISSING');
  });

  it('rejects test-only seal when run in production mode', () => {
    const { canonicalJsonText, sealSha256 } = createTestOnlySeal(candidateDir, ['cli.js']);
    fs.writeFileSync(sealPath, canonicalJsonText);

    const result = verifyTestOnlyConformance({
      sealPath,
      candidateDir,
      expectedSealSha256: sealSha256,
      isProduction: true,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('TEST_ONLY_SEAL_NOT_PERMITTED_IN_PRODUCTION');
  });

  it('rejects path traversal attempts in descriptor', () => {
    const outside = path.join(tmpDir, 'outside.json');
    fs.writeFileSync(outside, 'secret');
    const descriptor = {
      schemaVersion: 'scanner-test-seal-v1',
      mode: 'TEST_ONLY',
      createdAt: '2026-10-26T00:00:00.000Z',
      artifacts: [{ path: '../outside.json', byteLength: 6, sha256: '0'.repeat(64) }],
    };
    fs.writeFileSync(sealPath, JSON.stringify(descriptor, null, 2));
    const raw = JSON.stringify(descriptor, null, 2);
    const result = verifyTestOnlyConformance({
      sealPath,
      candidateDir,
      expectedSealSha256: crypto.createHash('sha256').update(raw).digest('hex'),
      isProduction: false,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('ARTIFACT_PATH_TRAVERSAL');
  });

  it('rejects null artifact entries without throwing unhandled exceptions', () => {
    const descriptor = {
      schemaVersion: 'scanner-test-seal-v1',
      mode: 'TEST_ONLY',
      createdAt: '2026-10-26T00:00:00.000Z',
      artifacts: [null],
    };
    fs.writeFileSync(sealPath, JSON.stringify(descriptor, null, 2));
    const raw = JSON.stringify(descriptor, null, 2);
    const result = verifyTestOnlyConformance({
      sealPath,
      candidateDir,
      expectedSealSha256: crypto.createHash('sha256').update(raw).digest('hex'),
      isProduction: false,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('ARTIFACT_ENTRY_MALFORMED');
  });

  it('rejects duplicate artifact entries', () => {
    const descriptor = {
      schemaVersion: 'scanner-test-seal-v1',
      mode: 'TEST_ONLY',
      createdAt: '2026-10-26T00:00:00.000Z',
      artifacts: [
        { path: 'cli.js', byteLength: 19, sha256: '0'.repeat(64) },
        { path: 'cli.js', byteLength: 19, sha256: '0'.repeat(64) },
      ],
    };
    fs.writeFileSync(sealPath, JSON.stringify(descriptor, null, 2));
    const raw = JSON.stringify(descriptor, null, 2);
    const result = verifyTestOnlyConformance({
      sealPath,
      candidateDir,
      expectedSealSha256: crypto.createHash('sha256').update(raw).digest('hex'),
      isProduction: false,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('ARTIFACT_DUPLICATE_ENTRY');
  });

  it('rejects extra unknown properties on descriptor or artifact', () => {
    const descriptor = {
      schemaVersion: 'scanner-test-seal-v1',
      mode: 'TEST_ONLY',
      createdAt: '2026-10-26T00:00:00.000Z',
      artifacts: [{ path: 'cli.js', byteLength: 19, sha256: '0'.repeat(64), extra: true }],
    };
    fs.writeFileSync(sealPath, JSON.stringify(descriptor, null, 2));
    const raw = JSON.stringify(descriptor, null, 2);
    const result = verifyTestOnlyConformance({
      sealPath,
      candidateDir,
      expectedSealSha256: crypto.createHash('sha256').update(raw).digest('hex'),
      isProduction: false,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('ARTIFACT_ENTRY_EXTRA_PROPERTIES');
  });

  it('fails if a required artifact is missing from the seal (missing-worker)', () => {
    const { canonicalJsonText, sealSha256 } = createTestOnlySeal(candidateDir, ['cli.js']);
    fs.writeFileSync(sealPath, canonicalJsonText);
    const result = verifyTestOnlyConformance({
      sealPath,
      candidateDir,
      expectedSealSha256: sealSha256,
      requiredArtifacts: ['cli.js', 'worker.js'],
      isProduction: false,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('REQUIRED_ARTIFACT_MISSING');
    expect(result.file).toBe('worker.js');
  });

  it('fails if candidate directory contains an unexpected executable asset (extra-executable)', () => {
    const { canonicalJsonText, sealSha256 } = createTestOnlySeal(candidateDir, ['cli.js', 'worker.js']);
    fs.writeFileSync(sealPath, canonicalJsonText);
    fs.writeFileSync(path.join(candidateDir, 'extra-tool.js'), 'console.log("unsealed");\n');
    const result = verifyTestOnlyConformance({
      sealPath,
      candidateDir,
      expectedSealSha256: sealSha256,
      isProduction: false,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('UNEXPECTED_EXECUTABLE_ASSET');
    expect(result.file).toBe('extra-tool.js');
  });
});
