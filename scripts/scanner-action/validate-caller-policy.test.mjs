import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import yaml from 'js-yaml';
import { DEFAULT_ACTION_PATH, validateCallerPolicy } from './validate-caller-policy.mjs';

const here = import.meta.dirname;
const scriptPath = path.join(here, 'validate-caller-policy.mjs');
const templatePath = path.join(here, 'caller-workflow-template.yml');
const fixtures = JSON.parse(fs.readFileSync(path.join(here, 'caller-policy-fixtures.json'), 'utf8'));
const templateYaml = fs.readFileSync(templatePath, 'utf8');
const options = { approvedActionSha: fixtures.approvedActionSha, actionPath: fixtures.actionPath };
const validate = (workflow, overrides = {}) => validateCallerPolicy(workflow, { ...options, ...overrides });
const reasonsOf = (result) => result.reasons.join('\n');

function workflowWithoutScanAction() {
  return [
    'on:',
    '  pull_request:',
    'jobs:',
    '  scan:',
    '    runs-on: ubuntu-24.04',
    '    permissions:',
    '      contents: read',
    '    steps:',
    '      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1',
    '        with:',
    '          persist-credentials: false',
  ].join('\n');
}

function workflowWithoutCheckout() {
  return [
    'on:',
    '  pull_request:',
    'jobs:',
    '  scan:',
    '    runs-on: ubuntu-24.04',
    '    permissions:',
    '      contents: read',
    '    steps:',
    `      - uses: ${fixtures.actionPath}@${fixtures.approvedActionSha}`,
  ].join('\n');
}

function workflowWithSarifBeforeScanner() {
  return [
    'on:',
    '  pull_request:',
    'jobs:',
    '  upload:',
    '    runs-on: ubuntu-24.04',
    '    permissions:',
    '      security-events: write',
    '    steps:',
    '      - uses: github/codeql-action/upload-sarif@cdf488f595d80d6e07e03d4674febd5ab45fa938',
    '        with:',
    '          sarif_file: n8n-scan.sarif',
    '  scan:',
    '    runs-on: ubuntu-24.04',
    '    permissions:',
    '      contents: read',
    '    steps:',
    '      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1',
    '        with:',
    '          persist-credentials: false',
    `      - uses: ${fixtures.actionPath}@${fixtures.approvedActionSha}`,
  ].join('\n');
}

describe('caller workflow template', () => {
  it('passes with the controller-frozen Action commit', () => {
    const result = validate(templateYaml);
    expect(result.status).toBe('PASS');
    expect(result.reasons).toHaveLength(1);
  });

  it('is checked against the default configured Action path', () => {
    expect(fixtures.actionPath).toBe(DEFAULT_ACTION_PATH);
    expect(DEFAULT_ACTION_PATH).toBe('jitwark/sfscanner/.github/actions/scan');
    expect(validateCallerPolicy(templateYaml, { approvedActionSha: fixtures.approvedActionSha }).status).toBe('PASS');
  });

  it('returns UNKNOWN without an approved Action commit', () => {
    const result = validateCallerPolicy(templateYaml);
    expect(result.status).toBe('UNKNOWN');
    expect(reasonsOf(result)).toContain('approved Action commit');
  });

  it('refuses a malformed approved Action commit', () => {
    const result = validate(templateYaml, { approvedActionSha: 'v2' });
    expect(result.status).toBe('UNKNOWN');
    expect(reasonsOf(result)).toContain('approved Action commit');
  });
});

describe('caller policy fixtures', () => {
  for (const vector of fixtures.vectors) {
    it(`${vector.name} -> ${vector.expectedStatus}`, () => {
      const result = validate(vector.workflow);
      expect(result.status).toBe(vector.expectedStatus);
      for (const fragment of vector.expectedReasonFragments) {
        expect(reasonsOf(result)).toContain(fragment);
      }
    });
  }
});

