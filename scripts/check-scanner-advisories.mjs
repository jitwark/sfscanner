import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const DIGEST = /^[0-9a-f]{64}$/;
const DATE = /^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])(?:T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?Z)?$/;
const ADVISORY_TOP = ['schemaVersion', 'version', 'records', 'digest'];
const QUARANTINE_TOP = ['schemaVersion', 'version', 'records', 'digest'];
const ADVISORY_RECORD = ['id', 'aliases', 'packageName', 'rawAffectedRange', 'affected', 'fixedVersions', 'fixedBranches', 'prerequisites', 'cvss', 'sourceUrl', 'sourceDigest', 'reviewedAt', 'reviewer', 'reviewState'];
const QUARANTINE_RECORD = ['id', 'reason'];
const IDENTIFIER = /^[A-Z0-9][A-Z0-9._:-]*$/;
const PACKAGE = /^(?:[a-z0-9][a-z0-9._-]*|@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*)$/;
const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
const CVSS = /^(CVSS:(3\.1|4\.0)\/[A-Z0-9-]+:[A-Z0-9-]+(?:\/[A-Z0-9-]+:[A-Z0-9-]+)+)$/;
const OPERATORS = { EQ: 0, LT: 1, LTE: 2, GT: 3, GTE: 4 };
const ENUM_PREREQUISITES = new Set(['edition', 'deployment', 'role', 'taskRunner']);

