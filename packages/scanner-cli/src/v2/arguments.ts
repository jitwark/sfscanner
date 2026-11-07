import { ADMITTED_PROFILE_V2, isAdmittedProfileSpecifierV2, isApprovedDomainV2, type ScanConfigV2, type ScanSeverityV2 } from './contracts.js';
import { isAbsoluteAdmittedPathV2, isAdmittedLocalPath, isAdmittedRelativePath, normalizeAdmittedPathV2 } from './path-admission.js';
import type { V2CommandName } from './help.js';

export type CliFormatV2 = 'json' | 'ndjson' | 'sarif' | 'table';
export type CliProfileV2 = typeof ADMITTED_PROFILE_V2.id;
export type CliTargetEnumV2 = 'UNKNOWN' | 'COMMUNITY' | 'ENTERPRISE' | 'CLOUD' | 'SELF_HOSTED' | 'OWNER' | 'ADMIN' | 'MEMBER' | 'LEGACY' | 'NATIVE';
export type CliParseErrorCodeV2 = 'NO_COMMAND' | 'UNKNOWN_COMMAND' | 'UNKNOWN_OPTION' | 'MISSING_VALUE' | 'INVALID_VALUE' | 'DUPLICATE_OPTION' | 'UNEXPECTED_ARGUMENT' | 'REMOTE_PATH' | 'RULE_PACK_INVALID' | 'SEMANTIC_CATALOGUE_INVALID' | 'PROFILE_NOT_ADMITTED';
export type CliParseErrorV2 = Readonly<{ code: CliParseErrorCodeV2; message: string; argument?: string }>;

type ScanCommandV2 = Readonly<{
  kind: 'scan'; schema: 'v2'; inputs: readonly string[]; format: CliFormatV2; profile: CliProfileV2; failOn: ScanSeverityV2;
  requireComplete: boolean; concurrency: number; timeoutMs?: number; output?: string; configPath?: string;
  rules: 'builtin'; catalogue: 'builtin'; limits: string; target?: string; n8nVersion?: string;
  edition: 'COMMUNITY' | 'ENTERPRISE' | 'CLOUD' | 'UNKNOWN'; deployment: 'SELF_HOSTED' | 'CLOUD' | 'UNKNOWN';
  role: 'OWNER' | 'ADMIN' | 'MEMBER' | 'UNKNOWN'; taskRunner: 'LEGACY' | 'NATIVE' | 'UNKNOWN';
  communityPackages: readonly string[]; configuration: readonly string[]; approvedDomains: readonly string[]; include: readonly string[]; exclude: readonly string[];
  allowUnsignedDevelopmentRules: boolean; noColor: boolean; auditSupplyChain: boolean; includeReadiness: boolean; cliOverrides: Readonly<Partial<ScanConfigV2>>;
}>;
export type CliHelpCommandV2 = Readonly<{ kind: 'help'; schema: 'v2'; command?: V2CommandName }>;
/** Fix output is JSON-only; the fixed `format` keeps downstream command reducers total. */
export type CliFixCommandV2 = Readonly<{
  kind: 'fix'; schema: 'v2'; action: 'suggest' | 'apply'; format: 'json';
  root: string; input: string; fix?: string; mapping?: string; endpointReceipt?: string; confirm: boolean;
}>;
export type CliCommandV2 = ScanCommandV2
  | CliFixCommandV2
  | Readonly<{ kind: 'rules'; schema: 'v2'; format: 'json' | 'table' }>
  | Readonly<{ kind: 'explain'; schema: 'v2'; format: 'json' | 'table'; ruleId: string }>
  | Readonly<{ kind: 'profiles'; schema: 'v2'; format: 'json' | 'table' }>
  | Readonly<{ kind: 'validate-config'; schema: 'v2'; format: 'json' | 'table'; path: string }>
  | Readonly<{ kind: 'version'; schema: 'v2'; format: 'json' | 'table' }>;
type ParsedCommandV2 = CliCommandV2 | CliHelpCommandV2;
export type CliParseResultV2 = Readonly<{ ok: true; command: ParsedCommandV2 } | { ok: false; error: CliParseErrorV2 }>;
export type CliArgumentDispatch = Readonly<{ mode: 'v1'; argv: readonly string[] } | { mode: 'v2'; result: CliParseResultV2 }>;

