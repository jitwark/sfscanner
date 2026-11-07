import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_SCANNER_LIMITS, SCANNER_RESULT_SCHEMA_VERSION, toWorkflowParseOptions } from '@hub/contracts';
import { SCANNER_VERSION } from '../packages/scanner-core/src/scanner-version.ts';
import { scannerParityFixtures } from '../app/src/scanner/__fixtures__/scanner-parity.js';
import { scanWorkflow } from '../app/src/scanner/engine.js';
import { parseWorkflowJson } from '@hub/scanner-core/workflow';
import { runCli } from '../pipeline/cli/cli-runner.js';
import { scanCandidate } from '../pipeline/scan/scan-entry.js';
import {
  PARITY_PROFILES,
  canonicalWire,
  projectBrowserEntrySecurity,
  validatePipelineParity,
  validatePipelineRejection,
  validateRejectedParity,
  validateSecretGuard,
  validateValidParity,
} from './check-scanner-parity.mjs';
export { projectBrowserEntrySecurity };

export const RELEASE_GOLDEN_IDENTITY = Object.freeze({
  gate: 'scanner-release-goldens', version: 'v1', scannerVersion: SCANNER_VERSION,
  canonicalization: 'hub-canonical-json-v1', hash: 'sha256',
});
const PARSE_OPTIONS = toWorkflowParseOptions(DEFAULT_SCANNER_LIMITS);
const entry = (fixtureId, kind, profile, sha256) => Object.freeze({ fixtureId, kind, profile, sha256 });
export const GOLDEN_ENTRIES = Object.freeze([
  entry('safe', 'browser', 'beta-default', 'c4544e7c0b8ce4c980eeedefae48fac2a4e61ae669ae21e495daa58243360472'),
  entry('safe', 'browser', 'beta-hardened', '8a168592ea2f526eda7256bafe2382498bc8914b9a54886f79de2576bf70b6b3'),
  entry('safe', 'pipeline', 'beta-default', '638b49604cf0646ab798bd9d8dbd35bd17fbd36c7b694c2421a5eb3d8e930eb8'),
  entry('risky', 'browser', 'beta-default', 'b49d83f364f2387056b5906e0a11b5c7974f146f6e8d6ec360944b663effce29'),
  entry('risky', 'browser', 'beta-hardened', '2eb046daf3ec404f8f3e20a7cd110d530d8ef193685e874ab9a64c67b9af7c31'),
  entry('risky', 'pipeline', 'beta-default', 'dd3aeff8e0916da8c8a597aa6e59ba0fd4cd1620bfc98fe16a65d43faf1173b3'),
  entry('analyzer-cap', 'browser', 'beta-default', 'c3fe0d63b4a1c4904db9aaaa69427e6cccb61e730b65ffd3d50b2e76998b7daa'),
  entry('analyzer-cap', 'browser', 'beta-hardened', 'c62ec0838d553f1514d0979d84748691bdc15ed474fd02d6db9c20b2b39fe49f'),
  entry('analyzer-cap', 'pipeline', 'beta-default', 'f7262baf8a4c4ec3f463843b8b3bd7609e3138fbc0beb7cd7f3ae1d873e7c324'),
]);

export function canonicalSha256(value) {
  return createHash('sha256').update(canonicalWire(value), 'utf8').digest('hex');
}

export function validateGoldenMap(fixtures, goldens) {
  const errors = [];
  if (!Array.isArray(fixtures) || fixtures.length === 0) return ['fixture matrix is empty'];
  const fixtureIds = new Set();
  const validIds = new Set();
  for (const fixture of fixtures) {
    if (!isRecord(fixture) || typeof fixture.id !== 'string' || typeof fixture.json !== 'string' || !['valid', 'rejected'].includes(fixture.kind)) { errors.push('fixture matrix contains a malformed fixture'); continue; }
    if (fixtureIds.has(fixture.id)) errors.push(`fixture matrix contains duplicate id: ${fixture.id}`);
    fixtureIds.add(fixture.id);
    if (fixture.kind === 'valid') validIds.add(fixture.id);
    if (fixture.kind === 'rejected' && typeof fixture.rejectionCode !== 'string') errors.push(`${fixture.id} is rejected but has no declared input code`);
  }
  if (validIds.size === 0) errors.push('fixture matrix has no valid fixtures');
  if (!Array.isArray(goldens)) return [...errors, 'golden map is not an array'];
  const seen = new Set();
  for (const golden of goldens) {
    if (!isRecord(golden) || typeof golden.fixtureId !== 'string' || !['browser', 'pipeline'].includes(golden.kind)
      || typeof golden.profile !== 'string' || !/^[0-9a-f]{64}$/.test(golden.sha256)) { errors.push('golden map contains a malformed entry'); continue; }
    const key = goldenKey(golden);
    if (seen.has(key)) errors.push(`duplicate golden: ${key}`);
    seen.add(key);
    if (!validIds.has(golden.fixtureId)) errors.push(`golden references unsupported fixture: ${golden.fixtureId}`);
    if (golden.kind === 'browser' && !PARITY_PROFILES.includes(golden.profile)) errors.push(`golden uses unsupported profile: ${golden.profile}`);
    if (golden.kind === 'pipeline' && golden.profile !== 'beta-default') errors.push(`pipeline golden uses unsupported profile: ${golden.profile}`);
  }
  const expected = validIds.size * 3;
  if (goldens.length !== expected) errors.push(`golden map must contain exactly ${expected} entries`);
  for (const fixtureId of validIds) for (const profile of PARITY_PROFILES) {
    if (!seen.has(`${fixtureId}:browser:${profile}`)) errors.push(`missing golden: ${fixtureId}:browser:${profile}`);
  }
  for (const fixtureId of validIds) if (!seen.has(`${fixtureId}:pipeline:beta-default`)) errors.push(`missing golden: ${fixtureId}:pipeline:beta-default`);
  return errors;
}

