#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { assertRetainedManifest, assertRetainedNotices, assertRetainedSeal, readRetainedOptions, retainedHash, sealRetainedTarball } from './lib/retained-tarball.mjs';
import { runRetainedCliControls } from './lib/retained-cli-controls.mjs';
import { createRetainedOfflineGuard, checkRetainedOfflineGuard } from './lib/retained-offline-guard.mjs';
import { validateRetainedDeclarations } from './lib/retained-declarations.mjs';

const EXPORTS = { '.': ['parseCliArguments', 'runCliV2', 'getHelpV2', 'emitMetadataCommandResultV2'], './v2/arguments': ['parseCliArguments'], './v2/cli-runner': ['runCliV2'], './v2/help': ['getHelpV2'], './v2/metadata-output': ['emitMetadataCommandResultV2'], './v2/preflight-readiness': ['buildPreflightReadinessReport'], './v2/privacy-prepare': ['prepareWorkflowPrivacy'] };

export function verifyRetainedCli(options) {
  if (!process.versions.node.startsWith('22.')) throw new Error('Retained CLI verification requires Node 22');
  const root = mkdtempSync(path.join(os.tmpdir(), 'sfscanner-retained-')); const commands = [];
  try {
    const seal = sealRetainedTarball(options, root); const consumer = path.join(root, 'consumer'); mkdirSync(consumer);
    writeFileSync(path.join(consumer, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
    const run = (command, args, settings = {}) => {
      const env = { ...process.env, ...settings.env, PATH: path.dirname(process.execPath) + path.delimiter + (settings.env?.PATH ?? process.env.PATH ?? '') };
      const output = spawnSync(command, args, { encoding: 'utf8', timeout: 120_000, maxBuffer: 16 * 1024 * 1024, ...settings, env });
      if (output.error) throw output.error;
      const result = { status: output.status, stdout: output.stdout ?? '', stderr: output.stderr ?? '' };
      const stable = (value) => value.replaceAll(root, '<consumer-root>');
      commands.push({ archiveSha256: seal.sha256, command: stable(command), args: args.map(stable), exit: result.status, stdoutBytes: Buffer.byteLength(result.stdout), stderrBytes: Buffer.byteLength(result.stderr), stdoutSha256: retainedHash(result.stdout), stderrSha256: retainedHash(result.stderr) });
      return result;
    };
    const npmCli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
    if (!existsSync(npmCli)) throw new Error('Node 22 npm CLI is unavailable beside the selected runtime');
    const npmVersion = run(process.execPath, [npmCli, '--version'], { cwd: consumer });
    if (npmVersion.status !== 0) throw new Error('Cannot identify retained verifier npm runtime');
    assertRetainedSeal(seal);
    const install = run(process.execPath, [npmCli, 'install', '--offline', '--ignore-scripts', '--no-save', '--no-package-lock', '--no-audit', '--no-fund', seal.sealedPath], { cwd: consumer });
    if (install.status !== 0) throw new Error('Retained offline install failed: ' + install.stderr);
    assertRetainedSeal(seal);
    const installed = path.join(consumer, 'node_modules', 'sfscanner'); const manifest = JSON.parse(readFileSync(path.join(installed, 'package.json'), 'utf8'));
    assertRetainedManifest(manifest, options.expectedVersion);
    for (const name of ['README.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'dist/main.js', 'dist/mcp.js', 'dist/scan-worker.js']) {
      if (!existsSync(path.join(installed, name))) throw new Error('Retained package missing ' + name);
    }
    for (const target of Object.values(manifest.bin)) {
      if (!readFileSync(path.join(installed, target), 'utf8').startsWith('#!/usr/bin/env node')) throw new Error('Retained binary missing Node shebang');
    }
    const license = readFileSync(path.join(installed, 'LICENSE')); const notices = readFileSync(path.join(installed, 'THIRD_PARTY_NOTICES.md'));
    if (manifest.license !== 'MIT') throw new Error('Retained package license mismatch');
    assertRetainedNotices(license, notices);
    writeFileSync(path.join(consumer, 'probe-exports.mjs'), 'const expected = ' + JSON.stringify(EXPORTS) + '; for (const [subpath, names] of Object.entries(expected)) { const module = await import("sfscanner" + (subpath === "." ? "" : subpath.slice(1))); for (const name of names) if (typeof module[name] !== "function") throw new Error("Missing export " + subpath + ":" + name); }');
    const guardedRun = createRetainedOfflineGuard(consumer, run);
    const guardControl = checkRetainedOfflineGuard(consumer, guardedRun);
    const probe = guardedRun(process.execPath, ['./probe-exports.mjs'], { cwd: consumer });
    const declarations = validateRetainedDeclarations(installed, consumer, guardedRun);
    const checks = [guardControl, declarations, { id: 'installed-contract-and-exports', status: probe.status === 0 ? 'pass' : 'fail' }, ...runRetainedCliControls({ run: guardedRun, consumer, installed })];
    assertRetainedSeal(seal);
    return { schemaVersion: 'retained-cli-verification-v1', status: checks.every((check) => check.status === 'pass') ? 'pass' : 'fail', runtime: { node: process.version, executable: process.execPath, npmExecutable: npmCli, npmVersion: npmVersion.stdout.trim(), platform: process.platform }, archive: { originalPath: seal.originalPath, sha256: seal.sha256, sri: seal.sri, bytes: seal.bytes, seals: { beforeInstall: true, afterInstall: true, afterControls: true } }, package: { name: manifest.name, version: manifest.version, licenseSha256: retainedHash(license), noticesSha256: retainedHash(notices) }, checks, commands };
  } finally {
    const resolved = path.resolve(root);
    if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('sfscanner-retained-')) throw new Error('Refusing cleanup outside owned retained-verifier root');
    rmSync(resolved, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { const report = verifyRetainedCli(readRetainedOptions(process.argv.slice(2))); process.stdout.write(JSON.stringify(report, null, 2) + '\n'); process.exitCode = report.status === 'pass' ? 0 : 1; }
  catch (error) { process.stderr.write(String(error) + '\n'); process.exitCode = 1; }
}