const severities: readonly ScanSeverityV2[] = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO'];
const commands: Record<string, true> = Object.freeze({ scan: true, fix: true, rules: true, explain: true, profiles: true, 'validate-config': true, version: true, '--version': true });
const implicitV2Commands: Record<string, true> = Object.freeze({ fix: true, rules: true, explain: true, profiles: true, 'validate-config': true, version: true });
const scalarOptions: Record<string, true> = Object.freeze({ '--format': true, '--profile': true, '--fail-on': true, '--max-concurrency': true, '--concurrency': true, '--timeout': true, '--output': true, '--config': true, '--rules': true, '--catalogue': true, '--limits': true, '--target': true, '--n8n-version': true, '--edition': true, '--deployment': true, '--role': true, '--task-runner': true });
const repeatableOptions: Record<string, true> = Object.freeze({ '--community-package': true, '--configuration': true, '--approved-domain': true, '--include': true, '--exclude': true });
const configFields: Record<string, keyof ScanConfigV2> = Object.freeze({ '--format': 'format', '--profile': 'profile', '--fail-on': 'failOn', '--max-concurrency': 'concurrency', '--concurrency': 'concurrency', '--output': 'output', '--config': 'configPath', '--rules': 'rules', '--catalogue': 'catalogue', '--limits': 'limits', '--target': 'target', '--approved-domain': 'approvedDomains', '--include': 'include', '--exclude': 'exclude', 'inputs': 'inputs', '--require-complete': 'requireComplete', '--allow-unsigned-development-rules': 'allowUnsignedDevelopmentRules', '--no-color': 'noColor' });
const overrideOrder: readonly (keyof ScanConfigV2)[] = ['format', 'profile', 'output', 'inputs', 'configPath', 'failOn', 'requireComplete', 'concurrency', 'rules', 'catalogue', 'limits', 'target', 'include', 'exclude', 'approvedDomains', 'allowUnsignedDevelopmentRules', 'noColor'];

