/**
 * Staged-bytes sweep: what a v2 regeneration run may contain, as a closed vocabulary.
 * Every file under the staged roots is read — any name, any encoding — and a file is accepted only
 * when its name is one the v2 writer emits, its bytes decode as UTF-8 without control characters,
 * and every key and value of its JSON matches the writer's own schema (`staged-bytes-schema.ts`).
 * Anything else — prose, a filesystem path, a URL, a credential, a key the writer never emits, a
 * file nobody wrote — is a finding. The allow-list is the whole schema, so a novel token fails
 * closed rather than passing unexamined. Content smuggled inside an allowed shape (exactly 16 or 64
 * lowercase hex) and vocabulary added later (fails closed until the schema is extended) are not caught. Properties of the given bytes are proven; that
 * those bytes are a faithful derivative of the inputs is not.
 *
 * A positive control runs on every invocation: one synthetic artifact per forbidden class is planted
 * and the real sweep must detect each one, or it reports itself failed. Deterministic and offline:
 * sorted enumeration and findings, no clock. A detector that has only ever passed is not evidence.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compareCanonicalStrings } from '@hub/contracts/stable-order';
import { V2_SCAN_EVIDENCE_SCHEMA_VERSION } from './v2-scan-evidence.js';
import { CONTROL_CHARACTER, STAGED_FILES, TEXT_RULES, scanDecodedPaths, type ValueRule } from './staged-bytes-schema.js';

export const STAGED_BYTES_SWEEP_SCHEMA_VERSION = 'staged-bytes-sweep-v1' as const;

export type SweepRule = 'unexpected-file' | 'not-utf8' | 'not-json' | 'control-character' | 'unknown-key' | 'missing-key' | 'unknown-value'
  | 'filesystem-path' | 'private-root' | 'url' | 'credential-marker';
export type SweepFinding = Readonly<{ artifact: string; path: string; rule: SweepRule }>;
export type StagedFile = Readonly<{ file: string; path: string; bytes: number; sha256: string }>;
export type SweepRoot = Readonly<{ label: string; dir: string }>; // one labeled directory per swept run
export type PositiveControlSummary = Readonly<{ planted: readonly string[]; detected: readonly string[]; undetected: readonly string[]; ok: boolean }>;
export type SweepSummary = Readonly<{
  schemaVersion: typeof STAGED_BYTES_SWEEP_SCHEMA_VERSION; privateRoots: readonly string[];
  files: number; bytes: number; findings: readonly SweepFinding[]; positiveControl: PositiveControlSummary;
}>;

export const sha256Hex = (bytes: Uint8Array | string): string => createHash('sha256').update(bytes).digest('hex');

export function collectStagedFiles(root: string): readonly StagedFile[] {
  const files: StagedFile[] = [];
  for (const entry of fs.readdirSync(root, { recursive: true, withFileTypes: true })) {
    if (entry.isDirectory()) continue;
    if (!entry.isFile()) throw new TypeError(`staged tree carries a non-regular entry: ${path.relative(root, path.join(entry.parentPath, entry.name)).replace(/\\/g, '/')}`);
    const file = path.join(entry.parentPath, entry.name);
    const bytes = fs.readFileSync(file);
    files.push({ file, path: path.relative(root, file).replace(/\\/g, '/'), bytes: bytes.byteLength, sha256: sha256Hex(bytes) });
  }
  return files.sort((left, right) => compareCanonicalStrings(left.path, right.path));
}

export function manifestDigest(files: readonly StagedFile[]): string {
  const lines = [...files].sort((left, right) => compareCanonicalStrings(left.path, right.path))
    .map((file) => `${file.path} ${file.sha256}`);
  return sha256Hex(`${lines.join('\n')}\n`);
}
type Mismatch = (artifact: string, jsonPath: string, rule: SweepRule) => void;

function match(rule: ValueRule, value: unknown, artifact: string, jsonPath: string, report: Mismatch): void {
  if (typeof value === 'string' && CONTROL_CHARACTER.test(value)) report(artifact, jsonPath, 'control-character');
  switch (rule.kind) {
    case 'object': {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) return report(artifact, jsonPath, 'unknown-value');
      const record = value as Record<string, unknown>;
      for (const key of Object.keys(record)) if (!Object.hasOwn(rule.keys, key)) report(artifact, jsonPath, 'unknown-key');
      for (const [key, child] of Object.entries(rule.keys)) {
        // A writer may omit an unset optional field; absence and null carry the same meaning here.
        if (!Object.hasOwn(record, key)) {
          if (child.kind !== 'optional') report(artifact, jsonPath, 'missing-key');
          continue;
        }
        match(child, record[key], artifact, `${jsonPath}.${key}`, report);
      }
      if (rule.check !== undefined && !rule.check(value)) report(artifact, jsonPath, 'unknown-value');
      return;
    }
    case 'array': {
      if (!Array.isArray(value)) return report(artifact, jsonPath, 'unknown-value');
      value.forEach((item, index) => match(rule.item, item, artifact, `${jsonPath}[${index}]`, report));
      return;
    }
    case 'oneOf': {
      const accepts = rule.items.some((item) => {
        let matched = true;
        match(item, value, artifact, jsonPath, () => { matched = false; });
        return matched;
      });
      if (!accepts) report(artifact, jsonPath, 'unknown-value');
      return;
    }
    case 'enum': return void (rule.values.includes(value as string) || report(artifact, jsonPath, 'unknown-value'));
    case 'literal': return void (value === rule.value || report(artifact, jsonPath, 'unknown-value'));
    case 'shaped': return void (typeof value === 'string' && rule.pattern.test(value) || report(artifact, jsonPath, 'unknown-value'));
    case 'integer': return void (Number.isSafeInteger(value) && (value as number) >= 0 || report(artifact, jsonPath, 'unknown-value'));
    case 'number': return void (typeof value === 'number' && Number.isFinite(value)
      && (rule.min === undefined || value >= rule.min) && (rule.max === undefined || value <= rule.max)
      || report(artifact, jsonPath, 'unknown-value'));
    case 'boolean': return void (typeof value === 'boolean' || report(artifact, jsonPath, 'unknown-value'));
    case 'null': return void (value === null || report(artifact, jsonPath, 'unknown-value'));
    case 'optional': return void (value === undefined || value === null || match(rule.item, value, artifact, jsonPath, report));
  }
}

/** Structural pass used by both the public sweep and its positive control. */
function sweepFileSets(input: Readonly<{ roots: readonly SweepRoot[]; privateRoots?: readonly string[] }>): Readonly<{ files: number; bytes: number; findings: readonly SweepFinding[] }> {
  const findings: SweepFinding[] = [];
  const seen = new Set<string>();
  const report: Mismatch = (artifact, jsonPath, rule) => {
    const key = `${artifact}\u0000${jsonPath}\u0000${rule}`;
    if (!seen.has(key)) { seen.add(key); findings.push({ artifact, path: jsonPath, rule }); }
  };
  const needles = (input.privateRoots ?? []).flatMap((root) => {
    const resolved = path.resolve(root);
    return [resolved, resolved.replace(/\\/g, '/')].map((variant) => variant.toLowerCase());
  });
  let files = 0; let bytes = 0;
  for (const root of input.roots) {
    for (const staged of collectStagedFiles(root.dir)) {
      files += 1;
      bytes += staged.bytes;
      const artifact = `${root.label}/${staged.path}`;
      let text: string;
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(fs.readFileSync(staged.file));
      } catch {
        report(artifact, '$', 'not-utf8');
        continue;
      }
      if (CONTROL_CHARACTER.test(text)) report(artifact, '$', 'control-character');
      const lower = text.toLowerCase();
      for (const needle of needles) if (lower.includes(needle)) report(artifact, '$', 'private-root');
      for (const { rule, pattern } of TEXT_RULES) if (pattern.test(text)) report(artifact, '$', rule);
      const known = STAGED_FILES[path.basename(staged.file)];
      if (known === undefined) { report(artifact, '$', 'unexpected-file'); continue; }
      const documents = known.lines ? text.split('\n').filter((line) => line !== '') : [text];
      documents.forEach((document, index) => {
        const jsonPath = known.lines ? `$line${index + 1}` : '$';
        try {
          const parsed: unknown = JSON.parse(document);
          match(known.rule, parsed, artifact, jsonPath, report);
          scanDecodedPaths(parsed, [], artifact, jsonPath, report);
        } catch {
          report(artifact, jsonPath, 'not-json');
        }
      });
    }
  }
  findings.sort((left, right) => compareCanonicalStrings(
    `${left.artifact}\u0000${left.path}\u0000${left.rule}`, `${right.artifact}\u0000${right.path}\u0000${right.rule}`,
  ));
  return { files, bytes, findings: Object.freeze(findings) };
}

