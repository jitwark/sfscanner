import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { prepareActionFixture, writeActionReceipt } from './action-surface.test-helper';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const normalize = (text: string) => text.replace(/\r\n/gu, '\n');
const read = (...parts: string[]) => normalize(readFileSync(path.join(root, ...parts), 'utf8'));
const composite = read('.github/actions/scan/action.yml');
const exampleWorkflow = read('.github/workflows/example-scan.yml');
const surfaces: Array<[string, string]> = [['Action', composite], ['example', exampleWorkflow], ['CI', read('.github/workflows/ci.yml')]];
const scannerPackage = JSON.parse(read('packages/scanner-cli/package.json')) as { bin: Record<string, string> };

function permissionGrants(text: string): Array<[string, string]> {
  const grants: Array<[string, string]> = [];
  const lines = text.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const block = /^(\s*)permissions:\s*$/u.exec(lines[index]);
    if (!block) {
      const inline = /^\s*permissions:\s*(\S+)\s*$/u.exec(lines[index]);
      if (inline) grants.push(['<inline>', inline[1]]);
      continue;
    }
    for (let inner = index + 1; inner < lines.length; inner += 1) {
      const entry = /^(\s+)([a-z-]+):\s*(\S+)\s*$/u.exec(lines[inner]);
      if (!entry || entry[1].length <= block[1].length) break;
      grants.push([entry[2], entry[3]]);
    }
  }
  return grants;
}

function runBodies(text: string): string[] {
  const lines = normalize(text).split('\n');
  const bodies: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const scalar = /^(\s*)(?:-\s*)?run:\s*(.*)$/u.exec(lines[index]);
    if (!scalar) continue;
    if (scalar[2] !== '|') { bodies.push(scalar[2]); continue; }
    const block: string[] = [];
    while (index + 1 < lines.length && (lines[index + 1].trim() === '' || lines[index + 1].search(/\S/u) > scalar[1].length)) {
      block.push(lines[++index]);
    }
    bodies.push(block.join('\n'));
  }
  return bodies;
}

