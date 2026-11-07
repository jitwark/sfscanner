export type StrictSemver = Readonly<{
  major: number;
  minor: number;
  patch: number;
  prerelease: readonly string[];
  build: readonly string[];
}>;

/** Alias matching the SemVer spelling used by some catalogue contracts. */
export type StrictSemVer = StrictSemver;

type SemverParts = Readonly<{
  major: string;
  minor: string;
  patch: string;
  prerelease: readonly string[];
  build: readonly string[];
}>;

const NUMERIC = /^[0-9]+$/;
const parsedParts = new WeakMap<object, SemverParts>();

function invalid(): TypeError {
  return new TypeError('Invalid strict SemVer 2.0.0 value');
}

function compareAscii(left: string, right: string): number {
  if (left === right) return 0;
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const difference = left.charCodeAt(index) - right.charCodeAt(index);
    if (difference !== 0) return difference < 0 ? -1 : 1;
  }
  return left.length < right.length ? -1 : 1;
}

function compareNumericStrings(left: string, right: string): number {
  if (left.length !== right.length) return left.length < right.length ? -1 : 1;
  return compareAscii(left, right);
}

function identifier(value: string, prerelease: boolean): string {
  if (!/^[0-9A-Za-z-]+$/.test(value)) throw invalid();
  if (prerelease && NUMERIC.test(value) && value.length > 1 && value[0] === '0') throw invalid();
  return value;
}

function numberPart(value: string): string {
  if (value.length > 1 && value[0] === '0') throw invalid();
  return value;
}
function isDigit(code: number): boolean { return code >= 48 && code <= 57; }
function readNumber(input: string, index: number): { value: string; next: number } {
  const start = index;
  while (index < input.length && isDigit(input.charCodeAt(index))) index += 1;
  if (index === start) throw invalid();
  const value = input.slice(start, index); numberPart(value);
  return { value, next: index };
}
function readVersionIdentifiers(input: string, index: number, prerelease: boolean): { values: readonly string[]; next: number } {
  const values: string[] = [];
  while (true) {
    const start = index;
    while (index < input.length) {
      const code = input.charCodeAt(index);
      if (code === 46 || (prerelease && code === 43)) break;
      index += 1;
    }
    if (index === start) throw invalid();
    values.push(identifier(input.slice(start, index), prerelease));
    if (index >= input.length || input.charCodeAt(index) !== 46) return { values, next: index };
    index += 1;
  }
}
function parseParts(input: unknown): SemverParts {
  if (typeof input !== 'string') throw invalid();
  let index = 0;
  const major = readNumber(input, index);
  index = major.next;
  if (input.charCodeAt(index) !== 46) throw invalid();
  index += 1;
  const minor = readNumber(input, index);
  index = minor.next;
  if (input.charCodeAt(index) !== 46) throw invalid();
  index += 1;
  const patch = readNumber(input, index);
  index = patch.next;
  let prerelease: readonly string[] = [];
  if (input.charCodeAt(index) === 45) {
    const parsed = readVersionIdentifiers(input, index + 1, true);
    prerelease = parsed.values;
    index = parsed.next;
  }
  let build: readonly string[] = [];
  if (input.charCodeAt(index) === 43) {
    const parsed = readVersionIdentifiers(input, index + 1, false);
    build = parsed.values;
    index = parsed.next;
  }

  if (index !== input.length) throw invalid();
  return { major: major.value, minor: minor.value, patch: patch.value, prerelease, build };
}

/** Parse a strict, complete SemVer 2.0.0 string into immutable numeric parts. */
export function parseStrictSemver(input: unknown): StrictSemver {
  const parts = parseParts(input);
  const result = Object.freeze({
    major: Number(parts.major),
    minor: Number(parts.minor),
    patch: Number(parts.patch),
    prerelease: Object.freeze([...parts.prerelease]),
    build: Object.freeze([...parts.build]),
  });
  parsedParts.set(result, parts);
  return result;
}

