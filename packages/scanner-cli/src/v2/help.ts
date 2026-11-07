import { ADMITTED_LIMIT_STATES, DEFAULT_SCANNER_LIMITS_V2, MEASURED_LIMIT_IDS } from '@hub/contracts';

export const V2_COMMANDS = Object.freeze([
  'scan', 'fix', 'rules', 'explain', 'profiles', 'validate-config', 'version',
] as const);
export type V2CommandName = (typeof V2_COMMANDS)[number];

export type V2OptionName =
  | '--help' | '--schema' | '--format' | '--profile' | '--fail-on' | '--require-complete' | '--audit-supply-chain' | '--include-readiness'
  | '--max-concurrency' | '--concurrency' | '--timeout' | '--output' | '--config'
  | '--rules' | '--catalogue' | '--limits' | '--target' | '--n8n-version' | '--edition'
  | '--deployment' | '--role' | '--task-runner' | '--community-package' | '--configuration'
  | '--approved-domain' | '--include' | '--exclude' | '--allow-unsigned-development-rules' | '--no-color'
  | '--root' | '--input' | '--fix' | '--mapping' | '--endpoint-receipt' | '--confirm';

export type V2HelpOption = Readonly<{
  name: V2OptionName;
  value: string;
  commands: readonly V2CommandName[];
  description: string;
  default?: string;
}>;

const SCAN = Object.freeze(['scan'] as const);
const ALL = Object.freeze(['scan', 'rules', 'explain', 'profiles', 'validate-config', 'version'] as const);
const FIX = Object.freeze(['fix'] as const);
const EVERY = V2_COMMANDS;

export const V2_OPTIONS: readonly V2HelpOption[] = Object.freeze([
  { name: '--help', value: '', commands: ALL, description: 'Show deterministic help for the selected v2 command.' },
  { name: '--schema', value: '<v2>', commands: EVERY, description: 'Select the versioned v2 grammar.' },
  { name: '--format', value: '<json|ndjson|sarif|table>', commands: ALL, description: 'Select the output format.', default: 'json for scan; json for metadata' },
  { name: '--profile', value: '<beta-default>', commands: SCAN, description: 'Select the admitted analysis profile.', default: 'beta-default' },
  { name: '--fail-on', value: '<CRITICAL|HIGH|MEDIUM|LOW|INFO>', commands: SCAN, description: 'Fail when a finding meets or exceeds this severity.', default: 'INFO' },
  { name: '--require-complete', value: '', commands: SCAN, description: 'Treat DEGRADED analysis as a failure.', default: 'false' },
  { name: '--audit-supply-chain', value: '', commands: SCAN, description: 'Emit canonical advisory status and request metadata; no admitted snapshot is available and no network is used.', default: 'false' },
  { name: '--include-readiness', value: '', commands: SCAN, description: 'Include preflight readiness assessment in json, ndjson, or table output.', default: 'false' },
  { name: '--max-concurrency', value: '<1..16>', commands: SCAN, description: 'Bound concurrent inputs; --concurrency is an equivalent spelling.', default: '1' },
  { name: '--concurrency', value: '<1..16>', commands: SCAN, description: 'Bound concurrent inputs; --max-concurrency is an equivalent spelling.', default: '1' },
  { name: '--timeout', value: '<1..2147483647>', commands: SCAN, description: 'Set the per-input timeout in milliseconds.', default: '30000 (workerDeadlineMs)' },
  { name: '--output', value: '<local-file|->', commands: SCAN, description: 'Write to a local file atomically, or use - for stdout.', default: 'stdout' },
  { name: '--config', value: '<local-file>', commands: SCAN, description: 'Load one explicit versioned config file.' },
  { name: '--rules', value: '<builtin>', commands: SCAN, description: 'Select the embedded built-in ruleset; the only admitted authority.', default: 'builtin' },
  { name: '--catalogue', value: '<builtin>', commands: SCAN, description: 'Select the embedded semantic catalogue.', default: 'builtin' },
  { name: '--limits', value: '<local-file|builtin>', commands: SCAN, description: 'Select embedded or local scanner limits.', default: 'builtin' },
  { name: '--target', value: '<local-file>', commands: SCAN, description: 'Load a local target context.' },
  { name: '--n8n-version', value: '<semver>', commands: SCAN, description: 'Set the n8n version fact.' },
  { name: '--edition', value: '<COMMUNITY|ENTERPRISE|CLOUD|UNKNOWN>', commands: SCAN, description: 'Set the deployment edition fact.', default: 'UNKNOWN' },
  { name: '--deployment', value: '<SELF_HOSTED|CLOUD|UNKNOWN>', commands: SCAN, description: 'Set the deployment fact.', default: 'UNKNOWN' },
  { name: '--role', value: '<OWNER|ADMIN|MEMBER|UNKNOWN>', commands: SCAN, description: 'Set the operator role fact.', default: 'UNKNOWN' },
  { name: '--task-runner', value: '<LEGACY|NATIVE|UNKNOWN>', commands: SCAN, description: 'Set the task-runner fact.', default: 'UNKNOWN' },
  { name: '--community-package', value: '<package>', commands: SCAN, description: 'Record a community package in target context; repeatable.' },
  { name: '--configuration', value: '<name>', commands: SCAN, description: 'Record a configuration fact; repeatable.' },
  { name: '--approved-domain', value: '<host>', commands: SCAN, description: 'Treat this hostname as approved for UNAPPROVED_DOMAIN; repeatable.' },
  { name: '--include', value: '<posix-glob>', commands: SCAN, description: 'Replace config includes with a case-sensitive POSIX glob; repeatable.', default: '**/*.json' },
  { name: '--exclude', value: '<posix-glob>', commands: SCAN, description: 'Replace config excludes with a case-sensitive POSIX glob; repeatable.', default: '.git/**, node_modules/**' },
  { name: '--allow-unsigned-development-rules', value: '', commands: SCAN, description: 'Refused: external rule packs are not admitted, so no pack can be selected.', default: 'false' },
  { name: '--no-color', value: '', commands: SCAN, description: 'Disable color in human output.', default: 'false (also disabled for non-TTY)' },
  { name: '--root', value: '<absolute-local-dir>', commands: FIX, description: 'Absolute local directory holding the workflow and receipts.' },
  { name: '--input', value: '<relative-file>', commands: FIX, description: 'Root-relative workflow file; standard input cannot be re-read.' },
  { name: '--fix', value: '<fix-id>', commands: FIX, description: 'Select one reviewed fix; apply requires exactly one.' },
  { name: '--mapping', value: '<relative-file>', commands: FIX, description: 'Root-relative credential-mapping receipt.' },
  { name: '--endpoint-receipt', value: '<relative-file>', commands: FIX, description: 'Root-relative endpoint-compatibility receipt.' },
  { name: '--confirm', value: '', commands: FIX, description: 'Explicit confirmation; required for apply and refused for suggest.', default: 'false' },
]);

