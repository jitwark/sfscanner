import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const DOCS_FILE = 'docs/CLI.md';
const CONTRACT_FILE = 'pipeline/cli/cli-contract.ts';
const TSX_ENTRY = 'node_modules/tsx/dist/cli.mjs';
const V2_HELP_FILE = 'packages/scanner-cli/src/v2/help.ts', V2_ARGUMENTS_FILE = 'packages/scanner-cli/src/v2/arguments.ts', V2_EXIT_FILE = 'packages/scanner-cli/src/v2/exit-reducer.ts', V2_DOCS_FILE = 'docs/scanner/cli-v2.md';

function tokens(source, pattern) { return [...source.matchAll(pattern)].map((match) => match[1]); }
function uniqueSorted(values) { return [...new Set(values)].sort(); }
function sourceArray(source, name) { const block = source.match(new RegExp(`export const ${name}\\s*=\\s*Object\\.freeze\\(\\[([\\s\\S]*?)\\]\\s+as const\\)`))?.[1]; if (!block) throw new Error(`Unable to read ${name} from v2 help authority.`); return tokens(block, /'([^']+)'/g); }

function sourceNumbers(source, name) { const block = source.match(new RegExp(`export const ${name}\\s*=\\s*Object\\.freeze\\(\\[([\\s\\S]*?)\\]\\s+as const\\)`))?.[1]; if (!block) throw new Error(`Unable to read ${name} from v2 help authority.`); const values = [...block.matchAll(/\b(\d+)\b/g)].map((match) => Number(match[1])); if (values.length === 0) throw new Error(`${name} is empty.`); return values; }

function sourceOptions(source) { const block = source.match(/export const V2_OPTIONS:[\s\S]*?Object\.freeze\(\[([\s\S]*?)\]\);/)?.[1]; if (!block) throw new Error('Unable to read V2_OPTIONS from v2 help authority.'); const values = tokens(block, /name:\s*'(--[a-z][a-z0-9-]*)'/g); if (values.length === 0) throw new Error('V2_OPTIONS is empty.'); return values; }

function sourceLimits(source) { const block = source.match(/export const V2_LIMITS:[\s\S]*?Object\.freeze\(\{([\s\S]*?)\}\);/)?.[1]; if (!block) throw new Error('Unable to read V2_LIMITS from v2 help authority.'); const values = tokens(block, /^\s*([a-z][A-Za-z0-9]+):/gm); if (values.length === 0) throw new Error('V2_LIMITS is empty.'); return values; }