function readIdentifiers(input: unknown, prerelease: boolean): readonly string[] {
  if (!Array.isArray(input) || Object.getPrototypeOf(input) !== Array.prototype) throw invalid();
  const names = Object.getOwnPropertyNames(input);
  if (names.length !== input.length + 1 || !names.includes('length')) throw invalid();
  if (Object.getOwnPropertySymbols(input).length !== 0) throw invalid();
  const result: string[] = [];
  for (let index = 0; index < input.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
    if (descriptor === undefined || !('value' in descriptor) || typeof descriptor.value !== 'string') throw invalid();
    result.push(identifier(descriptor.value, prerelease));
  }
  return result;
}

function readParts(input: unknown): SemverParts {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) throw invalid();
  const known = parsedParts.get(input);
  if (known !== undefined) return known;
  if (Object.getPrototypeOf(input) !== Object.prototype && Object.getPrototypeOf(input) !== null) throw invalid();
  const names = Object.getOwnPropertyNames(input);
  const fields = ['major', 'minor', 'patch', 'prerelease', 'build'];
  if (names.length !== fields.length || fields.some((field) => !names.includes(field)) || Object.getOwnPropertySymbols(input).length !== 0) throw invalid();
  const read = (field: string): unknown => {
    const descriptor = Object.getOwnPropertyDescriptor(input, field);
    if (descriptor === undefined || !('value' in descriptor)) throw invalid();
    return descriptor.value;
  };
  const major = read('major');
  const minor = read('minor');
  const patch = read('patch');
  if (typeof major !== 'number' || !Number.isSafeInteger(major) || major < 0 || Object.is(major, -0) || typeof minor !== 'number' || !Number.isSafeInteger(minor) || minor < 0 || Object.is(minor, -0) || typeof patch !== 'number' || !Number.isSafeInteger(patch) || patch < 0 || Object.is(patch, -0)) throw invalid();
  return { major: String(major), minor: String(minor), patch: String(patch), prerelease: readIdentifiers(read('prerelease'), true), build: readIdentifiers(read('build'), false) };
}

/** Compare two parsed SemVer values; build metadata is intentionally ignored. */
export function compareSemver(left: StrictSemver, right: StrictSemver): number {
  try {
    const first = readParts(left);
    const second = readParts(right);
    for (const key of ['major', 'minor', 'patch'] as const) {
      const result = compareNumericStrings(first[key], second[key]);
      if (result !== 0) return result;
    }
    if (first.prerelease.length === 0 && second.prerelease.length === 0) return 0;
    if (first.prerelease.length === 0) return 1;
    if (second.prerelease.length === 0) return -1;
    const length = Math.min(first.prerelease.length, second.prerelease.length);
    for (let index = 0; index < length; index += 1) {
      const leftIdentifier = first.prerelease[index];
      const rightIdentifier = second.prerelease[index];
      const leftNumeric = NUMERIC.test(leftIdentifier);
      const rightNumeric = NUMERIC.test(rightIdentifier);
      if (leftNumeric && rightNumeric) {
        const result = compareNumericStrings(leftIdentifier, rightIdentifier);
        if (result !== 0) return result;
      } else if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
      else {
        const result = compareAscii(leftIdentifier, rightIdentifier);
        if (result !== 0) return result;
      }
    }
    return first.prerelease.length === second.prerelease.length ? 0 : first.prerelease.length < second.prerelease.length ? -1 : 1;
  } catch (error) {
    if (error instanceof TypeError) throw error;
    throw invalid();
  }
}

/** Compare only MAJOR.MINOR.PATCH, preserving arbitrary-length numeric identifiers. */
export function sameSemverBase(left: StrictSemver, right: StrictSemver): boolean {
  try {
    const first = readParts(left);
    const second = readParts(right);
    return first.major === second.major && first.minor === second.minor && first.patch === second.patch;
  } catch (error) {
    if (error instanceof TypeError) throw error;
    throw invalid();
  }
}
