import { beforeAll, describe, expect, it } from 'vitest';
import { renderReport, verifyPackedCli } from './verify-packed-cli.mjs';
import * as packedVerifier from './verify-packed-cli.mjs';

/**
 * The packed-tarball contract (plan task 5.3) is only meaningful when the checks really run
 * against an installed tarball, so this suite performs the pack-and-install once and then
 * asserts the report's integrity plus the mechanical publication invariants. CLI/MCP profile
 * agreement and the explicit licensing split are regression guards; the remaining advertised-vs-
 * actual mismatches (grammar, TTY default, Node/OS range) are recorded by the probe and must be
 * classified, not pinned, so a genuine fix does not turn the test red.
 */
const MECHANICAL_CHECKS = ['tarball-integrity', 'install-integrity', 'subpath-resolution', 'mcp-in-package', 'mcp-installed-entry', 'cli-mcp-profile-agreement', 'offline-isolation', 'atomic-write', 'exit-codes'];
const MATRIX_CHECKS = ['docs-grammar-consistency', 'tty-default-format', 'node-os-matrix', 'licensing-consistency'];
const STATUSES = ['pass', 'fail', 'skip'];

let report;

beforeAll(() => { report = verifyPackedCli(); }, 600_000);

describe('packed sfscanner tarball contract', () => {
  it('packs a real tarball and names its digest', () => {
    expect(report.tarball.sha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(report.tarball.bytes).toBeGreaterThan(0);
    expect(renderReport(report)).toContain(`tarball sha256: ${report.tarball.sha256}`);
    // `console.log` is swallowed by the default reporter for passing tests; plain stdout is not.
    process.stdout.write(`verify-packed-cli: ${report.tarball.name} sha256=${report.tarball.sha256} (${String(report.tarball.bytes)} bytes, ${String(report.summary.pass)} pass / ${String(report.summary.fail)} fail / ${String(report.summary.skip)} skip)\n`);
  });

  it('classifies every check as pass, fail, or skip and reconciles the summary', () => {
    expect(report.checks.length).toBeGreaterThanOrEqual(MECHANICAL_CHECKS.length + MATRIX_CHECKS.length);
    for (const check of report.checks) {
      expect(STATUSES, `${check.id}: ${check.detail}`).toContain(check.status);
      expect(check.detail.length, `${check.id} has no evidence`).toBeGreaterThan(0);
    }
    expect(report.summary.pass + report.summary.fail + report.summary.skip).toBe(report.checks.length);
  });

  it('passes every mechanical publication invariant from the clean install', () => {
    const byId = new Map(report.checks.map((check) => [check.id, check]));
    for (const id of MECHANICAL_CHECKS) {
      const check = byId.get(id);
      expect(check, `${id} was not reported`).toBeDefined();
      expect(check.status, `${id}: ${check.detail}`).toBe('pass');
    }
  });

  it('records the advertised-vs-actual matrix checks with evidence', () => {
    const byId = new Map(report.checks.map((check) => [check.id, check]));
    for (const id of MATRIX_CHECKS) {
      const check = byId.get(id);
      expect(check, `${id} was not reported`).toBeDefined();
      expect(['pass', 'fail'], `${id}: ${check.detail}`).toContain(check.status);
    }
  });
  it('requires an inline dual-licence statement and reports its external policy link honestly', () => {
    const check = report.checks.find((item) => item.id === 'licensing-consistency');
    expect(check.status).toBe('pass');
    expect(check.detail).toContain("MIT for this package's code and scanner tooling. The catalogue dataset has separate Personal / Non-Commercial terms");
    expect(check.detail).toContain('https://github.com/jitwark/sfscanner/blob/main/docs/LICENSING.md');
    expect(check.detail).toContain('README-policy-link=external canonical policy URL');
    expect(check.detail).not.toContain('README-link-target-exists-in-package');
    expect(check.detail).not.toContain('owner/legal decision pending');
    expect(check.detail).toContain('README-commercial-restriction=none');
  });
  it('rejects the retired private-repository policy URL', () => {
    const assess = packedVerifier.assessPackagedLicensing;
    const readme = `# sfscanner

> CLI
> MCP
> **Licensing:** MIT for this package's code and scanner tooling. The catalogue dataset has separate Personal / Non-Commercial terms; see https://github.com/jitwark/n8n-Secureflow/blob/main/docs/LICENSING.md.`;
    const result = assess({ manifest: { license: 'MIT' }, license: 'MIT License', notices: 'MIT', readme });
    expect(result.status).toBe('fail');
    expect(result.policyLinkPresent).toBe(false);
  });
  it.each([
    'Open Source for Personal / Non-Commercial Use · Commercial Enterprise License Required',
    'sfscanner is open source for personal, educational, and individual non-commercial use. Any deployment within an enterprise, corporate infrastructure, or commercial product requires an Enterprise Commercial License from SecureFlow.',
    'Commercial deployments require an Enterprise Commercial License.',
    'individual non-commercial use',
  ])('rejects historical commercial restrictions: %s', (restriction) => {
    const assess = packedVerifier.assessPackagedLicensing;
    expect(assess).toBeTypeOf('function');
    if (typeof assess !== 'function') return;
    const readme = `# sfscanner

> CLI
> MCP
> **Licensing:** MIT for this package's code and scanner tooling. The catalogue dataset has separate Personal / Non-Commercial terms; see https://github.com/jitwark/sfscanner/blob/main/docs/LICENSING.md.
${restriction}`;
    const result = assess({ manifest: { license: 'MIT' }, license: 'MIT License', notices: 'MIT', readme });
    expect(result.status).toBe('fail');
    expect(result.hasCommercialRestriction).toBe(true);
  });
});