export function parseArgumentsV2(argv: readonly string[]): CliParseResultV2 {
  const stripped = stripSchema(argv); if (!stripped.ok) return stripped.result;
  const args = stripped.args; const raw = args[0];
  if (!raw) return failure('NO_COMMAND', 'A v2 command is required.');
  if (raw === '--help') return success({ kind: 'help', schema: 'v2' });
  if (commands[raw] !== true) return failure('UNKNOWN_COMMAND', 'Unknown v2 command.');
  const kind = raw === '--version' ? 'version' : raw;
  if (kind === 'fix') return parseFix(args.slice(1));
  if (kind !== 'scan') return parseMetadata(kind as Exclude<CliCommandV2['kind'], 'scan' | 'help' | 'fix'>, args.slice(1));
  if (args.length === 2 && args[1] === '--help') return success({ kind: 'help', schema: 'v2', command: 'scan' });
  const value: Record<string, unknown> = {
    kind: 'scan', schema: 'v2', inputs: [], format: 'json', profile: 'beta-default', failOn: 'INFO', requireComplete: false,
    concurrency: 1, rules: 'builtin', catalogue: 'builtin', limits: 'builtin', edition: 'UNKNOWN', deployment: 'UNKNOWN',
    role: 'UNKNOWN', taskRunner: 'UNKNOWN', communityPackages: [], configuration: [], include: ['**/*.json'],
    exclude: ['.git/**', 'node_modules/**'], allowUnsignedDevelopmentRules: false, noColor: false, auditSupplyChain: false,
    includeReadiness: false,
  };
  const overrides: Record<string, unknown> = {}; const inputs: string[] = []; const repeatable: Record<string, string[]> = { '--community-package': [], '--configuration': [], '--approved-domain': [], '--include': [], '--exclude': [] }; const seen = new Set<string>();
  for (let index = 1; index < args.length; index += 1) {
    const token = args[index]!;
    if (token === '--') {
      for (const rawInput of args.slice(index + 1)) {
        const input = rawInput === '-' ? '-' : normalizeAdmittedPathV2(rawInput);
        if (input === undefined) return failure('REMOTE_PATH', 'Input path is not admitted.');
        inputs.push(input);
      }
      break;
    }
    if (token === '-' || !token.startsWith('-')) {
      const input = token === '-' ? '-' : normalizeAdmittedPathV2(token);
      if (input === undefined) return failure('REMOTE_PATH', 'Input path is not admitted.');
      inputs.push(input);
      continue;
    }
    const [name, inline] = splitOption(token);
    if (name === '--audit-supply-chain' || name === '--include-readiness') {
      if (inline !== undefined) return failure('INVALID_VALUE', 'Boolean option does not accept a value.', name);
      if (seen.has(name)) return failure('DUPLICATE_OPTION', 'Option supplied more than once.', name);
      const next = args[index + 1];
      if (next === 'true' || next === 'false') return failure('INVALID_VALUE', 'Boolean option does not accept a value.', name);
      seen.add(name); value[name === '--include-readiness' ? 'includeReadiness' : 'auditSupplyChain'] = true; continue;
    }
    if (name === '--require-complete' || name === '--allow-unsigned-development-rules' || name === '--no-color') {
      if (inline !== undefined || seen.has(name)) return failure('DUPLICATE_OPTION', 'Option supplied more than once.', name);
      seen.add(name); value[name === '--require-complete' ? 'requireComplete' : name === '--no-color' ? 'noColor' : 'allowUnsignedDevelopmentRules'] = true; overrides[configFields[name]!] = true; continue;
    }
    if (scalarOptions[name] !== true && repeatableOptions[name] !== true) return failure('UNKNOWN_OPTION', 'Unknown option.', name);
    const duplicateKey = name === '--max-concurrency' ? '--concurrency' : name;
    if (seen.has(duplicateKey) && scalarOptions[name] === true) return failure('DUPLICATE_OPTION', 'Option supplied more than once.', name);
    const read = inline === undefined ? args[index + 1] : inline;
    if (read === undefined || read.length === 0 || (inline === undefined && read.startsWith('-') && !(name === '--output' && read === '-'))) return failure('MISSING_VALUE', 'Option requires a value.', name);
    if (inline === undefined) index += 1;
    if (repeatableOptions[name] === true) {
      if (name === '--approved-domain' && !isApprovedDomainV2(read)) return failure('INVALID_VALUE', 'Approved domain is invalid.', name);
      if (!isAdmittedRelativePath(read)) return failure('REMOTE_PATH', 'Option value is not admitted.', name);
      repeatable[name]!.push(read);
      if (configFields[name]) overrides[configFields[name]!] = Object.freeze([...repeatable[name]!]);
      continue;
    }
    if (name === '--format' && !['json', 'ndjson', 'sarif', 'table'].includes(read)) return failure('INVALID_VALUE', 'Format is invalid.', name);
    if (name === '--profile' && !isAdmittedProfileSpecifierV2(read)) return failure('PROFILE_NOT_ADMITTED', 'Profile is not admitted.', name);
    if (name === '--fail-on' && !severities.includes(read as ScanSeverityV2)) return failure('INVALID_VALUE', 'Fail threshold is invalid.', name);
    if ((name === '--max-concurrency' || name === '--concurrency' || name === '--timeout') && !positiveInteger(read, name === '--timeout' ? 2 ** 31 - 1 : 16)) return failure('INVALID_VALUE', 'Numeric option is invalid.', name);
    if (name === '--n8n-version' && !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(read)) return failure('INVALID_VALUE', 'n8n version is invalid.', name);
    if (name === '--edition' && !['COMMUNITY', 'ENTERPRISE', 'CLOUD', 'UNKNOWN'].includes(read)) return failure('INVALID_VALUE', 'Edition is invalid.', name);
    if (name === '--deployment' && !['SELF_HOSTED', 'CLOUD', 'UNKNOWN'].includes(read)) return failure('INVALID_VALUE', 'Deployment is invalid.', name);
    if (name === '--role' && !['OWNER', 'ADMIN', 'MEMBER', 'UNKNOWN'].includes(read)) return failure('INVALID_VALUE', 'Role is invalid.', name);
    if (name === '--task-runner' && !['LEGACY', 'NATIVE', 'UNKNOWN'].includes(read)) return failure('INVALID_VALUE', 'Task runner is invalid.', name);
    if (name === '--rules' || name === '--catalogue') { if (read !== 'builtin') return failure(name === '--rules' ? 'RULE_PACK_INVALID' : 'SEMANTIC_CATALOGUE_INVALID', 'Only built-in authority is available.', name); }
    else if (['--limits', '--target', '--config'].includes(name) && (read === '-' || !isAdmittedRelativePath(read))) return failure('REMOTE_PATH', 'Option value is not admitted.', name);
    else if (name === '--output' && read !== '-' && !isAdmittedRelativePath(read)) return failure('REMOTE_PATH', 'Option value is not admitted.', name);
    else if (['--n8n-version', '--edition', '--deployment', '--role', '--task-runner'].includes(name) && !safeText(read)) return failure('INVALID_VALUE', 'Option value is not admitted.', name);
    seen.add(duplicateKey); assign(value, name, read); if (name === '--profile') value.profile = ADMITTED_PROFILE_V2.id; if (configFields[name]) overrides[configFields[name]!] = ['--max-concurrency', '--concurrency'].includes(name) ? Number(read) : read;
  }
  // No external rule pack is admittable: `--rules`/`--catalogue` accept only the built-in authority,
  // so the unsigned development escape hatch has nothing it could admit. It is refused as a usage
  // error instead of being left to imply that a local pack would be loaded.
  if (value.includeReadiness === true && value.format === 'sarif') return failure('INVALID_VALUE', 'Readiness assessment cannot be projected into SARIF.', '--include-readiness');
  if (value.allowUnsignedDevelopmentRules === true) return failure('RULE_PACK_INVALID', 'External rule packs are not admitted in this release.', '--allow-unsigned-development-rules');
  if (inputs.length === 0) return failure('UNEXPECTED_ARGUMENT', 'At least one workflow input is required.');
  if (inputs.some((input) => input !== '-' && !isAdmittedLocalPath(input))) return failure('REMOTE_PATH', 'Input path is not admitted.');
  if (inputs.includes('-') && inputs.length > 1) return failure('UNEXPECTED_ARGUMENT', 'Standard input cannot be combined with file inputs.');
  overrides.inputs = Object.freeze([...inputs]);
  const cliOverrides: Partial<ScanConfigV2> = {}; const sparse = cliOverrides as Record<string, unknown>; for (const field of overrideOrder) if (Object.prototype.hasOwnProperty.call(overrides, field)) sparse[field] = overrides[field];
  const command: ScanCommandV2 = {
    kind: 'scan', schema: 'v2', inputs: Object.freeze([...inputs]), format: value.format as CliFormatV2, profile: ADMITTED_PROFILE_V2.id, failOn: value.failOn as ScanSeverityV2, requireComplete: value.requireComplete as boolean, concurrency: value.concurrency as number,
    ...(typeof value.timeoutMs === 'number' ? { timeoutMs: value.timeoutMs } : {}), ...(typeof value.output === 'string' ? { output: value.output } : {}), ...(typeof value.configPath === 'string' ? { configPath: value.configPath } : {}), rules: value.rules as 'builtin', catalogue: value.catalogue as 'builtin', limits: value.limits as string,
    ...(typeof value.target === 'string' ? { target: value.target } : {}), ...(typeof value.n8nVersion === 'string' ? { n8nVersion: value.n8nVersion } : {}), edition: value.edition as ScanCommandV2['edition'], deployment: value.deployment as ScanCommandV2['deployment'], role: value.role as ScanCommandV2['role'], taskRunner: value.taskRunner as ScanCommandV2['taskRunner'], communityPackages: arrayFor(repeatable['--community-package']), configuration: arrayFor(repeatable['--configuration']), approvedDomains: arrayFor(repeatable['--approved-domain']), include: repeatable['--include']!.length > 0 ? arrayFor(repeatable['--include']) : Object.freeze(['**/*.json']), exclude: repeatable['--exclude']!.length > 0 ? arrayFor(repeatable['--exclude']) : Object.freeze(['.git/**', 'node_modules/**']), allowUnsignedDevelopmentRules: value.allowUnsignedDevelopmentRules as boolean, noColor: value.noColor as boolean, auditSupplyChain: value.auditSupplyChain === true, includeReadiness: value.includeReadiness as boolean, cliOverrides,
  };
  return success(command);
}