function fail() { throw new Error('static advisory data error'); }
function object(value, keys) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail();
  const names = Object.keys(value);
  if (names.some((name) => !keys.includes(name))) fail();
  return value;
}
function required(value, keys) { if (keys.some((key) => !(key in value))) fail(); }
function text(value, maximum = 4096) {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum || value !== value.normalize('NFC')) fail();
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) fail();
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) fail();
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) fail();
  }
  if (new TextEncoder().encode(value).length > maximum) fail();
  return value;
}
function canonical(value) {
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(Object.is(value, -0) ? 0 : value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (typeof value === 'object') return `{${Object.keys(value).sort(compareText).map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  fail();
}
function compareText(left, right) { return left === right ? 0 : left < right ? -1 : 1; }
function digest(body) { return createHash('sha256').update(canonical(body), 'utf8').digest('hex'); }
function checkDigest(value, body) {
  if (typeof value.digest !== 'string' || !DIGEST.test(value.digest) || value.digest !== digest(body)) fail();
}
function calendar(value) {
  const normalized = text(value, 64);
  const match = DATE.exec(normalized); if (!match) fail();
  const year = Number(match[1]); const month = Number(match[2]); const day = Number(match[3]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = month === 2 ? (leap ? 29 : 28) : [4, 6, 9, 11].includes(month) ? 30 : 31;
  if (day > days) fail();
  return normalized;
}
function parseSemver(value) {
  if (typeof value !== 'string') fail();
  const match = SEMVER.exec(value); if (!match) fail();
  for (const part of [match[1], match[2], match[3]]) if (part.length > 1 && part[0] === '0') fail();
  const prerelease = match[4] ? match[4].split('.') : [];
  for (const identifier of prerelease) if (/^\d+$/.test(identifier) && identifier.length > 1 && identifier[0] === '0') fail();
  return { major: match[1], minor: match[2], patch: match[3], prerelease, build: match[5] ? match[5].split('.') : [] };
}
function semverText(value) {
  if (typeof value === 'string') return value;
  const version = object(value, ['major', 'minor', 'patch', 'prerelease', 'build']);
  for (const part of [version.major, version.minor, version.patch]) if (!Number.isSafeInteger(part) || part < 0) fail();
  for (const values of [version.prerelease, version.build]) {
    if (!Array.isArray(values) || values.some((item) => typeof item !== 'string')) fail();
    for (const item of values) text(item, 256);
  }
  const result = `${version.major}.${version.minor}.${version.patch}${version.prerelease.length ? `-${version.prerelease.join('.')}` : ''}${version.build.length ? `+${version.build.join('.')}` : ''}`;
  parseSemver(result);
  return result;
}
function strictVersion(value) { parseSemver(value); }
function compareNumeric(left, right) {
  if (left.length !== right.length) return left.length < right.length ? -1 : 1;
  return compareText(left, right);
}
function compareSemver(left, right) {
  for (const key of ['major', 'minor', 'patch']) {
    const result = compareNumeric(left[key], right[key]);
    if (result !== 0) return result;
  }
  if (left.prerelease.length === 0 && right.prerelease.length === 0) return 0;
  if (left.prerelease.length === 0) return 1;
  if (right.prerelease.length === 0) return -1;
  const length = Math.min(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const leftIdentifier = left.prerelease[index]; const rightIdentifier = right.prerelease[index];
    const leftNumeric = /^\d+$/.test(leftIdentifier); const rightNumeric = /^\d+$/.test(rightIdentifier);
    if (leftNumeric && rightNumeric) {
      const result = compareNumeric(leftIdentifier, rightIdentifier); if (result !== 0) return result;
    } else if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    else { const result = compareText(leftIdentifier, rightIdentifier); if (result !== 0) return result; }
  }
  return left.prerelease.length === right.prerelease.length ? 0 : left.prerelease.length < right.prerelease.length ? -1 : 1;
}
function normalizedFixedVersion(value) {
  const parsed = parseSemver(semverText(value));
  const major = Number(parsed.major); const minor = Number(parsed.minor); const patch = Number(parsed.patch);
  if (![major, minor, patch].every((part) => Number.isSafeInteger(part))) fail();
  return { major, minor, patch, prerelease: parsed.prerelease, build: parsed.build };
}
function fixedVersionText(value) {
  return `${value.major}.${value.minor}.${value.patch}${value.prerelease.length ? `-${value.prerelease.join('.')}` : ''}${value.build.length ? `+${value.build.join('.')}` : ''}`;
}
function compareFixedVersions(left, right) {
  return compareSemver(parseSemver(fixedVersionText(left)), parseSemver(fixedVersionText(right))) || compareText(fixedVersionText(left), fixedVersionText(right));
}
function identifier(value) {
  const normalized = text(value).trim().toUpperCase();
  if (!IDENTIFIER.test(normalized)) fail();
  return normalized;
}
function packageName(value) {
  const normalized = text(value).trim().toLowerCase();
  if (!PACKAGE.test(normalized)) fail();
  return normalized;
}
function sorted(values) { return [...new Set(values)].sort(compareText); }
function normalizeComparator(value) {
  const comparator = object(value, ['op', 'version']); required(comparator, ['op', 'version']);
  if (!Object.prototype.hasOwnProperty.call(OPERATORS, comparator.op)) fail();
  const version = semverText(comparator.version); strictVersion(version);
  return { op: comparator.op, version };
}
function compareComparator(left, right) {
  const byVersion = compareSemver(parseSemver(left.version), parseSemver(right.version));
  if (byVersion !== 0) return byVersion;
  return OPERATORS[left.op] - OPERATORS[right.op] || compareText(canonical(left), canonical(right));
}
function compareRangeComparator(left, right) {
  const byVersion = compareSemver(parseSemver(left.version), parseSemver(right.version));
  if (byVersion !== 0) return byVersion;
  return compareText(left.version, right.version) || OPERATORS[left.op] - OPERATORS[right.op];
}
function compareClause(left, right) {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const result = compareRangeComparator(left[index], right[index]);
    if (result !== 0) return result;
  }
  return left.length === right.length ? 0 : left.length < right.length ? -1 : 1;
}
function normalizeRange(value) {
  const range = object(value, ['clauses']); required(range, ['clauses']);
  if (!Array.isArray(range.clauses)) fail();
  const clauses = range.clauses.map((rawClause) => {
    if (!Array.isArray(rawClause) || rawClause.length === 0) fail();
    const clause = rawClause.map(normalizeComparator).sort(compareComparator);
    for (let index = 1; index < clause.length; index += 1) if (compareRangeComparator(clause[index - 1], clause[index]) >= 0) fail();
    return clause;
  }).sort((left, right) => compareText(canonical(left), canonical(right)));
  for (let index = 1; index < clauses.length; index += 1) if (compareClause(clauses[index - 1], clauses[index]) >= 0) fail();
  return { clauses };
}
function normalizePrerequisite(value) {
  const prerequisite = object(value, ['key', 'expected']); required(prerequisite, ['key', 'expected']);
  let key = text(prerequisite.key).trim(); let expected = text(prerequisite.expected).trim();
  if (!key || !expected) fail();
  const aliases = { edition: 'edition', deployment: 'deployment', role: 'role', taskrunner: 'taskRunner', n8nversion: 'n8nVersion' };
  key = aliases[key.toLowerCase()] ?? key;
  if (ENUM_PREREQUISITES.has(key)) expected = expected.toUpperCase();
  if (key.startsWith('package:')) key = `package:${packageName(key.slice(8))}`;
  if (key.startsWith('configuration:')) key = `configuration:${text(key.slice(14))}`;
  if (!/^(?:edition|deployment|role|taskRunner|n8nVersion|package:[a-z0-9@][a-z0-9._@\/-]*|configuration:[a-zA-Z0-9._-]+)$/.test(key)) fail();
  return { key, expected };
}
function normalizeCvss(value) {
  const cvss = object(value, ['version', 'publisher', 'vector']); required(cvss, ['version', 'publisher', 'vector']);
  if (cvss.version !== '3.1' && cvss.version !== '4.0') fail();
  const publisher = text(cvss.publisher, 256).trim(); const vector = text(cvss.vector, 512).trim();
  if (!publisher || !CVSS.test(vector) || !vector.startsWith(`CVSS:${cvss.version}/`)) fail();
  return { version: cvss.version, publisher, vector };
}
function source(record) {
  const sourceUrl = text(record.sourceUrl, 2048).trim();
  try { const parsed = new URL(sourceUrl); if (parsed.protocol !== 'https:' || parsed.username || parsed.password || !parsed.hostname) fail(); } catch { fail(); }
  const sourceDigest = text(record.sourceDigest, 64); if (!DIGEST.test(sourceDigest)) fail();
  const reviewer = text(record.reviewer).trim(); if (!reviewer) fail();
  return { sourceUrl, sourceDigest, reviewedAt: calendar(record.reviewedAt), reviewer };
}
function normalizeRecord(value) {
  const record = object(value, ADVISORY_RECORD); required(record, ADVISORY_RECORD.filter((key) => key !== 'cvss'));
  if (!['ADMITTED', 'WITHDRAWN', 'REJECTED'].includes(record.reviewState)) fail();
  if (!Array.isArray(record.aliases) || !Array.isArray(record.fixedVersions) || !Array.isArray(record.fixedBranches) || !Array.isArray(record.prerequisites)) fail();
  const id = identifier(record.id);
  const aliases = sorted(record.aliases.map(identifier).concat(id));
  const provenance = source(record);
  const normalized = {
    id,
    aliases,
    packageName: packageName(record.packageName),
    rawAffectedRange: text(record.rawAffectedRange),
    affected: normalizeRange(record.affected),
    fixedVersions: record.fixedVersions.map(normalizedFixedVersion).sort(compareFixedVersions),
    fixedBranches: sorted(record.fixedBranches.map((branch) => text(branch).trim())),
    prerequisites: record.prerequisites.map(normalizePrerequisite).sort((left, right) => compareText(canonical(left), canonical(right))),
    sourceUrl: provenance.sourceUrl,
    sourceDigest: provenance.sourceDigest,
    reviewedAt: provenance.reviewedAt,
    reviewer: provenance.reviewer,
    reviewState: record.reviewState,
  };
  if (!normalized.rawAffectedRange.trim() || normalized.fixedBranches.some((branch) => !branch)) fail();
  if (new Set(normalized.prerequisites.map(canonical)).size !== normalized.prerequisites.length) fail();
  if ('cvss' in record) { if (record.cvss === undefined) fail(); normalized.cvss = normalizeCvss(record.cvss); }
  return normalized;
}
function normalizedAdvisoryBody(value) {
  const catalogue = object(value, ADVISORY_TOP); required(catalogue, ADVISORY_TOP);
  if (catalogue.schemaVersion !== 'scanner-advisories-v2') fail();
  const version = semverText(catalogue.version); strictVersion(version);
  if (!Array.isArray(catalogue.records)) fail();
  const records = catalogue.records.map(normalizeRecord).sort((left, right) => compareText(canonical(left), canonical(right)));
  const ids = new Set(); const aliases = new Set();
  for (const record of records) {
    if (ids.has(record.id)) fail(); ids.add(record.id);
    for (const alias of record.aliases) { if (aliases.has(alias)) fail(); aliases.add(alias); }
  }
  return { schemaVersion: 'scanner-advisories-v2', version, records };
}
function checkAdvisory(value) { checkDigest(value, normalizedAdvisoryBody(value)); }
function checkQuarantine(value) {
  const quarantine = object(value, QUARANTINE_TOP); required(quarantine, QUARANTINE_TOP);
  if (quarantine.schemaVersion !== 'scanner-advisory-quarantine-v1' || typeof quarantine.version !== 'string') fail();
  strictVersion(quarantine.version);
  if (!Array.isArray(quarantine.records)) fail();
  const ids = new Set();
  for (const recordValue of quarantine.records) {
    const record = object(recordValue, QUARANTINE_RECORD); required(record, QUARANTINE_RECORD);
    if (typeof record.id !== 'string' || !IDENTIFIER.test(record.id) || typeof record.reason !== 'string' || !/^[A-Z][A-Z0-9_]{1,63}$/.test(record.reason)) fail();
    if (ids.has(record.id)) fail();
    ids.add(record.id);
  }
  const { digest: _digest, ...body } = quarantine;
  checkDigest(quarantine, body);
}
function readJson(file) { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { fail(); } }
function main() {
  if (process.argv.length !== 4) fail();
  checkAdvisory(readJson(process.argv[2]));
  checkQuarantine(readJson(process.argv[3]));
  console.log('scanner advisory data passed');
}

try { main(); } catch { console.error('static advisory data error'); process.exitCode = 1; }