export function deriveV2CliSurface({ helpSource, argumentsSource, exitSource }) {
  if (typeof helpSource !== 'string' || typeof argumentsSource !== 'string' || typeof exitSource !== 'string') throw new Error('V2 help, argument, and exit sources are required.');
  const commands = sourceArray(helpSource, 'V2_COMMANDS'), options = sourceOptions(helpSource), exitCodes = sourceNumbers(helpSource, 'V2_EXIT_CODES');
  const exitReasons = sourceArray(helpSource, 'V2_EXIT_REASONS'), claims = sourceArray(helpSource, 'V2_CANONICAL_CLAIMS'), limits = sourceLimits(helpSource);
  const parserOptions = uniqueSorted(tokens(argumentsSource, /'(--[a-z][a-z0-9-]*)'/g).filter((option) => option !== '--version'));
  const parserCommands = tokens(argumentsSource.match(/const commands:[\s\S]*?Object\.freeze\(\{([\s\S]*?)\}\)/)?.[1] ?? '', /['"]?([a-z][a-z0-9-]*)['"]?\s*:\s*true/g);
  const reducerExitCodes = [...exitSource.matchAll(/code:\s*(\d+)/g)].map((match) => Number(match[1])), reducerReasons = tokens(exitSource.match(/const EXITS:[\s\S]*?Object\.freeze\(\{([\s\S]*?)\}\);/)?.[1] ?? '', /([A-Z][A-Z_]+):\s*Object\.freeze/g);
  if (JSON.stringify(commands) !== JSON.stringify([...new Set(parserCommands)])) throw new Error('V2 help commands do not match the parser.');
  if (JSON.stringify([...options].sort()) !== JSON.stringify([...new Set([...parserOptions, '--schema'])].sort())) throw new Error('V2 help options do not match the parser.');
  if (JSON.stringify([...exitCodes].sort((a, b) => a - b)) !== JSON.stringify([...new Set(reducerExitCodes)].sort((a, b) => a - b))) throw new Error('V2 help exit codes do not match the reducer.');
  if (JSON.stringify([...exitReasons].sort()) !== JSON.stringify([...new Set(reducerReasons)].sort())) throw new Error('V2 help exit reasons do not match the reducer.');
  return { commands, options, exitCodes, exitReasons, limits, claims };
}

function v2SurfaceBlock(docs) { return docs.match(/<!-- scanner-cli-v2:surface -->([\s\S]*?)<!-- \/scanner-cli-v2:surface -->/)?.[1]; }
function orderedTableValues(block, heading) { const section = block.match(new RegExp(`### ${heading}\\s*([\\s\\S]*?)(?=\\n### |$)`))?.[1] ?? ''; return tokens(section, /^\|\s*`([^`]+)`\s*\|/gm); }
export function parseDocumentedV2Surface(docs) {
  const block = v2SurfaceBlock(docs); if (!block) return undefined;
  return { commands: orderedTableValues(block, 'Commands'), options: orderedTableValues(block, 'Options'), exitCodes: orderedTableValues(block, 'Exit codes').map(Number) };
}
function compareExact(errors, label, expected, actual) {
  if (JSON.stringify(expected) === JSON.stringify(actual)) return;
  compareVocabulary(errors, label, expected, actual); compareUnsupported(errors, label, expected, actual);
  errors.push(`documentation ${label} order or duplication differs from v2 help authority`);
}

function parseExitCodes(contractSource) {
  const block = contractSource.match(/CLI_EXIT_CODES\s*=\s*Object\.freeze\(\{([\s\S]*?)\}\s+as const\)/)?.[1];
  if (!block) throw new Error('Unable to read CLI_EXIT_CODES from pipeline/cli/cli-contract.ts');
  return uniqueSorted(tokens(block, /^\s*[A-Z]+:\s*(\d+)/gm));
}

export function deriveCliSurface({ generalHelp, scanHelp, contractSource }) {
  return {
    commands: uniqueSorted(tokens(generalHelp, /^\s+n8n-scan\s+([a-z][a-z0-9-]*)/gim)),
    options: uniqueSorted(tokens(`${generalHelp}\n${scanHelp}`, /(--[a-z][a-z0-9-]*)/g)),
    exitCodes: parseExitCodes(contractSource),
  };
}

function surfaceBlock(docs) {
  return docs.match(/<!-- cli-docs:surface -->([\s\S]*?)<!-- \/cli-docs:surface -->/)?.[1];
}

function tableValues(block, heading) {
  const section = block.match(new RegExp(`### ${heading}\\s*([\\s\\S]*?)(?=\\n### |$)`))?.[1] ?? '';
  return uniqueSorted(tokens(section, /^\|\s*`([^`]+)`\s*\|/gm));
}

export function parseDocumentedSurface(docs) {
  const block = surfaceBlock(docs);
  if (!block) return undefined;
  return {
    commands: tableValues(block, 'Commands'),
    options: tableValues(block, 'Options'),
    exitCodes: tableValues(block, 'Exit codes'),
  };
}

function compareVocabulary(errors, label, expected, actual) {
  const expectedSet = new Set(expected);
  const actualSet = new Set(actual);
  for (const value of expected.filter((item) => !actualSet.has(item))) {
    errors.push(`documentation is missing supported ${label}: ${value}`);
  }
}

function compareUnsupported(errors, label, expected, actual) {
  const expectedSet = new Set(expected);
  for (const value of actual.filter((item) => !expectedSet.has(item))) {
    errors.push(`documentation has unsupported ${label}: ${value}`);
  }
}
export function auditV2CliDocs(input, errors = []) {
  const docs = input.v2Docs ?? input.docs;
  let expected;
  try {
    expected = deriveV2CliSurface({
      helpSource: input.v2HelpSource,
      argumentsSource: input.v2ArgumentsSource,
      exitSource: input.v2ExitSource,
    });
  } catch (error) {
    errors.push(`v2 help authority is invalid: ${error instanceof Error ? error.message : 'unknown error'}`);
    return { errors, expected: undefined, documented: undefined };
  }
  const documented = typeof docs === 'string' ? parseDocumentedV2Surface(docs) : undefined;
  if (!documented) {
    errors.push('v2 documentation is missing the scanner-cli-v2:surface block');
    return { errors, expected, documented };
  }
  compareExact(errors, 'command', expected.commands, documented.commands);
  compareExact(errors, 'option', expected.options, documented.options);
  compareExact(errors, 'exit code', expected.exitCodes, documented.exitCodes);
  const exitText = docs.match(/## Exit precedence and atomic output([\s\S]*?)(?=\n## |$)/)?.[1] ?? '';
  const claimed = {
    commands: [...new Set([...documented.commands, ...tokens(docs, /\bn8n-scan\s+(?:--schema\s+v2\s+)?([a-z][a-z0-9-]*)/gm)])],
    options: [...new Set([...documented.options, ...tokens([...docs.matchAll(/\bn8n-scan\b[^\r\n]*/g)].map(([line]) => line).join('\n'), /(--[a-z][a-z0-9-]*)/g)])],
    exitCodes: [...new Set([...documented.exitCodes, ...tokens(exitText, /\b(\d{1,3})\b/g).map(Number)])],
  };
  compareUnsupported(errors, 'command', expected.commands, claimed.commands);
  compareUnsupported(errors, 'option', expected.options, claimed.options);
  compareUnsupported(errors, 'exit code', expected.exitCodes, claimed.exitCodes);
  for (const claim of expected.claims) if (!docs.includes(claim)) errors.push(`v2 documentation is missing canonical claim: ${claim}`);
  return { errors, expected, documented, claimed };
}


export function auditCliDocs(input) {
  const documented = parseDocumentedSurface(input.docs);
  if (!documented) return { errors: ['documentation is missing the cli-docs:surface block'] };
  const expected = deriveCliSurface(input);
  const errors = [];
  const exitText = input.docs.match(/Exit codes are stable:([\s\S]*?)(?:\r?\n\r?\n|$)/)?.[1] ?? '';
  const claimed = {
    commands: uniqueSorted([...documented.commands, ...tokens(input.docs, /\bn8n-scan\s+([a-z][a-z0-9-]*)/gim)]),
    options: uniqueSorted([...documented.options, ...tokens(input.docs, /(--[a-z][a-z0-9-]*)/g)]),
    exitCodes: uniqueSorted([...documented.exitCodes, ...tokens(exitText, /\b(\d{1,3})\b/g)]),
  };
  compareVocabulary(errors, 'command', expected.commands, documented.commands);
  compareVocabulary(errors, 'option', expected.options, documented.options);
  compareVocabulary(errors, 'exit code', expected.exitCodes, documented.exitCodes);
  compareUnsupported(errors, 'command', expected.commands, claimed.commands);
  compareUnsupported(errors, 'option', expected.options, claimed.options);
  compareUnsupported(errors, 'exit code', expected.exitCodes, claimed.exitCodes);
  const v2 = input.v2HelpSource === undefined ? undefined : auditV2CliDocs(input, errors);
  return { errors, expected, documented, claimed, ...(v2 === undefined ? {} : { v2 }) };
}

function runLocalCli(root, args) {
  try {
    return execFileSync(process.execPath, [resolve(root, TSX_ENTRY), resolve(root, 'pipeline/cli/n8n-scan.ts'), ...args], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    const stderr = error?.stderr?.toString().trim();
    throw new Error(`Unable to execute local CLI (${args.join(' ')}).${stderr ? ` ${stderr}` : ''}`);
  }
}

export function loadCliDocsInput(root = ROOT) {
  const versionJson = runLocalCli(root, ['--schema', 'v2', 'version', '--format', 'json']);
  JSON.parse(versionJson);
  return {
    docs: readFileSync(resolve(root, DOCS_FILE), 'utf8'),
    generalHelp: runLocalCli(root, ['--help']),
    scanHelp: runLocalCli(root, ['scan', '--help']),
    contractSource: readFileSync(resolve(root, CONTRACT_FILE), 'utf8'),
    v2Docs: readFileSync(resolve(root, V2_DOCS_FILE), 'utf8'),
    v2HelpSource: readFileSync(resolve(root, V2_HELP_FILE), 'utf8'),
    v2ArgumentsSource: readFileSync(resolve(root, V2_ARGUMENTS_FILE), 'utf8'),
    v2ExitSource: readFileSync(resolve(root, V2_EXIT_FILE), 'utf8'),
  };
}

function main() {
  const result = auditCliDocs(loadCliDocsInput());
  if (result.errors.length > 0) {
    console.error(`CLI documentation parity failed (${result.errors.length} error(s))`);
    for (const error of result.errors) console.error(`- ${error}`);
    process.exitCode = 1;
    return;
  }
  console.log(`CLI documentation parity passed: ${result.expected.commands.length} commands, ${result.expected.options.length} options, ${result.expected.exitCodes.length} exit codes.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