export async function runGoldenGate({
  fixtures = scannerParityFixtures, goldens = GOLDEN_ENTRIES,
  scanBrowser = scanBrowserFixture, scanCli = runIsolatedCli, scanPipeline = scanPipelineFixture,
  parse = parseWorkflowJson,
} = {}) {
  const errors = validateGoldenMap(fixtures, goldens);
  const report = { ok: false, identity: RELEASE_GOLDEN_IDENTITY, validFixtures: 0, goldenChecks: 0, rejectedChecks: 0, observations: [], errors };
  if (errors.length > 0) return report;
  const goldenByKey = new Map(goldens.map((golden) => [goldenKey(golden), golden]));
  for (const fixture of fixtures) {
    if (fixture.kind === 'rejected') {
      for (const profile of PARITY_PROFILES) {
        report.rejectedChecks += 1;
        try {
          const parsed = parse(fixture.json, PARSE_OPTIONS);
          if (parsed?.ok === true) errors.push(`${fixture.id} parser accepted a declared rejected fixture`);
          else if (parsed?.code !== fixture.rejectionCode) errors.push(`${fixture.id} parser returned ${String(parsed?.code)} instead of ${fixture.rejectionCode}`);
        } catch (error) { errors.push(`${fixture.id} parser check failed: ${errorMessage(error)}`); }
        try { errors.push(...validateRejectedParity({ fixture, profile, cliRun: await scanCli(fixture, profile) }).errors); }
        catch (error) { errors.push(`${fixture.id} [${profile}] CLI rejection check failed: ${errorMessage(error)}`); }
      }
      try { errors.push(...validatePipelineRejection({ fixture, pipelineResult: await scanPipeline(fixture) }).errors); }
      catch (error) { errors.push(`${fixture.id} pipeline scan failed: ${errorMessage(error)}`); }
      continue;
    }
    report.validFixtures += 1; report.goldenChecks += 3;
    const browserResults = {};
    const observation = { fixtureId: fixture.id, browser: {}, pipeline: undefined };
    for (const profile of PARITY_PROFILES) {
      let browserResult; let cliRun;
      try { browserResult = await scanBrowser(fixture, profile); browserResults[profile] = browserResult; }
      catch (error) { errors.push(`${fixture.id} [${profile}] browser scan failed: ${errorMessage(error)}`); continue; }
      try { cliRun = await scanCli(fixture, profile); }
      catch (error) { errors.push(`${fixture.id} [${profile}] CLI scan failed: ${errorMessage(error)}`); }
      if (cliRun) errors.push(...validateValidParity({ fixture, profile, browserResult, cliRun }).errors);
      errors.push(...validateSecretGuard(fixture, browserResult, 'browser').errors);
      if (browserResult?.policyProfile !== profile) errors.push(`${fixture.id} [${profile}] browser used wrong profile`);
      if (browserResult?.scannerVersion !== RELEASE_GOLDEN_IDENTITY.scannerVersion) errors.push(`${fixture.id} [${profile}] browser used wrong scanner version`);
      const hash = canonicalSha256(browserResult); observation.browser[profile] = hash;
      if (hash !== goldenByKey.get(`${fixture.id}:browser:${profile}`).sha256) errors.push(`${fixture.id} browser ${profile} golden hash drift`);
    }
    try {
      const pipelineResult = await scanPipeline(fixture); observation.pipeline = canonicalSha256(pipelineResult);
      errors.push(...validatePipelineParity({ fixture, browserResults, pipelineResult }).errors);
      if (pipelineResult?.scannerVersion !== RELEASE_GOLDEN_IDENTITY.scannerVersion) errors.push(`${fixture.id} pipeline used wrong scanner version`);
      if (observation.pipeline !== goldenByKey.get(`${fixture.id}:pipeline:beta-default`).sha256) errors.push(`${fixture.id} pipeline beta-default golden hash drift`);
    } catch (error) { errors.push(`${fixture.id} pipeline scan failed: ${errorMessage(error)}`); }
    report.observations.push(observation);
  }
  report.errors = errors; report.ok = errors.length === 0; return report;
}

function scanBrowserFixture(fixture, profile) {
  const parsed = parseWorkflowJson(fixture.json, PARSE_OPTIONS);
  if (!parsed.ok) throw new Error(`input rejected as ${parsed.code}`);
  return scanWorkflow(parsed.workflow, { policyProfile: profile });
}
async function scanPipelineFixture(fixture) {
  return scanCandidate({ id: fixture.id, json: fixture.json }, { scannerVersion: RELEASE_GOLDEN_IDENTITY.scannerVersion, scan: (workflow, options) => scanWorkflow(workflow, options) });
}
async function runIsolatedCli(fixture, profile) {
  return runCli(['scan', '-', '--format', 'json', '--profile', profile, '--timeout', '30000'], { stdin: new TextEncoder().encode(fixture.json), signal: new AbortController().signal });
}
function goldenKey(golden) { return `${golden.fixtureId}:${golden.kind}:${golden.profile}`; }
function isRecord(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function errorMessage(error) { return error instanceof Error ? error.message : String(error); }

export async function main(io = { stdout: process.stdout, stderr: process.stderr }) {
  try {
    const report = await runGoldenGate();
    io.stdout.write(`${JSON.stringify(report)}\n`);
    return report.ok ? 0 : 1;
  } catch (error) { io.stderr.write(`Scanner release golden gate failed: ${errorMessage(error)}\n`); return 1; }
}
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) process.exitCode = await main();