describe('validator input handling', () => {
  it('accepts a parsed workflow mapping equivalently to YAML text', () => {
    expect(validate(yaml.load(templateYaml))).toEqual(validate(templateYaml));
  });

  it('returns UNKNOWN for malformed YAML', () => {
    const result = validate('on: [pull_request');
    expect(result.status).toBe('UNKNOWN');
    expect(reasonsOf(result)).toContain('did not parse');
  });

  it('returns UNKNOWN when no job invokes the approved Action', () => {
    const result = validate(workflowWithoutScanAction());
    expect(result.status).toBe('UNKNOWN');
    expect(reasonsOf(result)).toContain('no job invokes');
  });

  it('returns UNKNOWN when the scanner job has no checkout step', () => {
    const result = validate(workflowWithoutCheckout());
    expect(result.status).toBe('UNKNOWN');
    expect(reasonsOf(result)).toContain('no actions/checkout step');
  });

  it('fails a SARIF upload job that precedes the scanner job', () => {
    const result = validate(workflowWithSarifBeforeScanner());
    expect(result.status).toBe('FAIL');
    expect(reasonsOf(result)).toContain('must come after the scanner job');
  });

  it('returns UNKNOWN when permissions inherit an unresolved expression', () => {
    const workflow = templateYaml.replace(
      /    permissions:\r?\n      contents: read/u,
      '    permissions: ${{ github.event.permissions }}',
    );
    const result = validate(workflow);
    expect(result.status).toBe('UNKNOWN');
    expect(reasonsOf(result)).toContain('unresolved expression');
  });

  it('rejects bracket-syntax secrets and tokens in scanner job or env', () => {
    const bracketSecret = templateYaml.replace('runs-on: ubuntu-24.04', 'runs-on: ubuntu-24.04\n    env:\n      KEY: ${{ secrets[\'SECRET_KEY\'] }}');
    const resSecret = validate(bracketSecret);
    expect(resSecret.status).toBe('FAIL');
    expect(reasonsOf(resSecret)).toContain('secrets context');

    const bracketToken = templateYaml.replace('runs-on: ubuntu-24.04', 'runs-on: ubuntu-24.04\n    env:\n      TOK: ${{ github[\'token\'] }}');
    const resToken = validate(bracketToken);
    expect(resToken.status).toBe('FAIL');
    expect(reasonsOf(resToken)).toContain('github.token');
  });

  it('accepts the configured distribution action path by default', () => {
    const secureflowWorkflow = templateYaml;
    const res = validate(secureflowWorkflow, { actionPath: undefined });
    expect(res.status).toBe('PASS');
  });

  it('returns UNKNOWN instead of PASS when scanner job exceeds maximum walk depth', () => {
    const templateObj = yaml.load(templateYaml);
    const scanJob = Object.values(templateObj.jobs).find((job) => Array.isArray(job.steps)
      && job.steps.some((step) => typeof step.uses === 'string' && step.uses.toLowerCase().includes('.github/actions/scan')));
    let nested = '${{ secrets.DEPLOY_KEY }}';
    for (let index = 0; index < 40; index += 1) nested = { nested };
    scanJob.steps.push({ name: 'deeply nested secret reference', env: { wrapper: nested }, run: 'true' });
    const result = validate(templateObj);
    expect(result.status).not.toBe('PASS');
    expect(result.status).toBe('UNKNOWN');
    expect(reasonsOf(result)).toContain('exceeds maximum inspection depth');
  });
});
describe('CLI', () => {
  it('prints a JSON verdict and exits 0 for the template', () => {
    const result = spawnSync(process.execPath, [scriptPath, '--workflow', templatePath, '--action-sha', fixtures.approvedActionSha], {
      encoding: 'utf8',
    });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ status: 'PASS', reasons: [expect.any(String)] });
  });

  it('exits 1 for a failing workflow', () => {
    const failing = fixtures.vectors.find((vector) => vector.expectedStatus === 'FAIL');
    const tempPath = path.join(os.tmpdir(), `caller-policy-${process.pid}.yml`);
    fs.writeFileSync(tempPath, failing.workflow);
    try {
      const result = spawnSync(process.execPath, [scriptPath, '--workflow', tempPath, '--action-sha', fixtures.approvedActionSha], {
        encoding: 'utf8',
      });
      expect(result.status).toBe(1);
      expect(JSON.parse(result.stdout).status).toBe('FAIL');
    } finally {
      fs.rmSync(tempPath, { force: true });
    }
  });

  it('exits 2 without required arguments', () => {
    const result = spawnSync(process.execPath, [scriptPath], { encoding: 'utf8' });
    expect(result.status).toBe(2);
  });
});
