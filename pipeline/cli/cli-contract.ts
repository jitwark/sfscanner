export const CLI_EXIT_CODES = Object.freeze({
  SUCCESS: 0,
  FINDINGS: 1,
  USAGE: 2,
  INPUT: 3,
  INTERNAL: 4,
  CANCELLED: 130,
} as const);

export type CliExitCode = (typeof CLI_EXIT_CODES)[keyof typeof CLI_EXIT_CODES];
export type ScanFormat = 'json' | 'sarif' | 'table';
export type ScanProfile = 'beta-default' | 'beta-hardened';
export type FailSeverity = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' | 'INFO';
export type FailThreshold = FailSeverity | 'indeterminate';
export type CliHelpTopic = 'general' | 'scan';

export type ScanCommand = {
  kind: 'scan';
  inputs: string[];
  format: ScanFormat;
  output?: string;
  profile: ScanProfile;
  approvedDomains: string[];
  failOn?: FailThreshold;
  maxConcurrency?: number;
  timeoutMs?: number;
  include: string[];
  exclude: string[];
  noColor: boolean;
};

export type CliCommand =
  | ScanCommand
  | { kind: 'rules' }
  | { kind: 'explain'; policyId: string }
  | { kind: 'help'; topic: CliHelpTopic }
  | { kind: 'version'; json: boolean };

export type CliParseErrorCode = 'NO_COMMAND' | 'UNKNOWN_COMMAND' | 'UNKNOWN_OPTION' | 'MISSING_VALUE' | 'INVALID_VALUE' | 'UNEXPECTED_ARGUMENT';
export type CliParseError = {
  code: CliParseErrorCode;
  message: string;
  argument?: string;
};
export type CliParseResult = { ok: true; command: CliCommand } | { ok: false; error: CliParseError };

const FORMATS: readonly ScanFormat[] = ['json', 'sarif', 'table'];
const PROFILES: readonly ScanProfile[] = ['beta-default', 'beta-hardened'];
const SEVERITIES: readonly FailSeverity[] = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO'];

/** Node's setTimeout delay is a signed 32-bit int; above this it silently fires at ~1ms instead. */
export const CLI_TIMEOUT_MAX_MS = 2 ** 31 - 1;
/** Bounds parallel scan workers; independent of the timer ceiling above. */
export const CLI_MAX_CONCURRENCY_LIMIT = 16;

