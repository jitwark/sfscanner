import { compareSemver, parseStrictSemver, sameSemverBase, type StrictSemver } from './semver';

export type VersionOperator = 'EQ' | 'LT' | 'LTE' | 'GT' | 'GTE';
export type VersionComparatorV2 = Readonly<{ op: VersionOperator; version: string }>;
export type VersionRangeV2 = Readonly<{ clauses: readonly (readonly VersionComparatorV2[])[] }>;

const operators: Readonly<Record<VersionOperator, number>> = { EQ: 0, LT: 1, LTE: 2, GT: 3, GTE: 4 };
const validOperators: Readonly<Record<VersionOperator, true>> = { EQ: true, LT: true, LTE: true, GT: true, GTE: true };

type CheckedComparator = Readonly<{ value: VersionComparatorV2; parsed: StrictSemver }>;
type CheckedClause = readonly CheckedComparator[];

function invalid(): TypeError {
  return new TypeError('Invalid or noncanonical comparator version range');
}

function asciiCompare(left: string, right: string): number {
  if (left === right) return 0;
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const difference = left.charCodeAt(index) - right.charCodeAt(index);
    if (difference !== 0) return difference < 0 ? -1 : 1;
  }
  return left.length < right.length ? -1 : 1;
}

function ownRecord(input: unknown, fields: readonly string[]): Record<string, unknown> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) throw invalid();
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) throw invalid();
  const names = Object.getOwnPropertyNames(input);
  if (names.length !== fields.length || fields.some((field) => !names.includes(field)) || Object.getOwnPropertySymbols(input).length !== 0) throw invalid();
  const result: Record<string, unknown> = {};
  for (const field of fields) {
    const descriptor = Object.getOwnPropertyDescriptor(input, field);
    if (descriptor === undefined || !('value' in descriptor)) throw invalid();
    result[field] = descriptor.value;
  }
  return result;
}

function denseArray(input: unknown): readonly unknown[] {
  if (!Array.isArray(input) || Object.getPrototypeOf(input) !== Array.prototype) throw invalid();
  const length = Object.getOwnPropertyDescriptor(input, 'length');
  if (length === undefined || !('value' in length) || typeof length.value !== 'number' || !Number.isSafeInteger(length.value) || length.value < 0) throw invalid();
  const names = Object.getOwnPropertyNames(input);
  if (names.length !== length.value + 1 || !names.includes('length') || Object.getOwnPropertySymbols(input).length !== 0) throw invalid();
  const result: unknown[] = [];
  for (let index = 0; index < length.value; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
    if (descriptor === undefined || !('value' in descriptor)) throw invalid();
    result.push(descriptor.value);
  }
  return result;
}

function comparator(input: unknown): CheckedComparator {
  const value = ownRecord(input, ['op', 'version']);
  if (typeof value.op !== 'string' || !Object.prototype.hasOwnProperty.call(validOperators, value.op) || typeof value.version !== 'string') throw invalid();
  const parsed = parseStrictSemver(value.version);
  return { value: { op: value.op as VersionOperator, version: value.version }, parsed };
}

function compareComparator(left: CheckedComparator, right: CheckedComparator): number {
  const byVersion = compareSemver(left.parsed, right.parsed);
  if (byVersion !== 0) return byVersion;
  const byText = asciiCompare(left.value.version, right.value.version);
  if (byText !== 0) return byText;
  return operators[left.value.op] - operators[right.value.op];
}

function compareClause(left: CheckedClause, right: CheckedClause): number {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const result = compareComparator(left[index], right[index]);
    if (result !== 0) return result;
  }
  return left.length === right.length ? 0 : left.length < right.length ? -1 : 1;
}

type CheckedRange = Readonly<{ range: VersionRangeV2; clauses: readonly CheckedClause[] }>;

function checkedRange(input: unknown): CheckedRange {
  const value = ownRecord(input, ['clauses']);
  const rawClauses = denseArray(value.clauses);
  const checked: CheckedClause[] = [];
  for (const rawClause of rawClauses) {
    const rawComparators = denseArray(rawClause);
    if (rawComparators.length === 0) throw invalid();
    const clause = rawComparators.map(comparator);
    for (let index = 1; index < clause.length; index += 1) if (compareComparator(clause[index - 1], clause[index]) >= 0) throw invalid();
    checked.push(Object.freeze(clause));
  }
  for (let index = 1; index < checked.length; index += 1) if (compareClause(checked[index - 1], checked[index]) >= 0) throw invalid();
  const clauses = checked.map((clause) => Object.freeze(clause.map((item) => Object.freeze({ ...item.value }))));
  return Object.freeze({ range: Object.freeze({ clauses: Object.freeze(clauses) }), clauses: Object.freeze(checked) });
}

/** Validate a closed, sorted comparator-clause range and return immutable data. */
export function validateVersionRange(input: unknown): VersionRangeV2 {
  try {
    return checkedRange(input).range;
  } catch (error) {
    if (error instanceof TypeError) throw error;
    throw invalid();
  }
}

function candidateHasPrerelease(version: StrictSemver): boolean {
  compareSemver(version, version);
  if (version === null || typeof version !== 'object' || Array.isArray(version)) throw invalid();
  const prerelease = Object.getOwnPropertyDescriptor(version, 'prerelease');
  if (prerelease === undefined || !('value' in prerelease) || !Array.isArray(prerelease.value)) throw invalid();
  const length = Object.getOwnPropertyDescriptor(prerelease.value, 'length');
  if (length === undefined || !('value' in length) || typeof length.value !== 'number' || !Number.isSafeInteger(length.value) || length.value < 0) throw invalid();
  return length.value > 0;
}

function satisfies(version: StrictSemver, comparatorValue: CheckedComparator): boolean {
  const comparison = compareSemver(version, comparatorValue.parsed);
  switch (comparatorValue.value.op) {
    case 'EQ': return comparison === 0;
    case 'LT': return comparison < 0;
    case 'LTE': return comparison <= 0;
    case 'GT': return comparison > 0;
    case 'GTE': return comparison >= 0;
  }
}

/** Match a parsed version against a validated canonical range. */
export function matchesVersionRange(version: StrictSemver, range: VersionRangeV2): boolean {
  try {
    const candidate = version;
    const candidatePrerelease = candidateHasPrerelease(candidate);
    const checked = checkedRange(range);
    if (checked.clauses.length === 0) return !candidatePrerelease;
    return checked.clauses.some((clause) => {
      if (candidatePrerelease && !clause.some((item) => item.parsed.prerelease.length > 0 && sameSemverBase(candidate, item.parsed))) return false;
      return clause.every((item) => satisfies(candidate, item));
    });
  } catch (error) {
    if (error instanceof TypeError) throw error;
    throw invalid();
  }
}
