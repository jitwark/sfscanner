import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SourceDef } from '@hub/contracts';
import { processCandidateWorkflow } from '../pipeline/sanitize/process-candidate.js';
import { entryId } from '../pipeline/acquire/entry-id.js';
import { parseSourcesJson } from '../pipeline/sources.schema.js';
import { compareCanonicalStrings } from '@hub/contracts/stable-order';

type EntryRow = { entry?: Record<string, any> } | Record<string, any>;
type WorkflowRow = { id: string; workflow: unknown };

function atomicWrite(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temp = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(temp, content, 'utf8');
  fs.renameSync(temp, filePath);
}

function readJsonLines(filePath: string): WorkflowRow[] {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, 'utf8').split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line) as WorkflowRow);
}

export function loadConfiguredSources(repositoryRoot = process.cwd()): SourceDef[] {
  const sourcesPath = path.join(repositoryRoot, 'pipeline', 'sources.json');
  return parseSourcesJson(fs.readFileSync(sourcesPath, 'utf8'));
}

export function resolveGitDirectory(
  runDir: string,
  entry: Record<string, any>,
  sources: SourceDef[],
): string {
  const repo = typeof entry.source?.repo === 'string' ? entry.source.repo : '';
  const normalizedRepo = repo.toLowerCase();
  const matches = sources.filter(
    (source) => source.kind === 'github' && source.repo?.toLowerCase() === normalizedRepo,
  );
  const entryId = String(entry.id ?? '<unknown>');
  if (matches.length !== 1) {
    const reason = matches.length === 0
      ? 'no configured GitHub source'
      : `ambiguous configured GitHub sources: ${matches.map((source) => source.key).join(', ')}`;
    throw new Error(`cannot resolve clone source for entry ${entryId} and repo ${repo || '<missing>'}: ${reason}`);
  }
  return path.join(runDir, 'clones', matches[0].key, '.git');
}

function gitWorkflow(runDir: string, entry: Record<string, any>, sources: SourceDef[]): unknown {
  const gitDir = resolveGitDirectory(runDir, entry, sources);
  if (!fs.existsSync(gitDir)) throw new Error(`clone missing for ${entry.id}: ${entry.source?.repo}`);
  const revision = `${entry.source.commit}:${entry.source.path}`;
  const raw = execFileSync('git', ['--git-dir', gitDir, 'show', revision], { encoding: 'utf8' });
  return JSON.parse(raw) as unknown;
}

function main(): void {
  const runId = process.argv[2];
  if (!runId) throw new Error('usage: tsx scripts/repair-model-workflows.ts <runId>');
  const runDir = path.resolve(process.cwd(), 'pipeline', '.work', runId);
  const sources = loadConfiguredSources();
  const rawEntries = JSON.parse(fs.readFileSync(path.join(runDir, 'entries.json'), 'utf8')) as EntryRow[];
  const entries = rawEntries.map((row) => ('entry' in row && row.entry ? row.entry : row));
  const canonical = entries.filter((entry) => entry.dedup?.canonical === true);
  const workflows = new Map<string, unknown>();
  for (const row of readJsonLines(path.join(runDir, 'workflows.jsonl'))) workflows.set(row.id, row.workflow);
  for (const row of readJsonLines(path.join(runDir, 'model-workflows.jsonl'))) workflows.set(row.id, row.workflow);
  for (const line of fs.readFileSync(path.join(runDir, 'official-workflows.jsonl'), 'utf8').split(/\r?\n/u).filter(Boolean)) {
    const row = JSON.parse(line) as { templateId: number; workflow: unknown };
    workflows.set(entryId('n8n_official', 'n8n.io', String(row.templateId)), row.workflow);
  }

  const missing = canonical.filter((entry) => !workflows.has(entry.id));
  const repaired: WorkflowRow[] = [];
  const failures: string[] = [];
  for (const entry of missing) {
    try {
      const sanitized = processCandidateWorkflow(gitWorkflow(runDir, entry, sources));
      if (!sanitized.ok) throw new Error(sanitized.errors.join('; '));
      repaired.push({ id: entry.id, workflow: sanitized.workflow });
    } catch (error) {
      failures.push(`${entry.id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (failures.length > 0) throw new Error(`model-workflow repair failed for ${failures.length} entries\n${failures.slice(0, 10).join('\n')}`);
  for (const row of repaired) workflows.set(row.id, row.workflow);
  const output = canonical
    .map((entry) => ({ id: entry.id, workflow: workflows.get(entry.id) }))
    .filter((row): row is WorkflowRow => row.workflow !== undefined)
    .sort((a, b) => compareCanonicalStrings(a.id, b.id))
    .map((row) => JSON.stringify(row)).join('\n') + '\n';
  if (output.split(/\r?\n/u).filter(Boolean).length !== canonical.length) {
    throw new Error(`workflow map remains incomplete: ${output.split(/\r?\n/u).filter(Boolean).length}/${canonical.length}`);
  }
  atomicWrite(path.join(runDir, 'model-workflows.jsonl'), output);
  process.stdout.write(`repaired ${repaired.length} missing model workflows; wrote ${canonical.length} canonical records\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) main();