/**
 * The published limit vocabulary, restated because a shipped declaration must not name the private,
 * unpublished contracts workspace: a strict NodeNext consumer of the packed package fails `TS2307`
 * on that import. The values below still come from the contract, and the two vocabularies stay
 * exhaustive against each other at compile time.
 */
export type V2LimitName =
  | 'maxBytes' | 'maxNodes' | 'maxEdges' | 'maxConnectionDepth' | 'maxParameterDepth' | 'maxParameterLeaves'
  | 'workerDeadlineMs' | 'maxSyntaxNodes' | 'maxDocumentDepth' | 'maxMembersAndElements' | 'maxRawEdges'
  | 'maxDuplicateKeys' | 'maxDiagnostics' | 'maxStoredSourceSpans' | 'maxSourceWork' | 'maxExpressionTokens'
  | 'maxCodeSyntaxNodes' | 'maxGraphOperations' | 'maxTaintStates' | 'maxTraceStepsPerFinding' | 'maxFindings'
  | 'maxRedactionPatches' | 'maxRedactedArtifactBytes' | 'maxEvidenceBytes' | 'maxSerializedResultBytes'
  | 'maxRuleOperations';

export const V2_LIMITS: Readonly<Record<V2LimitName, number>> = Object.freeze({
  maxBytes: DEFAULT_SCANNER_LIMITS_V2.maxBytes,
  maxNodes: DEFAULT_SCANNER_LIMITS_V2.maxNodes,
  maxEdges: DEFAULT_SCANNER_LIMITS_V2.maxEdges,
  maxConnectionDepth: DEFAULT_SCANNER_LIMITS_V2.maxConnectionDepth,
  maxParameterDepth: DEFAULT_SCANNER_LIMITS_V2.maxParameterDepth,
  maxParameterLeaves: DEFAULT_SCANNER_LIMITS_V2.maxParameterLeaves,
  workerDeadlineMs: DEFAULT_SCANNER_LIMITS_V2.workerDeadlineMs,
  maxSyntaxNodes: DEFAULT_SCANNER_LIMITS_V2.maxSyntaxNodes,
  maxDocumentDepth: DEFAULT_SCANNER_LIMITS_V2.maxDocumentDepth,
  maxMembersAndElements: DEFAULT_SCANNER_LIMITS_V2.maxMembersAndElements,
  maxRawEdges: DEFAULT_SCANNER_LIMITS_V2.maxRawEdges,
  maxDuplicateKeys: DEFAULT_SCANNER_LIMITS_V2.maxDuplicateKeys,
  maxDiagnostics: DEFAULT_SCANNER_LIMITS_V2.maxDiagnostics,
  maxStoredSourceSpans: DEFAULT_SCANNER_LIMITS_V2.maxStoredSourceSpans,
  maxSourceWork: DEFAULT_SCANNER_LIMITS_V2.maxSourceWork,
  maxExpressionTokens: DEFAULT_SCANNER_LIMITS_V2.maxExpressionTokens,
  maxCodeSyntaxNodes: DEFAULT_SCANNER_LIMITS_V2.maxCodeSyntaxNodes,
  maxGraphOperations: DEFAULT_SCANNER_LIMITS_V2.maxGraphOperations,
  maxTaintStates: DEFAULT_SCANNER_LIMITS_V2.maxTaintStates,
  maxTraceStepsPerFinding: DEFAULT_SCANNER_LIMITS_V2.maxTraceStepsPerFinding,
  maxFindings: DEFAULT_SCANNER_LIMITS_V2.maxFindings,
  maxRedactionPatches: DEFAULT_SCANNER_LIMITS_V2.maxRedactionPatches,
  maxRedactedArtifactBytes: DEFAULT_SCANNER_LIMITS_V2.maxRedactedArtifactBytes,
  maxEvidenceBytes: DEFAULT_SCANNER_LIMITS_V2.maxEvidenceBytes,
  maxSerializedResultBytes: DEFAULT_SCANNER_LIMITS_V2.maxSerializedResultBytes,
  maxRuleOperations: DEFAULT_SCANNER_LIMITS_V2.maxRuleOperations,
});