/** One synthetic artifact per forbidden class, named as the writer names its files. */
export function runPositiveControl(): PositiveControlSummary {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'staged-bytes-control-'));
  const privateRoot = path.join(directory, 'Synthetic Private Root');
  const record = (overrides: Record<string, unknown>): Buffer => Buffer.from(JSON.stringify({
    schemaVersion: V2_SCAN_EVIDENCE_SCHEMA_VERSION, entryId: '0000000000000001', scanFreshness: 'UNSCANNED', rightsClass: 'link_only',
    inventorySha256: 'a'.repeat(64), scan: null, retainedVerdict: null, receiptReasonCode: null, ...overrides,
  }));
  const plants: readonly Readonly<{ name: string; rule: SweepRule; bytes: Uint8Array }>[] = [
    { name: 'credential', rule: 'credential-marker', bytes: record({ receiptReasonCode: 'password=qqbbjjvvww0123456789' }) },
    { name: 'filesystem-path', rule: 'filesystem-path', bytes: record({ receiptReasonCode: 'C:\\Users\\private\\vault.json' }) },
    { name: 'private-root', rule: 'private-root', bytes: record({ receiptReasonCode: `${privateRoot.replace(/\\/g, '/').toUpperCase()}/body.json` }) },
    { name: 'url', rule: 'url', bytes: record({ receiptReasonCode: 'https://example.invalid/leak' }) },
    { name: 'body-bytes', rule: 'unknown-key', bytes: Buffer.from(JSON.stringify({ nodes: [{ parameters: { description: 'A workflow body must never be staged as its own artifact' } }] })) },
    { name: 'control-character', rule: 'control-character', bytes: record({ receiptReasonCode: 'RULING\u00071' }) },
    { name: 'not-utf8', rule: 'not-utf8', bytes: Uint8Array.from([0x7b, 0x22, 0xff, 0xfe, 0x22, 0x7d]) }, // bytes that cannot decode as UTF-8
  ];
  for (const plant of plants) {
    const control = path.join(directory, `control-${plant.name}`);
    fs.mkdirSync(control, { recursive: true });
    fs.writeFileSync(path.join(control, 'v2-scan-evidence.ndjson'), plant.bytes);
  }
  const sweep = sweepFileSets({ roots: [{ label: 'control', dir: directory }], privateRoots: [privateRoot] });
  fs.rmSync(directory, { recursive: true, force: true });
  const detected = plants.filter((plant) => sweep.findings.some((finding) => finding.artifact.startsWith(`control/control-${plant.name}/`) && finding.rule === plant.rule)).map((plant) => plant.name);
  const undetected = plants.filter((plant) => !detected.includes(plant.name)).map((plant) => plant.name);
  return Object.freeze({ planted: Object.freeze(plants.map((plant) => plant.name)), detected: Object.freeze(detected), undetected: Object.freeze(undetected), ok: undetected.length === 0 });
}

