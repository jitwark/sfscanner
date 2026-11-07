import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, linkSync, mkdtempSync, readFileSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assertRetainedManifest, assertRetainedSeal, readRetainedOptions, retainedHash, sealRetainedTarball } from './lib/retained-tarball.mjs';
import { retainedEnvelope, retainedMcpSession, retainedNdjson } from './lib/retained-cli-controls.mjs';

const owned = [];
const temporary = () => { const dir = mkdtempSync(path.join(os.tmpdir(), 'retained-unit-')); owned.push(dir); return dir; };
afterEach(() => { for (const dir of owned.splice(0)) { if (path.dirname(dir) !== path.resolve(os.tmpdir())) throw new Error('Unexpected test directory'); rmSync(dir, { recursive: true, force: true }); } });
const args = (archive, extra = ['--sha256', 'a'.repeat(64)]) => ['--tarball', archive, '--expected-version', '0.2.1', ...extra];

describe('retained archive consumer boundary', () => {
  it('requires an explicit archive, version and one canonical digest', () => {
    const archive = path.join(temporary(), 'candidate.tgz');
    expect(readRetainedOptions(args(archive)).tarball).toBe(archive);
    for (const input of [[], args('relative.tgz'), args(archive, []), args(archive, ['--sha256', 'A'.repeat(64)]), args(archive, ['--sri', 'sha512-bad']), [...args(archive), '--sha256', 'b'.repeat(64)], [...args(archive), '--pack', 'true']]) expect(() => readRetainedOptions(input)).toThrow();
  });
  it('accepts only a canonical SHA-512 integrity value', () => {
    const archive = path.join(temporary(), 'candidate.tgz'); const sri = 'sha512-' + retainedHash(Buffer.from('candidate'), 'sha512');
    expect(readRetainedOptions(args(archive, ['--sri', sri])).sri).toBe(sri);
    expect(() => readRetainedOptions(args(archive, ['--sha256', 'a'.repeat(64), '--sri', sri]))).toThrow();
  });
  it('seals the selected bytes without changing the source archive', () => {
    const source = temporary(); const target = temporary(); const archive = path.join(source, 'candidate.tgz'); const bytes = Buffer.from('selected candidate bytes'); writeFileSync(archive, bytes);
    const options = readRetainedOptions(args(archive, ['--sha256', retainedHash(bytes)])); const seal = sealRetainedTarball(options, target);
    expect(readFileSync(seal.sealedPath)).toEqual(bytes); expect(readFileSync(archive)).toEqual(bytes); expect(assertRetainedSeal(seal)).toBe(true);
    writeFileSync(archive, 'later unrelated archive'); expect(assertRetainedSeal(seal)).toBe(true);
  });
  it('refuses missing, empty, non-file and digest-mismatching archives before installation', () => {
    const dir = temporary(); const archive = path.join(dir, 'candidate.tgz');
    expect(() => sealRetainedTarball(readRetainedOptions(args(archive)), temporary())).toThrow();
    expect(() => sealRetainedTarball(readRetainedOptions(args(dir)), temporary())).toThrow();
    writeFileSync(archive, ''); expect(() => sealRetainedTarball(readRetainedOptions(args(archive)), temporary())).toThrow();
    writeFileSync(archive, 'wrong bytes'); expect(() => sealRetainedTarball(readRetainedOptions(args(archive)), temporary())).toThrow('digest mismatch');
  });
  it('detects substitution of the sealed archive', () => {
    const dir = temporary(); const archive = path.join(dir, 'candidate.tgz'); const bytes = Buffer.from('candidate'); writeFileSync(archive, bytes);
    const seal = sealRetainedTarball(readRetainedOptions(args(archive, ['--sha256', retainedHash(bytes)])), temporary());
    chmodSync(seal.sealedPath, 0o600); writeFileSync(seal.sealedPath, 'substitution'); expect(() => assertRetainedSeal(seal)).toThrow('changed');
  });
  it('rejects a wrong identity or hidden runtime dependency', () => {
    const manifest = { name: 'sfscanner', version: '0.2.1', type: 'module', engines: { node: '>=22 <23' }, imports: { '#sfscanner-worker': './dist/scan-worker.js' }, bin: { sfscanner: 'dist/main.js', 'sfscanner-mcp': 'dist/mcp.js' }, exports: Object.fromEntries(['.', './v2/arguments', './v2/cli-runner', './v2/help', './v2/metadata-output', './v2/preflight-readiness', './v2/privacy-prepare'].map((key) => { const stem = key === '.' ? 'index' : key.slice(2); return [key, { import: `./dist/${stem}.js`, types: `./dist/${stem}.d.ts` }]; })) };
    expect(assertRetainedManifest(manifest, '0.2.1')).toBe(true);
    for (const patch of [{ name: 'other' }, { version: '0.2.0' }, { dependencies: { hidden: '*' } }, { engines: { node: '>=24' } }, { imports: {} }, { bin: { sfscanner: 'dist/main.js' } }, { bin: { sfscanner: 'dist/mcp.js', 'sfscanner-mcp': 'dist/main.js' } }, { exports: {} }, { exports: { ...manifest.exports, '.': { import: '../outside.js', types: './dist/index.d.ts' } } }, { scripts: { postinstall: 'node outside.js' } }]) expect(() => assertRetainedManifest({ ...manifest, ...patch }, '0.2.1')).toThrow();
  });
  it('refuses sealed hard-link aliases and oversized substitutions before allocation', () => {
    const dir = temporary(); const archive = path.join(dir, 'candidate.tgz'); const bytes = Buffer.from('candidate'); writeFileSync(archive, bytes);
    const seal = sealRetainedTarball(readRetainedOptions(args(archive, ['--sha256', retainedHash(bytes)])), temporary());
    linkSync(seal.sealedPath, path.join(dir, 'alias.tgz')); expect(() => assertRetainedSeal(seal)).toThrow();
    rmSync(path.join(dir, 'alias.tgz')); chmodSync(seal.sealedPath, 0o600); truncateSync(seal.sealedPath, 129 * 1024 * 1024); expect(() => assertRetainedSeal(seal)).toThrow();
  });
  it('reads actual envelope and typed NDJSON structures, rejecting item-only false positives', () => {
    const value = { schemaVersion: 'n8n-scan-v2', tool: {}, artifacts: {}, invocation: {}, results: [{ input: 'clean.json', ok: true, result: {} }], summary: {}, exitReason: 'UNDER_THRESHOLD' };
    expect(retainedEnvelope(JSON.stringify(value)).results[0].ok).toBe(true);
    expect(() => retainedEnvelope(JSON.stringify(value.results[0]))).toThrow();
    const rows = ['header', 'result', 'result', 'summary'].map((type) => ({ type, schemaVersion: 'n8n-scan-v2-ndjson' }));
    expect(retainedNdjson(rows.map((row) => JSON.stringify(row)).join('\n'))).toHaveLength(4);
    expect(() => retainedNdjson(rows.slice(1, 3).map((row) => JSON.stringify(row)).join('\n'))).toThrow();
  });
  it('requires exactly the admitted MCP tool and the structured scan exit', () => {
    const messages = [{ result: { protocolVersion: '2025-06-18' } }, { result: { tools: [{ name: 'n8n_scan' }] } }, { result: { isError: false, structuredContent: { exitCode: 1 } } }];
    expect(retainedMcpSession(messages, 1)).toBe(true); expect(retainedMcpSession(messages)).toBe(false);
    messages[1].result.tools.push({ name: 'extra_tool' }); expect(retainedMcpSession(messages, 1)).toBe(false);
  });
});