/**
 * Type-only parity guard: every limit the contract gains must be published here. `Exclude` is
 * `never` while the two vocabularies agree, and the type-parameter default stops satisfying its
 * constraint the moment they diverge. Erased at emit, so it costs no runtime lookup and never
 * reaches `help.d.ts`; the reverse direction is enforced by indexing `ADMITTED_LIMIT_STATES`.
 */
type AssertEveryContractLimitIsPublished<Gap extends never = Exclude<keyof typeof ADMITTED_LIMIT_STATES, V2LimitName>> = Gap;

/** The help marker for one budget, derived from the contract authority rather than a copy. */
function limitStateMarker(name: V2LimitName): string {
  const state = ADMITTED_LIMIT_STATES[name];
  if (state === 'WIRED') {
    return MEASURED_LIMIT_IDS.some((id) => id === name) ? ' (enforced; usage row)' : ' (enforced; no usage row)';
  }
  return state === 'DORMANT' ? ' (dormant in beta-default; hardened-only)' : ' (development-only, unwired)';
}

export const V2_EXIT_CODES = Object.freeze([0, 1, 2, 3, 4, 130] as const);
export type V2ExitCode = (typeof V2_EXIT_CODES)[number];
export const V2_EXIT_REASONS = Object.freeze([
  'CANCELLED', 'INTERNAL', 'USAGE', 'FINDING_THRESHOLD', 'REQUIRE_COMPLETE', 'ITEM_FAILURE', 'UNDER_THRESHOLD',
] as const);
export type V2ExitReason = (typeof V2_EXIT_REASONS)[number];

export const V2_CANONICAL_CLAIMS = Object.freeze([
  'v2 is offline and never initiates network requests (HTTP, DNS, sockets, telemetry, or remote imports).',
  'Labels and output identities never contain absolute paths or workflow source content.',
  'File output uses a same-directory temporary file and atomic replace; failures and cancellation preserve the prior file.',
  'beta-default@2.0.0 is admitted; beta-hardened@2.0.0 is defined but not admitted or selectable.',
  'No shipped path produces a redacted artifact: maxRedactionPatches and maxRedactedArtifactBytes bound redaction-v2, which is development-only and unwired.',
  'No shipped path admits an external rule pack: --rules and --catalogue accept only builtin, and --allow-unsigned-development-rules is refused because Ed25519 trust-store admission is deferred.',
  'Published on npm as sfscanner.',
] as const);

export type V2CommandHelp = Readonly<{ command: V2CommandName; usage: readonly string[]; text: string }>;