function arrayFor(values: readonly string[] | undefined): readonly string[] { return Object.freeze([...(values ?? [])]); }
export function parseCliArguments(argv: readonly string[]): CliArgumentDispatch { const hasSchema = hasSchemaMarker(argv); const implicit = argv[0] !== undefined && implicitV2Commands[argv[0]!] === true; return hasSchema || implicit ? freeze({ mode: 'v2', result: parseArgumentsV2(argv) }) : freeze({ mode: 'v1', argv: Object.freeze([...argv]) }); }
const FIX_OPTIONS: Record<string, true> = Object.freeze({ '--root': true, '--input': true, '--fix': true, '--mapping': true, '--endpoint-receipt': true });
const FIX_SELECTION = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/u;
const SUBSTITUTION_LITERAL = /(?:\{\{|\}\}|\$env\b|\$\{|\$[A-Za-z_][A-Za-z0-9_]*\b|%[A-Za-z_][A-Za-z0-9_]*%)/u;

/** Admits one path literal: an absolute local root, or a root-relative input/receipt file. */
function fixPathValue(name: string, read: string): string | CliParseResultV2 {
  if (read === '-') return failure('INVALID_VALUE', 'Fix commands require a file path; standard input cannot be re-read.', name);
  if (SUBSTITUTION_LITERAL.test(read)) return failure('REMOTE_PATH', 'Option value is not admitted.', name);
  const value = normalizeAdmittedPathV2(read, name !== '--root');
  if (value === undefined) return failure('REMOTE_PATH', 'Option value is not admitted.', name);
  if (name === '--root' && !isAbsoluteAdmittedPathV2(value)) return failure('INVALID_VALUE', 'Root must be an absolute local directory.', name);
  return value;
}

/**
 * Fix surface: `suggest` plans for the whole workflow unless one `--fix` narrows it; `apply`
 * demands one selection plus explicit `--confirm`. Values are path or ID literals only, so
 * credential values, URL substitutions and endpoint settings cannot be passed on the command line.
 */
function parseFix(args: readonly string[]): CliParseResultV2 {
  const action = args[0];
  if (action !== 'suggest' && action !== 'apply') return failure('UNKNOWN_COMMAND', 'fix requires the suggest or apply subcommand.');
  const selected: Record<string, string> = {};
  const seen = new Set<string>();
  let confirm = false;
  for (let index = 1; index < args.length; index += 1) {
    const token = args[index]!;
    if (!token.startsWith('-') || token === '-') return failure('UNEXPECTED_ARGUMENT', 'fix accepts options only; positional arguments are not admitted.');
    const [name, inline] = splitOption(token);
    if (name === '--confirm') {
      if (inline !== undefined) return failure('INVALID_VALUE', 'Boolean option does not accept a value.', name);
      if (action !== 'apply') return failure('UNEXPECTED_ARGUMENT', 'The suggest action does not accept --confirm.', name);
      if (seen.has(name)) return failure('DUPLICATE_OPTION', 'Option supplied more than once.', name);
      seen.add(name); confirm = true; continue;
    }
    if (FIX_OPTIONS[name] !== true) return failure('UNKNOWN_OPTION', 'Unknown option.', name);
    if (seen.has(name)) return failure('DUPLICATE_OPTION', 'Option supplied more than once.', name);
    const read = inline ?? args[index + 1];
    if (read === undefined || read.length === 0 || (inline === undefined && read.startsWith('-') && read !== '-')) return failure('MISSING_VALUE', 'Option requires a value.', name);
    if (inline === undefined) index += 1;
    seen.add(name);
    if (name === '--fix') {
      if (!FIX_SELECTION.test(read) || /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(read)) return failure('INVALID_VALUE', 'Fix selection is invalid.', name);
      selected.fix = read; continue;
    }
    const path = fixPathValue(name, read);
    if (typeof path !== 'string') return path;
    selected[name === '--root' ? 'root' : name === '--input' ? 'input' : name === '--mapping' ? 'mapping' : 'endpointReceipt'] = path;
  }
  if (selected.root === undefined) return failure('UNEXPECTED_ARGUMENT', 'fix requires exactly one --root.');
  if (selected.input === undefined) return failure('UNEXPECTED_ARGUMENT', 'fix requires exactly one --input.');
  if (action === 'apply' && selected.fix === undefined) return failure('UNEXPECTED_ARGUMENT', 'fix apply requires one selected fix.');
  if (action === 'apply' && !confirm) return failure('UNEXPECTED_ARGUMENT', 'fix apply requires --confirm.', '--confirm');
  return success({
    kind: 'fix', schema: 'v2', action, format: 'json', root: selected.root, input: selected.input,
    ...(selected.fix === undefined ? {} : { fix: selected.fix }),
    ...(selected.mapping === undefined ? {} : { mapping: selected.mapping }),
    ...(selected.endpointReceipt === undefined ? {} : { endpointReceipt: selected.endpointReceipt }),
    confirm,
  });
}

function parseMetadata(kind: Exclude<CliCommandV2['kind'], 'scan' | 'help' | 'fix'>, args: readonly string[]): CliParseResultV2 {
  if (args.length === 1 && args[0] === '--help') return success({ kind: 'help', schema: 'v2', command: kind });
  let format: 'json' | 'table' = 'json';
  const rest: string[] = [];
  let seen = false;
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]!;
    if (token.startsWith('-')) {
      const [name, inline] = splitOption(token);
      if (name !== '--format' || seen) return failure(seen ? 'DUPLICATE_OPTION' : 'UNKNOWN_OPTION', seen ? 'Option supplied more than once.' : 'Unknown option.', name);
      const value = inline ?? args[++index];
      if (!value) return failure('MISSING_VALUE', 'Option requires a value.', name);
      if (value !== 'json' && value !== 'table') return failure('INVALID_VALUE', 'Format is invalid.', name);
      format = value;
      seen = true;
    } else rest.push(token);
  }
  if (kind === 'rules' || kind === 'profiles' || kind === 'version') {
    if (rest.length > 0) return failure('UNEXPECTED_ARGUMENT', 'Command does not accept positional arguments.');
    return success({ kind, schema: 'v2', format });
  }
  if (kind === 'explain') return rest.length === 1 && safeText(rest[0]!) ? success({ kind, schema: 'v2', format, ruleId: rest[0]! }) : failure('UNEXPECTED_ARGUMENT', 'explain requires one rule ID.');
  if (rest.length !== 1 || !isAdmittedRelativePath(rest[0]!)) return failure('UNEXPECTED_ARGUMENT', 'validate-config requires one local file.');
  return success({ kind, schema: 'v2', format, path: rest[0]! });
}
function assign(value: Record<string, unknown>, name: string, read: string): void { const fields: Record<string, string> = { '--format': 'format', '--profile': 'profile', '--fail-on': 'failOn', '--max-concurrency': 'concurrency', '--concurrency': 'concurrency', '--timeout': 'timeoutMs', '--output': 'output', '--config': 'configPath', '--rules': 'rules', '--catalogue': 'catalogue', '--limits': 'limits', '--target': 'target', '--n8n-version': 'n8nVersion', '--edition': 'edition', '--deployment': 'deployment', '--role': 'role', '--task-runner': 'taskRunner' }; value[fields[name]!] = ['--max-concurrency', '--concurrency', '--timeout'].includes(name) ? Number(read) : read; }
function splitOption(token: string): [string, string | undefined] { const at = token.indexOf('='); return at < 0 ? [token, undefined] : [token.slice(0, at), token.slice(at + 1)]; }
function positiveInteger(value: string, maximum: number): boolean { if (!/^\d+$/.test(value)) return false; const number = Number(value); return Number.isSafeInteger(number) && number > 0 && number <= maximum; }
function safeText(value: string): boolean { return value.length > 0 && value.length <= 4096 && !/[\u0000-\u001f\u007f]/.test(value) && !/^(?:[a-z][a-z\d+.-]*:|\/|[a-z]:|\\\\)/i.test(value); }
function hasSchemaMarker(argv: readonly string[]): boolean { for (const token of argv) { if (token === '--') break; if (token === '--schema' || token.startsWith('--schema=')) return true; } return false; }
function stripSchema(argv: readonly string[]): { ok: true; args: readonly string[] } | { ok: false; result: CliParseResultV2 } { const args: string[] = []; let seen = false; for (let index = 0; index < argv.length; index += 1) { const token = argv[index]!; if (token === '--') { args.push(...argv.slice(index)); break; } if (token === '--schema') { if (seen || argv[index + 1] !== 'v2') return { ok: false, result: failure(seen ? 'DUPLICATE_OPTION' : 'INVALID_VALUE', seen ? 'Option supplied more than once.' : 'Schema must be v2.', '--schema') }; seen = true; index += 1; continue; } if (token.startsWith('--schema=')) { if (seen || token.slice(9) !== 'v2') return { ok: false, result: failure(seen ? 'DUPLICATE_OPTION' : 'INVALID_VALUE', seen ? 'Option supplied more than once.' : 'Schema must be v2.', '--schema') }; seen = true; continue; } args.push(token); } return { ok: true, args }; }
function success(command: ParsedCommandV2): CliParseResultV2 { return freeze({ ok: true as const, command }); }
function failure(code: CliParseErrorCodeV2, message: string, argument?: string): CliParseResultV2 { const safe = argument !== undefined && /^--[A-Za-z0-9][A-Za-z0-9-]{0,63}$/.test(argument) ? argument : undefined; return freeze({ ok: false as const, error: { code, message, ...(safe === undefined ? {} : { argument: safe }) } }); }
function freeze<T>(value: T, seen = new WeakSet<object>()): T { if (value && typeof value === 'object') { if (seen.has(value as object)) return value; seen.add(value as object); for (const name of Object.getOwnPropertyNames(value as object)) freeze((value as Record<string, unknown>)[name], seen); Object.freeze(value); } return value; }