function stepText(name: string): string {
  const lines = composite.split('\n');
  const start = lines.findIndex((line) => line.trim() === `- name: ${name}`);
  expect(start, `Action must define ${name}`).toBeGreaterThanOrEqual(0);
  const indent = lines[start].search(/\S/u);
  let end = start + 1;
  while (end < lines.length && !(lines[end].startsWith(' '.repeat(indent) + '- name:'))) end += 1;
  return lines.slice(start, end).join('\n');
}
function stepRun(step: string): string {
  const lines = step.split('\n');
  const index = lines.findIndex((line) => /^\s*run:\s*\|$/u.test(line));
  expect(index).toBeGreaterThanOrEqual(0);
  const indent = lines[index].search(/\S/u) + 2;
  return lines.slice(index + 1).map((line) => line.slice(indent)).join('\n');
}
const scanRun = stepRun(stepText('Run v2 scanner'));
const bash = ['C:/Program Files/Git/bin/bash.exe', '/bin/bash', 'bash'].find((candidate) => {
  const result = spawnSync(candidate, ['-c', 'command -v node >/dev/null'], { encoding: 'utf8' });
  return result.status === 0;
});
const scratch: string[] = [];
afterEach(() => { while (scratch.length) rmSync(scratch.pop()!, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });
function temp(prefix: string, parent = os.tmpdir()) {
  const dir = realpathSync(mkdtempSync(path.join(parent, prefix)));
  scratch.push(dir);
  return dir;
}
const demoWorkflow = JSON.stringify({ nodes: [{ name: 'Start', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: [0, 0], parameters: {} }], connections: {} });
function fixture(workflows: Record<string, string> = { 'workflows/demo.json': demoWorkflow }, tempRoot = os.tmpdir()) {
  const workspace = temp('sf-action-', tempRoot); const authority = temp('sf-action-authority-', tempRoot);
  prepareActionFixture(root, workspace, authority, workflows);
  return { workspace, authority };
}
function execute(value: ReturnType<typeof fixture>, overrides: Record<string, string> = {}) {
  expect(bash, 'A real bash with Node is required to execute the shipped Action run block').toBeDefined();
  const nodeDirectory = path.dirname(process.execPath).replaceAll('\\', '/').replace(/^([A-Za-z]):/u, (_, drive: string) => `/${drive.toLowerCase()}`);
  const script = path.join(value.authority, 'scan.sh');
  writeFileSync(script, `export PATH='${nodeDirectory.replaceAll("'", "'\\''")}':"$PATH"\n${scanRun}`);
  return spawnSync(bash!, [script], { cwd: value.workspace, encoding: 'utf8', env: { ...process.env,
    ACTION_RUNNER: path.join(value.authority, 'run-scan.mjs'), GITHUB_WORKSPACE: value.workspace,
    GITHUB_OUTPUT: path.join(value.workspace, 'github-output.txt'), SCAN_PATH: '.', FAIL_ON: 'high', SARIF_FILE: 'n8n-scan.sarif', ...overrides } });
}

describe('the prepared scanner Action surface', () => {
  it('pins every action to a full commit SHA, never a branch or a tag', () => {
    for (const [name, text] of surfaces) {
      const refs = [...text.matchAll(/^\s*uses:\s*(\S+)/gmu)].map((match) => match[1]);
      expect(refs.length, name).toBeGreaterThan(0);
      for (const ref of refs) expect(ref).toMatch(/^[^@]+@[0-9a-f]{40}$/u);
      expect(text).not.toMatch(/uses:\s*\S+@(?:main|master|head|latest)\b/iu);
    }
  });
  it('keeps the unpublished Action reference fail-closed without caller source authority', () => {
    const reference = exampleWorkflow.match(/uses:\s*(jitwark\/sfscanner\/[^\s@]+)@([0-9a-f]{40})\b/u);
    expect(reference?.[1]).toBe('jitwark/sfscanner/.github/actions/scan');
    expect(reference?.[2]).toMatch(/^[0-9a-f]{40}$/u);
    expect(exampleWorkflow).toContain('exact published Action-distribution commit');
    expect(exampleWorkflow).not.toMatch(/^\s+scanner-(?:ref|repository):/mu);
    expect(composite).not.toContain('inputs.scanner-ref');
    expect(composite).not.toContain('inputs.scanner-repository');
  });
  it('grants no permission beyond isolated scan/read and separate SARIF upload', () => {
    for (const [name, text] of surfaces) {
      expect(text).not.toMatch(/permissions:\s*(?:write|read)-all/u);
      const grants = permissionGrants(text);
      for (const [key, value] of grants) {
        expect(['contents', 'security-events'], name).toContain(key);
        expect(['read', 'write'], name).toContain(value);
        if (key === 'contents') expect(value).toBe('read');
      }
      if (!text.includes('upload-sarif')) expect(grants.some(([, value]) => value === 'write')).toBe(false);
    }
    expect(composite).not.toMatch(/^\s*permissions:/mu);
    expect(composite).not.toContain('secrets.');
    expect(exampleWorkflow).toMatch(/permissions:\s*\n\s+contents: read/u);
    expect(exampleWorkflow).toContain('security-events: write');
    expect(exampleWorkflow).toContain('github.event.pull_request.head.repo.fork == false');
  });
  it('never interpolates an expression into shell text and parses CRLF identically', () => {
    for (const [name, text] of surfaces) {
      const bodies = runBodies(text);
      if (name === 'example') expect(bodies).toHaveLength(0);
      else expect(bodies.length, name).toBeGreaterThan(0);
      expect(runBodies(text.replace(/\n/gu, '\r\n'))).toEqual(bodies);
      for (const body of bodies) expect(body).not.toContain('${{');
    }
    for (const name of ['SCAN_PATH', 'FAIL_ON', 'SARIF_FILE']) expect(composite).toMatch(new RegExp(`${name}: \\$\\{\\{ inputs\\.`, 'u'));
    expect(scanRun).toContain('node "$ACTION_RUNNER"');
  });
  it('invokes the receipt-driven runner with documented v2 grammar and checkout exclusions', () => {
    expect(scannerPackage.bin.sfscanner.replace(/^\.\//u, '')).toBe('dist/main.js');
    expect(scanRun.trim()).toBe('set -euo pipefail\nnode "$ACTION_RUNNER"');
    const runner = read('scripts/scanner-action/run-scan.mjs');
    expect(runner).toContain("'--schema', 'v2', 'scan'");
    expect(runner).toContain('--format=sarif'); expect(runner).toContain('--fail-on=${severity}');
    expect(runner).toContain('--output=${sarifPath}');
    for (const glob of ['.git/**', 'node_modules/**', '.scanner-source/**']) expect(runner).toContain(`--exclude=${glob}`);
    expect(runner).toContain('sarif-file=${result.sarifPath}'); expect(runner).toContain('exit-code=${result.exitCode}');
    expect(composite).toContain('node-version: 22.x');
  });
});

describe('the prepared scanner Action isolation', () => {
  it('canonicalizes fixture temp roots before invoking the shipped runner', () => {
    const base = temp('sf-action-alias-'); const target = path.join(base, 'target'); const alias = path.join(base, 'alias');
    mkdirSync(target); symlinkSync(target, alias, 'junction');
    const value = fixture(undefined, alias);
    expect(value.workspace).toBe(realpathSync(value.workspace));
    expect(value.authority).toBe(realpathSync(value.authority));
    expect(realpathSync(path.join(value.authority, 'run-scan.mjs'))).toBe(path.join(value.authority, 'run-scan.mjs'));
  });
  it('checks out receipt-bound source and builds only that checkout', () => {
    const checkout = stepText('Check out receipt-bound scanner source');
    expect(checkout).toContain('repository: ${{ steps.preflight.outputs.scanner-repository }}');
    expect(checkout).toContain('ref: ${{ steps.preflight.outputs.scanner-ref }}');
    expect(checkout).toContain('path: .scanner-source'); expect(checkout).toContain('persist-credentials: false');
    for (const name of ['Install locked scanner dependencies', 'Build scanner CLI']) expect(stepText(name)).toContain('working-directory: .scanner-source');
    expect(composite).not.toMatch(/working-directory:\s*\$\{\{\s*github\.workspace\s*\}\}\s*\n\s*run:\s*npm/u);
  });
  it('validates bundled authority before checkout, install, artifact verification and scan', () => {
    const order = ['Set up Node.js 22 for trust preflight', 'Verify Action-owned release receipt before scanner checkout', 'Check out receipt-bound scanner source',
      'Verify checked scanner source', 'Install locked scanner dependencies', 'Build scanner CLI', 'Verify built scanner artifacts', 'Run v2 scanner'];
    let previous = -1;
    for (const name of order) { const position = composite.indexOf(`- name: ${name}`); expect(position, name).toBeGreaterThan(previous); previous = position; }
    expect(composite).not.toMatch(/npm\s+publish|firebase\s+deploy|gh\s+release/u);
  });
  it('fails closed on any receipt ref that is not a full 40-hex commit', () => {
    const value = fixture();
    for (const bad of ['', 'abc', 'a'.repeat(39), 'a'.repeat(41), 'A'.repeat(40), 'main', 'refs/heads/main', '0123456789abcdef']) {
      writeActionReceipt(root, value.workspace, value.authority, bad);
      const result = execute(value); expect(result.status, bad).toBe(1);
      expect(result.stderr).toContain('SCANNER_REF_INVALID');
    }
    writeActionReceipt(root, value.workspace, value.authority);
    expect(execute(value, { SCANNER_REF: 'main', SCANNER_REPOSITORY: 'attacker/repo' }).status).toBe(0);
  });
  it('rejects unsafe paths and gate values before the scanner runs', () => {
    const value = fixture();
    for (const unsafe of ['', '/etc', 'C:/workflows', 'C:\\workflows', '\\\\server\\share', '../outside', 'a/../b', 'work\u0001flow']) expect(execute(value, { SCAN_PATH: unsafe }).status).toBe(2);
    for (const unsafe of ['', '/tmp/out.sarif', 'C:/out.sarif', '../out.sarif']) expect(execute(value, { SARIF_FILE: unsafe }).status).toBe(2);
    for (const unsafe of ['', 'severe', 'critical,high']) expect(execute(value, { FAIL_ON: unsafe }).status).toBe(2);
    expect(execute(value).status).toBe(0);
  });
  it('scans the caller workspace without consuming the injected scanner checkout', () => {
    const value = fixture(); const result = execute(value); expect(result.status, result.stderr + result.stdout).toBe(0);
    const sarif = JSON.parse(readFileSync(path.join(value.workspace, 'n8n-scan.sarif'), 'utf8'));
    expect(sarif.version).toBe('2.1.0');
    expect(JSON.stringify(sarif)).not.toMatch(/MALFORMED_WORKFLOW|TOOL_INVARIANT_FAILED/);
    expect(readFileSync(path.join(value.workspace, 'github-output.txt'), 'utf8')).toBe('sarif-file=n8n-scan.sarif\nexit-code=0\n');
  });
  it('propagates scanner item failure and still records both outputs', () => {
    const value = fixture({ 'workflows/broken.json': '{"nodes": [' });
    expect(execute(value).status).toBe(3);
    expect(readFileSync(path.join(value.workspace, 'github-output.txt'), 'utf8')).toBe('sarif-file=n8n-scan.sarif\nexit-code=3\n');
  });
});
