import { HELP_TEXT } from './help.js';
import { readWorkflowInput, type CliStdin } from './input.js';
import {
  CLI_SCHEMA_VERSION,
  scanText,
  versionDocument,
  type ScanDocument,
} from './scan.js';
import { toSarifDocument } from './sarif.js';
import { SCANNER_VERSION } from '@hub/scanner-core/scanner-version';

const CLI_FORMATS = ['json', 'sarif'] as const;
type CliFormat = (typeof CLI_FORMATS)[number];

export type CliRunResult = {
  exitCode: 0 | 1 | 2 | 3 | 4;
  stdout: string;
  stderr: string;
};

export type CliRunOptions = { stdin?: CliStdin };

export async function runCli(argv: readonly string[], options: CliRunOptions = {}): Promise<CliRunResult> {
  const command = parseArguments(argv);
  if (command.kind === 'help') return { exitCode: 0, stdout: HELP_TEXT, stderr: '' };
  if (command.kind === 'version') {
    const output = command.json ? formatJson(versionDocument()) : `sfscanner 0.1.0 (${SCANNER_VERSION})\n`;
    return { exitCode: 0, stdout: output, stderr: '' };
  }
  if (command.kind === 'usage') return { exitCode: 2, stdout: '', stderr: `${command.message}\n\n${HELP_TEXT}` };

  let workflowJson: string;
  try {
    workflowJson = await readWorkflowInput(command.input, options.stdin);
  } catch (error) {
    const tooLarge = error instanceof RangeError && error.message === 'OVERSIZED';
    return {
      exitCode: 3,
      stdout: formatOutput(inputError(command.input, tooLarge ? 'WORKFLOW_TOO_LARGE' : 'INPUT_READ_FAILED'), command.format),
      stderr: '',
    };
  }

  const document = scanText(command.input, workflowJson);
  return {
    exitCode: exitCodeFor(document),
    stdout: formatOutput(document, command.format),
    stderr: '',
  };
}

type ParsedCommand =
  | { kind: 'help' }
  | { kind: 'version'; json: boolean }
  | { kind: 'scan'; input: string; format: CliFormat }
  | { kind: 'usage'; message: string };

function parseArguments(argv: readonly string[]): ParsedCommand {
  if (argv.length === 1 && argv[0] === '--help') return { kind: 'help' };
  if (argv[0] === '--version') {
    if (argv.length === 1) return { kind: 'version', json: false };
    if (argv.length === 2 && argv[1] === '--json') return { kind: 'version', json: true };
    return { kind: 'usage', message: 'Usage: sfscanner --version [--json]' };
  }

  const afterCommand = argv[0] === 'scan' ? argv.slice(1) : argv;
  const extracted = extractFormat(afterCommand);
  if ('error' in extracted) return { kind: 'usage', message: extracted.error };
  const { rest: inputs, format } = extracted;
  if (inputs.length !== 1 || !inputs[0] || inputs[0].startsWith('-') && inputs[0] !== '-') {
    return { kind: 'usage', message: 'Exactly one workflow input is required. Use a file path or - for stdin.' };
  }
  if (inputs[0] === '--help') return { kind: 'help' };
  return { kind: 'scan', input: inputs[0], format };
}

/**
 * Pulls `--format <json|sarif>` out of the input arguments wherever it
 * appears (before or after the file/stdin token), so the single-input check
 * below never sees it and mistakes it for a second, ambiguous input.
 */
function extractFormat(args: readonly string[]): { rest: string[]; format: CliFormat } | { error: string } {
  const rest: string[] = [];
  let format: CliFormat = 'json';
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg !== '--format') {
      rest.push(arg);
      continue;
    }
    const value = args[index + 1];
    if (!value || !(CLI_FORMATS as readonly string[]).includes(value)) {
      return { error: `--format must be one of: ${CLI_FORMATS.join(', ')}` };
    }
    format = value as CliFormat;
    index += 1;
  }
  return { rest, format };
}

function formatOutput(document: ScanDocument, format: CliFormat): string {
  return format === 'sarif' ? formatJson(toSarifDocument(document)) : formatJson(document);
}

function exitCodeFor(document: ScanDocument): 0 | 1 | 3 {
  if (!document.ok) return 3;
  return document.findings.length > 0 ? 1 : 0;
}

function inputError(input: string, code: 'INPUT_READ_FAILED' | 'WORKFLOW_TOO_LARGE' = 'INPUT_READ_FAILED'): ScanDocument {
  return {
    schemaVersion: CLI_SCHEMA_VERSION,
    scannerVersion: SCANNER_VERSION,
    profile: 'beta-default',
    input,
    ok: false,
    error: {
      code,
      message: code === 'WORKFLOW_TOO_LARGE'
        ? 'Workflow exceeds maximum byte limit.'
        : 'Unable to read workflow input.',
    },
  };
}

function formatJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}
