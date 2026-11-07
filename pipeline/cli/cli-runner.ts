import path from 'node:path';
import * as nodeFs from 'node:fs/promises';
import { compareCanonicalStrings } from '@hub/contracts/stable-order';
import {
  CLI_EXIT_CODES,
  CLI_MAX_CONCURRENCY_LIMIT,
  parseCliArguments,
  resolveScanExitCode,
  type CliExitCode,
  type FailSeverity,
  type ScanCommand,
} from './cli-contract.js';
import { CLI_VERSION_DOCUMENT, explainCliRule, renderExplanation, renderHelp, renderRules } from './cli-metadata.js';
import {
  collectCliSources,
  type CliSource,
  type CliStdin,
} from './cli-inputs.js';
import { scanJson, type CliScanOutcome, type CliScanResult } from './scan-core.js';
import { scanJsonWithIsolation, type IsolatedCliScanOutcome } from './scan-isolation.js';
import { formatScanOutput } from './cli-output.js';
import { CLI_ABORTED, readCliSourceWithCancellation } from './cli-process.js';

export type CliJsonItem =
  | { input: string; ok: true; result: CliScanResult }
  | { input: string; ok: false; error: { kind: 'input' | 'internal' | 'cancelled'; code: string; message: string } };

export type CliJsonDocument = {
  schemaVersion: 'scanner-cli-v1';
  results: CliJsonItem[];
  summary: { total: number; completed: number; inputErrors: number; internalErrors: number; cancelled: number; findings: number };
};

export type CliRunResult = { exitCode: CliExitCode; stdout: string; stderr: string; document?: CliJsonDocument };

export type CliRunnerOptions = {
  cwd?: string;
  stdin?: CliStdin;
  signal?: AbortSignal;
};

const SEVERITY_ORDER: readonly FailSeverity[] = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO'];

export async function runCli(argv: readonly string[], options: CliRunnerOptions = {}): Promise<CliRunResult> {
  const parsed = parseCliArguments(argv);
  if (!parsed.ok) return usage(parsed.error.message);
  if (parsed.command.kind === 'help') return { exitCode: CLI_EXIT_CODES.SUCCESS, stdout: renderHelp(parsed.command.topic), stderr: '' };
  if (parsed.command.kind === 'rules') return { exitCode: CLI_EXIT_CODES.SUCCESS, stdout: renderRules(), stderr: '' };
  if (parsed.command.kind === 'version') return { exitCode: CLI_EXIT_CODES.SUCCESS, stdout: `${parsed.command.json ? JSON.stringify(CLI_VERSION_DOCUMENT, null, 2) : 'n8n-scan 0.1.0'}\n`, stderr: '' };
  if (parsed.command.kind === 'explain') {
    const rule = explainCliRule(parsed.command.policyId);
    return rule
      ? { exitCode: CLI_EXIT_CODES.SUCCESS, stdout: renderExplanation(rule), stderr: '' }
      : usage(`Unknown policy ID: ${parsed.command.policyId}`);
  }

  const cwd = path.resolve(options.cwd ?? process.cwd());
  const sources = await collectCliSources(parsed.command.inputs, cwd, {
    include: parsed.command.include, exclude: parsed.command.exclude,
  });
  const collision = await outputCollision(parsed.command, sources, cwd);
  if (collision) return usage(collision);
  const scanned = await scanInputs(sources, parsed.command, options.stdin, options.signal);
  const results = scanned
    .sort((left, right) => compareCanonicalStrings(left.input, right.input));
  const document = makeDocument(results);
  const output = formatScanOutput(document, parsed.command.format, {
    color: parsed.command.format === 'table' && !parsed.command.noColor && !parsed.command.output && Boolean(process.stdout.isTTY),
  });
  if (hasCancellation(results) || options.signal?.aborted) {
    return {
      exitCode: CLI_EXIT_CODES.CANCELLED,
      stdout: parsed.command.output && parsed.command.output !== '-' ? '' : output,
      stderr: parsed.command.output && parsed.command.output !== '-'
        ? 'Scan cancelled; output was not replaced.\n' : '',
      document,
    };
  }

  if (parsed.command.output && parsed.command.output !== '-') {
    try { await writeAtomically(path.resolve(cwd, parsed.command.output), output); }
    catch { return { exitCode: CLI_EXIT_CODES.INTERNAL, stdout: '', stderr: 'Could not write the output file.\n', document }; }
    return { exitCode: exitCodeFor(results, parsed.command), stdout: '', stderr: '', document };
  }
  return { exitCode: exitCodeFor(results, parsed.command), stdout: output, stderr: '', document };
}

async function scanInputs(sources: CliSource[], command: ScanCommand, stdinInput?: CliStdin, signal?: AbortSignal): Promise<CliJsonItem[]> {
  const results = new Array<CliJsonItem>(sources.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < sources.length) {
      const index = next++;
      results[index] = await scanSource(sources[index]!, command, stdinInput, signal);
    }
  };
  const concurrency = Math.min(Math.max(1, command.maxConcurrency ?? 4), CLI_MAX_CONCURRENCY_LIMIT, Math.max(1, sources.length));
  await Promise.all(Array.from({ length: concurrency }, worker));
  return results;
}

