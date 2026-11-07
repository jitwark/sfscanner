import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCHEMA = 'phase9-release-candidate-v1';
const PACKETS = Object.freeze(['WC-0901', 'WC-0902', 'WC-0903', 'WC-0904', 'WC-0905']);
const EXTERNAL = Object.freeze(['CI_REQUIRED', 'OWNER_REQUIRED', 'LEGAL_REQUIRED', 'DEPLOYMENT_REQUIRED', 'HUMAN_REQUIRED', 'WC_0702_0704']);
const DIGEST_FIELDS = Object.freeze(['engine', 'profile', 'ruleset', 'semantics', 'limits', 'v1Goldens', 'v2Parity']);
const HEX = /^[0-9a-f]{64}$/i;
const COMMIT = /^[0-9a-f]{7,64}$/i;
const SECRET = /(?:sk_(?:live|test)_|ghp_|github_pat_|xox[baprs]-|bearer\s)/i;
const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const passed = (value) => isRecord(value) && String(value.status).toLowerCase() === 'passed';
const claimed = (value) => passed(value) || (typeof value === 'string' && value.toLowerCase() === 'passed');
const digest = (value) => typeof value === 'string' && HEX.test(value);
const error = (code, subject) => ({ code, subject });
const safeLabel = (value, fallback) => typeof value === 'string' && /^[A-Za-z0-9:_./ -]{1,80}$/.test(value) && !SECRET.test(value) ? value : fallback;
const fixedExternalGates = () => Object.fromEntries(EXTERNAL.map((id) => [id, { status: id === 'WC_0702_0704' ? 'DEFERRED' : 'UNCLAIMED' }]));

function buildPacketStatuses(run, evidence, errors) {
  const statuses = {};
  const runPackets = isRecord(run?.packets) ? run.packets : {};
  const evidencePackets = isRecord(evidence?.packets) ? evidence.packets : {};
  for (const id of PACKETS) {
    const packet = evidencePackets[id];
    if (!isRecord(packet) || packet.present !== true) errors.push(error('MISSING_PACKET_EVIDENCE', id));
    const status = runPackets[id];
    if (!passed(status)) errors.push(error('PACKET_NOT_PASSED', id));
    statuses[id] = { status: passed(status) ? 'passed' : 'blocked', evidence: packet?.present === true ? 'present' : 'missing' };
  }
  return statuses;
}

function commandStatuses(run, errors) {
  const commands = isRecord(run?.commands) ? run.commands : null;
  if (!commands || Object.keys(commands).length === 0) { errors.push(error('LOCAL_COMMANDS_MISSING', 'local-commands')); return {}; }
  const statuses = {};
  for (const id of Object.keys(commands).sort()) {
    const item = commands[id];
    const ok = passed(item) && (item.exitCode === undefined || item.exitCode === 0);
    if (!ok) errors.push(error('LOCAL_COMMAND_FAILED', safeLabel(id, 'local-command')));
    statuses[safeLabel(id, 'local-command')] = ok ? 'passed' : 'blocked';
  }
  return statuses;
}

function checkFiles(run, errors) {
  const files = run?.changedFiles ?? run?.files;
  if (!Array.isArray(files)) { errors.push(error('CHANGED_FILES_MISSING', 'changed-files')); return; }
  for (const file of files) {
    const lines = file?.lines ?? file?.lineCount;
    if (!isRecord(file) || typeof file.path !== 'string' || !Number.isInteger(lines) || lines < 0) errors.push(error('MALFORMED_RUN', 'changed-files'));
    else if (lines > 200) errors.push(error('FILE_SIZE_EXCEEDED', 'changed-files'));
  }
}

function checkDigests(run, evidence, errors) {
  const v1 = evidence?.v1;
  if (!digest(v1?.expectedDigest) || !digest(v1?.actualDigest)) errors.push(error('MISSING_DIGEST_IDENTITY', 'v1'));
  else if (v1.expectedDigest.toLowerCase() !== v1.actualDigest.toLowerCase()) errors.push(error('V1_DIGEST_MISMATCH', 'v1'));
  const parity = run?.v2Parity;
  const v2 = evidence?.v2;
  if (!passed(parity) || !passed(v2)) errors.push(error('V2_PARITY_FAILED', 'v2'));
  if (!digest(parity?.digest) || !digest(v2?.parityDigest) || parity.digest.toLowerCase() !== v2.parityDigest.toLowerCase()) errors.push(error('MISSING_DIGEST_IDENTITY', 'v2'));
  const identity = evidence?.identity;
  if (!isRecord(identity) || typeof identity.sourceCommit !== 'string' || !COMMIT.test(identity.sourceCommit)) errors.push(error('MISSING_DIGEST_IDENTITY', 'identity'));
  else for (const field of DIGEST_FIELDS) if (!digest(identity[field])) errors.push(error('MISSING_DIGEST_IDENTITY', field));
  return {
    sourceCommit: COMMIT.test(identity?.sourceCommit ?? '') ? identity.sourceCommit.toLowerCase() : null,
    v1: { expected: digest(v1?.expectedDigest) ? v1.expectedDigest.toLowerCase() : null, actual: digest(v1?.actualDigest) ? v1.actualDigest.toLowerCase() : null },
    v2: { parity: digest(v2?.parityDigest) ? v2.parityDigest.toLowerCase() : null },
    identity: Object.fromEntries(DIGEST_FIELDS.map((field) => [field, digest(identity?.[field]) ? identity[field].toLowerCase() : null])),
  };
}