export function sweepStagedBytes(input: Readonly<{ roots: readonly SweepRoot[]; privateRoots?: readonly string[] }>): SweepSummary {
  const swept = sweepFileSets(input);
  return Object.freeze({
    schemaVersion: STAGED_BYTES_SWEEP_SCHEMA_VERSION, privateRoots: Object.freeze([...(input.privateRoots ?? [])]),
    files: swept.files, bytes: swept.bytes, findings: swept.findings, positiveControl: runPositiveControl(),
  });
}

const USAGE = Object.freeze([
  'Usage: node --import tsx pipeline/regenerate/staged-bytes-sweep.ts --root <label>=<dir> [--root <label>=<dir> ...] [--private-root <path>]',
  '       [--json] [--plant-leak]  --root: a staged root to sweep (repeatable); --private-root: an input path the staged bytes must not name',
  '  --plant-leak sweeps an extra control artifact so the red verdict is demonstrated on demand',
].join('\n'));

export function runSweepCli(argv: readonly string[]): number {
  const roots: SweepRoot[] = [];
  const privateRoots: string[] = [];
  let json = false; let plantLeak = false;
  try {
    for (let index = 0; index < argv.length; index += 1) {
      const argument = argv[index];
      if (argument === '--json') { json = true; continue; }
      if (argument === '--plant-leak') { plantLeak = true; continue; }
      const value = argv[index + 1]; // the two value flags below are the only ones left beside the booleans
      if (argument === '--private-root' || argument === '--root') {
        if (value === undefined || value.startsWith('--')) throw new Error(`${argument} requires a value`);
        if (argument === '--private-root') privateRoots.push(path.resolve(value));
        else {
          const separator = value.indexOf('=');
          if (separator <= 0) throw new Error('--root must read <label>=<dir>');
          roots.push({ label: value.slice(0, separator), dir: path.resolve(value.slice(separator + 1)) });
        }
        index += 1;
        continue;
      }
      throw new Error(`unknown option: ${/^--[a-z][a-z0-9-]{0,61}$/.test(argument) ? argument : '(a bare argument)'}`);
    }
    if (roots.length === 0) throw new Error('at least one --root is required');
  } catch (error) {
    process.stderr.write(`Staged-bytes sweep: ${error instanceof Error ? error.message : String(error)}\n\n${USAGE}\n`);
    return 2;
  }
  try {
    if (plantLeak) {
      const planted = fs.mkdtempSync(path.join(os.tmpdir(), 'staged-bytes-planted-'));
      fs.writeFileSync(path.join(planted, 'control-leak.json'), JSON.stringify({ receiptReasonCode: 'password=qqbbjjvvww0123456789' }));
      roots.push({ label: 'planted-control', dir: planted });
    }
    const summary = sweepStagedBytes({ roots, privateRoots });
    if (json) process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    else {
      process.stdout.write(`Staged-bytes sweep: ${summary.files} file(s) / ${summary.bytes} bytes across ${roots.length} root(s)\n`);
      for (const finding of summary.findings) process.stdout.write(`  FINDING ${finding.artifact} ${finding.path} ${finding.rule}\n`);
      process.stdout.write(`Positive control: ${summary.positiveControl.detected.length}/${summary.positiveControl.planted.length} classes detected\n`);
    }
    if (!summary.positiveControl.ok) { process.stderr.write(`Staged-bytes sweep failed: undetected control class(es): ${summary.positiveControl.undetected.join(', ')}\n`); return 1; }
    if (summary.findings.length > 0) { process.stderr.write(`Staged-bytes sweep failed: ${summary.findings.length} finding(s).\n`); return 1; }
    process.stdout.write(`Staged-bytes sweep passed: 0 findings across ${summary.files} staged file(s).\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`Staged-bytes sweep failed: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  process.exitCode = runSweepCli(process.argv.slice(2));
}