export function parseCliArguments(argv: readonly string[]): CliParseResult {
  const [rawCommand, ...rest] = argv;
  if (!rawCommand) return failure('NO_COMMAND', 'A command is required: scan, rules, explain, or version.');
  if (rawCommand === '--help') {
    return rest.length === 0 ? success({ kind: 'help', topic: 'general' }) : unexpected(rest[0]!);
  }
  if (rawCommand === '--version') {
    return rest.length === 0 ? success({ kind: 'version', json: false }) : unexpected(rest[0]!);
  }
  if (rawCommand === 'rules') return rest.length === 0 ? success({ kind: 'rules' }) : unexpected(rest[0]!);
  if (rawCommand === 'explain') {
    if (rest.length !== 1 || !rest[0] || rest[0].startsWith('-')) return failure('UNEXPECTED_ARGUMENT', 'explain requires exactly one policy ID.');
    return success({ kind: 'explain', policyId: rest[0] });
  }
  if (rawCommand === 'version') {
    if (rest.length === 0) return success({ kind: 'version', json: false });
    if (rest.length === 1 && rest[0] === '--json') return success({ kind: 'version', json: true });
    return unexpected(rest[0]!);
  }
  if (rawCommand !== 'scan') return failure('UNKNOWN_COMMAND', `Unknown command: ${rawCommand}`, rawCommand);
  if (rest.length === 1 && rest[0] === '--help') return success({ kind: 'help', topic: 'scan' });

  const command: ScanCommand = {
    kind: 'scan', inputs: [], format: 'table', profile: 'beta-default', approvedDomains: [],
    include: [], exclude: [], noColor: false,
  };
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index]!;
    if (token === '--') {
      command.inputs.push(...rest.slice(index + 1));
      break;
    }
    if (token === '-' || !token.startsWith('-')) { command.inputs.push(token); continue; }
    const equals = token.indexOf('=');
    const name = equals >= 0 ? token.slice(0, equals) : token;
    const inlineValue = equals >= 0 ? token.slice(equals + 1) : undefined;
    if (name === '--no-color') { if (inlineValue !== undefined) return invalid(token); command.noColor = true; continue; }
    if (!['--format', '--output', '--profile', '--approved-domain', '--fail-on', '--max-concurrency', '--timeout', '--include', '--exclude'].includes(name)) {
      return failure('UNKNOWN_OPTION', `Unknown option: ${name}`, name);
    }
    const option = valueFor(name, inlineValue, rest, index);
    if (!option.ok) return option.error;
    if (inlineValue === undefined) index = option.index;
    if (name === '--format' && isOneOf(option.value, FORMATS)) command.format = option.value;
    else if (name === '--profile' && isOneOf(option.value, PROFILES)) command.profile = option.value;
    else if (name === '--approved-domain') command.approvedDomains.push(option.value);
    else if (name === '--include') command.include.push(option.value);
    else if (name === '--exclude') command.exclude.push(option.value);
    else if (name === '--output') command.output = option.value;
    else if (name === '--fail-on') {
      const threshold = parseFailThreshold(option.value);
      if (threshold === undefined) return invalid(option.value, name);
      command.failOn = threshold;
    }
    else if (name === '--max-concurrency') command.maxConcurrency = parseBoundedInteger(option.value, CLI_MAX_CONCURRENCY_LIMIT);
    else if (name === '--timeout') command.timeoutMs = parseBoundedInteger(option.value, CLI_TIMEOUT_MAX_MS);
    if ((name === '--format' && !isOneOf(option.value, FORMATS)) || (name === '--profile' && !isOneOf(option.value, PROFILES)) ||
      ((name === '--max-concurrency' || name === '--timeout') && (name === '--max-concurrency' ? command.maxConcurrency : command.timeoutMs) === undefined)) {
      return invalid(option.value, name);
    }
  }
  return success(command);
}

export function resolveScanExitCode(outcome: { cancelled?: boolean; internalError?: boolean; inputError?: boolean; indeterminate?: boolean; finding?: boolean }): CliExitCode {
  if (outcome.cancelled) return CLI_EXIT_CODES.CANCELLED;
  if (outcome.internalError) return CLI_EXIT_CODES.INTERNAL;
  if (outcome.inputError) return CLI_EXIT_CODES.INPUT;
  if (outcome.finding) return CLI_EXIT_CODES.FINDINGS;
  if (outcome.indeterminate) return CLI_EXIT_CODES.INPUT;
  return CLI_EXIT_CODES.SUCCESS;
}

function valueFor(name: string, inlineValue: string | undefined, argv: readonly string[], index: number): { ok: true; value: string; index: number } | { ok: false; error: CliParseResult } {
  const value = inlineValue ?? argv[index + 1];
  if (value === undefined || value.length === 0 || (inlineValue === undefined && value.startsWith('-') && !(name === '--output' && value === '-'))) {
    return { ok: false, error: failure('MISSING_VALUE', `Option ${name} requires a value.`, name) };
  }
  return { ok: true, value, index: index + 1 };
}

/** Positive-integer digit string, safe to convert, and no greater than `max`. */
function parseBoundedInteger(value: string, max: number): number | undefined {
  if (!/^\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= max ? parsed : undefined;
}

function parseFailThreshold(value: string): FailThreshold | undefined {
  const normalized = value.toUpperCase();
  if (normalized === 'INDETERMINATE') return 'indeterminate';
  return isOneOf(normalized, SEVERITIES) ? normalized : undefined;
}

function isOneOf<T extends string>(value: string, values: readonly T[]): value is T { return values.includes(value as T); }
function success(command: CliCommand): CliParseResult { return { ok: true, command }; }
function failure(code: CliParseErrorCode, message: string, argument?: string): CliParseResult { return { ok: false, error: { code, message, ...(argument ? { argument } : {}) } }; }
function unexpected(argument: string): CliParseResult { return failure('UNEXPECTED_ARGUMENT', `Unexpected argument: ${argument}`, argument); }
function invalid(value: string, argument = value): CliParseResult { return failure('INVALID_VALUE', `Invalid value: ${value}`, argument); }