function checkBrowserAndParity(run, errors) {
  const browser = run?.browserSafe;
  if (!passed(browser) || !Array.isArray(browser.violations) || browser.violations.length !== 0) errors.push(error('BROWSER_SAFE_FAILED', 'browser-safe'));
  if (!passed(run?.v2Parity)) errors.push(error('V2_PARITY_FAILED', 'v2'));
}

function checkExternal(run, evidence, errors) {
  for (const source of [run?.externalGates, evidence?.externalGates]) {
    if (source === undefined) continue;
    if (!isRecord(source)) { errors.push(error('MALFORMED_RUN', 'external-gates')); continue; }
    for (const id of Object.keys(source).sort()) if (claimed(source[id])) errors.push(error('EXTERNAL_GATE_CLAIMED', EXTERNAL.includes(id) ? id : 'external-gate'));
  }
  return fixedExternalGates();
}

export function runPhase9Gate(input = {}) {
  const source = isRecord(input) ? input : {};
  const run = isRecord(source.run) ? source.run : {};
  const evidence = isRecord(source.evidence) ? source.evidence : {};
  const errors = [];
  const packetStatuses = buildPacketStatuses(run, evidence, errors);
  const localCommands = commandStatuses(run, errors);
  checkFiles(run, errors);
  checkBrowserAndParity(run, errors);
  const digests = checkDigests(run, evidence, errors);
  const externalGates = checkExternal(run, evidence, errors);
  const uniqueErrors = [...new Map(errors.map((item) => [`${item.code}:${item.subject}`, item])).values()];
  return {
    schemaVersion: SCHEMA,
    status: uniqueErrors.length === 0 ? 'READY_FOR_RELEASE_REVIEW' : 'BLOCKED',
    packetStatuses,
    localCommands,
    digests,
    externalGates,
    publish: 'PUBLISH: NOT_REQUESTED',
    errors: uniqueErrors,
  };
}

const fixtureDigest = 'a'.repeat(64);
const fixture = {
  run: {
    packets: Object.fromEntries(PACKETS.map((id) => [id, { status: 'passed' }])),
    commands: { 'focused-vitest': { status: 'passed', exitCode: 0 }, 'file-size': { status: 'passed', exitCode: 0 }, 'browser-safe': { status: 'passed', exitCode: 0 } },
    changedFiles: [{ path: 'scripts/check-scanner-phase9.mjs', lines: 190 }], browserSafe: { status: 'passed', violations: [] },
    v2Parity: { status: 'passed', digest: fixtureDigest }, externalGates: {},
  },
  evidence: {
    packets: Object.fromEntries(PACKETS.map((id) => [id, { present: true }])),
    v1: { expectedDigest: fixtureDigest, actualDigest: fixtureDigest }, v2: { parityDigest: fixtureDigest, status: 'passed' },
    identity: Object.fromEntries([['sourceCommit', 'd060b69'], ...DIGEST_FIELDS.map((field) => [field, fixtureDigest])]),
  },
};

function main() {
  const args = process.argv.slice(2);
  let input = args.includes('--fixture') ? fixture : {};
  const inputIndex = args.indexOf('--input');
  if (inputIndex >= 0 && args[inputIndex + 1]) {
    try { input = JSON.parse(readFileSync(resolve(args[inputIndex + 1]), 'utf8')); } catch { input = {}; }
  }
  const report = runPhase9Gate(input);
  if (args.includes('--write')) {
    const output = resolve(import.meta.dirname, '..', 'pipeline/.work/phase-9-release-candidate.json');
    mkdirSync(resolve(output, '..'), { recursive: true });
    writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  }
  process.stdout.write(`${JSON.stringify(report)}\n`);
  return report.status === 'READY_FOR_RELEASE_REVIEW' ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main();