function optionLine(option: V2HelpOption, command?: V2CommandName): string {
  const value = option.name === '--format' && command !== undefined && command !== 'scan' ? '<json|table>' : option.value;
  const syntax = value ? ` ${value}` : '';
  const defaultText = option.default ? ` Default: ${option.default}.` : '';
  return `  ${option.name}${syntax}  ${option.description}${defaultText}`;
}
function renderCommand(command: V2CommandName): V2CommandHelp {
  const usage = command === 'scan'
    ? [`sfscanner --schema v2 scan <file|directory|-> [options]`]
    : command === 'explain'
      ? [`sfscanner --schema v2 explain <rule-id> [--format json|table]`]
      : command === 'validate-config'
        ? [`sfscanner --schema v2 validate-config <local-file> [--format json|table]`]
        : command === 'fix'
          ? [
              'sfscanner --schema v2 fix suggest --root <absolute-local-dir> --input <relative-file> [options]',
              'sfscanner --schema v2 fix apply --root <absolute-local-dir> --input <relative-file> --fix <fix-id> --confirm [options]',
            ]
          : [`sfscanner --schema v2 ${command} [--format json|table]`];
  const options = V2_OPTIONS.filter((option) => option.commands.includes(command));
  const lines = [`sfscanner v2 ${command}`, '', 'Usage:', ...usage, '', 'Options:', ...options.map((option) => optionLine(option, command))];
  if (command === 'scan') lines.push('', 'Inputs are sorted by normalized relative label; stdin (-) cannot join a batch.');
  if (command === 'profiles') lines.push('', 'beta-default is admitted. beta-hardened is defined but not admitted or selectable.');
  if (command === 'validate-config') lines.push('', 'Only the explicitly supplied local config file is read.');
  if (command === 'fix') lines.push('',
    'Output is one JSON n8n-scan-fix-v2 document; --format and --help are not admitted for fix.',
    'Without a conditional-replace host, apply returns HOST_UNSUPPORTED (NO_CONDITIONAL_REPLACE) before any write; the READY plan remains in the document.',
    'Exit codes: 0 READY or WRITTEN; 2 USAGE; 3 FAILED, REFUSED, NO_SUGGESTION or HOST_UNSUPPORTED; 130 CANCELLED.');
  return Object.freeze({ command, usage: Object.freeze(usage), text: `${lines.join('\n')}\n` });
}

export const COMMAND_HELP_V2: Readonly<Record<V2CommandName, string>> = Object.freeze(
  Object.fromEntries(V2_COMMANDS.map((command) => [command, renderCommand(command).text])) as Record<V2CommandName, string>,
);

const generalLines = [
  'sfscanner — deterministic offline n8n workflow scanner (v2)', '', 'Usage:',
  '  sfscanner --schema v2 scan <file|directory|-> [options]',
  '  sfscanner --schema v2 fix suggest|apply [options]',
  '  sfscanner --schema v2 rules [--format json|table]',
  '  sfscanner --schema v2 explain <rule-id> [--format json|table]',
  '  sfscanner --schema v2 profiles [--format json|table]',
  '  sfscanner --schema v2 validate-config <local-file> [--format json|table]',
  '  sfscanner --schema v2 version [--format json|table]', '', 'Commands:',
  'Defaults:', '  format: json; profile: beta-default; fail-on: INFO; require-complete: false; concurrency: 1 (maximum 16); timeout: 30000ms.',
  '  include: **/*.json; exclude: .git/**, node_modules/**; rules/catalogue/limits: builtin.',
  '  target facts: edition UNKNOWN; deployment UNKNOWN; role UNKNOWN; task-runner UNKNOWN.',
  '', 'Profiles:', '  beta-default@2.0.0: admitted and selectable.',
  '  beta-hardened@2.0.0: defined but not admitted or selectable.', '', 'Limits:',
  ...Object.entries(V2_LIMITS).map(([name, value]) => `  ${name}=${value}${limitStateMarker(name as V2LimitName)}`), '',
  'Exit codes and precedence:', '  130 CANCELLED; 4 INTERNAL; 2 USAGE; 1 FINDING_THRESHOLD or REQUIRE_COMPLETE; 3 ITEM_FAILURE; 0 UNDER_THRESHOLD.',
  '  Pre-scan usage/configuration/admission failures emit no machine envelope and exit 2; stdout cancellation emits a valid envelope and exits 130.',
  '  When finding threshold and require-complete both fire, FINDING_THRESHOLD wins. Indeterminate never exits 0.', '',
  ...V2_CANONICAL_CLAIMS,
];
export const GENERAL_HELP_V2 = `${generalLines.join('\n')}\n`;
export const HELP_TEXT_V2 = GENERAL_HELP_V2;

export function getHelpV2(command?: V2CommandName): string {
  return command === undefined ? GENERAL_HELP_V2 : COMMAND_HELP_V2[command];
}