async function scanSource(source: CliSource, command: ScanCommand, stdinInput?: CliStdin, signal?: AbortSignal): Promise<CliJsonItem> {
  if (signal?.aborted) return failureItem(source.input, 'cancelled', 'CANCELLED', 'Scan was cancelled; worker terminated.');
  if (source.kind === 'error') return failureItem(source.input, source.error.kind, source.error.code, source.error.message);
  const read = await readCliSourceWithCancellation(source, stdinInput, signal);
  if (read === CLI_ABORTED) return failureItem(source.input, 'cancelled', 'CANCELLED', 'Scan was cancelled; worker terminated.');
  if (!read.ok) return failureItem(source.input, read.error.kind, read.error.code, read.error.message);
  if (signal?.aborted) return failureItem(source.input, 'cancelled', 'CANCELLED', 'Scan was cancelled; worker terminated.');
  const json = read.text.charCodeAt(0) === 0xfeff ? read.text.slice(1) : read.text;
  const coreOptions = { profile: command.profile, approvedDomains: command.approvedDomains };
  const outcome = command.timeoutMs !== undefined || signal
    ? await scanJsonWithIsolation(json, coreOptions, { timeoutMs: command.timeoutMs, signal })
    : scanJson(json, coreOptions);
  return outcomeItem(source.input, outcome);
}

function outcomeItem(input: string, outcome: CliScanOutcome | IsolatedCliScanOutcome): CliJsonItem {
  return outcome.ok ? { input, ok: true, result: outcome.result } : failureItem(input, outcome.kind, outcome.code, outcome.message);
}

function failureItem(input: string, kind: 'input' | 'internal' | 'cancelled', code: string, message: string): CliJsonItem {
  return { input, ok: false, error: { kind, code, message } };
}

function makeDocument(results: CliJsonItem[]): CliJsonDocument {
  return {
    schemaVersion: 'scanner-cli-v1', results,
    summary: {
      total: results.length,
      completed: results.filter((item) => item.ok).length,
      inputErrors: results.filter((item) => !item.ok && item.error.kind === 'input').length,
      internalErrors: results.filter((item) => !item.ok && item.error.kind === 'internal').length,
      cancelled: results.filter((item) => !item.ok && item.error.kind === 'cancelled').length,
      findings: results.reduce((count, item) => count + (item.ok ? item.result.findings.length : 0), 0),
    },
  };
}

function exitCodeFor(results: CliJsonItem[], command: ScanCommand): CliExitCode {
  const indeterminate = results.some((item) => item.ok && item.result.analysisStatus === 'INDETERMINATE');
  return resolveScanExitCode({
    inputError: results.some((item) => !item.ok && item.error.kind === 'input'),
    internalError: results.some((item) => !item.ok && item.error.kind === 'internal'),
    cancelled: results.some((item) => !item.ok && item.error.kind === 'cancelled'),
    indeterminate,
    finding: results.some((item) => item.ok && hasFindingAtThreshold(item.result.findings, command.failOn)) ||
      (command.failOn === 'indeterminate' && indeterminate),
  });
}

function hasCancellation(results: CliJsonItem[]): boolean {
  return results.some((item) => !item.ok && item.error.kind === 'cancelled');
}

function hasFindingAtThreshold(findings: readonly { severity: string }[], threshold: ScanCommand['failOn']): boolean {
  if (!threshold || threshold === 'indeterminate') return false;
  const limit = SEVERITY_ORDER.indexOf(threshold);
  return findings.some((finding) => SEVERITY_ORDER.indexOf(finding.severity as FailSeverity) >= 0 && SEVERITY_ORDER.indexOf(finding.severity as FailSeverity) <= limit);
}

async function outputCollision(command: ScanCommand, sources: CliSource[], cwd: string): Promise<string | undefined> {
  if (!command.output || command.output === '-') return undefined;
  const target = path.resolve(cwd, command.output);
  if (sources.some((source) => source.kind === 'file' && comparablePath(source.absolutePath) === comparablePath(target))) {
    return 'Output path must not overwrite an input workflow.';
  }
  try {
    const stats = await nodeFs.lstat(target);
    if (!stats.isFile()) return 'Output path must be a regular file, not a directory or special path.';
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') return 'Output path could not be inspected.';
  }
  return undefined;
}

function comparablePath(value: string): string {
  const normalized = path.normalize(value).replaceAll('\\', '/');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object' || !('code' in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

async function writeAtomically(target: string, content: string): Promise<void> {
  const temporary = `${target}.tmp-${process.pid}`;
  try {
    await nodeFs.writeFile(temporary, content, { encoding: 'utf8', flag: 'wx' });
    await nodeFs.rename(temporary, target);
  } catch (error) {
    try { await nodeFs.unlink(temporary); } catch { /* preserve the original write/rename error */ }
    throw error;
  }
}

function usage(message: string): CliRunResult {
  return { exitCode: CLI_EXIT_CODES.USAGE, stdout: '', stderr: `${message}\n` };
}
