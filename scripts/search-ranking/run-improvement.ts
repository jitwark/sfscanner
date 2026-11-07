import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  DEFAULT_POLICY,
  evaluateRankingImprovement,
  sha256,
  stableJson,
  type JudgedSet,
  type RankedRun,
  type RankingPolicy,
  type RankingReport,
} from './improvement-protocol';

const root = resolve(import.meta.dirname, '..', '..');
const defaultFixture = resolve(root, 'app', 'src', 'search', '__fixtures__', 'relevance-set.json');
type JsonRecord = Record<string, unknown>;
const isRecord = (value: unknown): value is JsonRecord => value !== null && typeof value === 'object' && !Array.isArray(value);
const readJson = (file: string): unknown => JSON.parse(readFileSync(file, 'utf8'));

function parseArgs(args: readonly string[]) {
  let fixture = defaultFixture; let results: string | undefined; let availableIds: string | undefined; let policy: string | undefined; let pretty = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--pretty') { pretty = true; continue; }
    const match = argument?.match(/^--(fixture|results|available-ids|policy)=(.*)$/);
    const name = match?.[1] ?? (argument?.startsWith('--') ? argument.slice(2) : '');
    if (match) { if (!match[2]) throw new Error(`--${name} value is required`); if (name === 'fixture') fixture = match[2]; else if (name === 'results') results = match[2]; else if (name === 'available-ids') availableIds = match[2]; else policy = match[2]; continue; }
    if (['fixture', 'results', 'available-ids', 'policy'].includes(name)) { const value = args[++index]; if (!value || value.startsWith('--')) throw new Error(`--${name} value is required`); if (name === 'fixture') fixture = value; else if (name === 'results') results = value; else if (name === 'available-ids') availableIds = value; else policy = value; continue; }
    if (argument === '--help') throw new Error('usage: tsx scripts/search-ranking/run-improvement.ts --results <json> [--fixture <json>] [--available-ids <json>] [--policy <json>] [--pretty]');
    throw new Error(`unknown argument: ${argument}`);
  }
  if (!results) throw new Error('--results is required: provide baseline and candidate result lists');
  return { fixture: resolve(fixture), results: resolve(results), availableIds: availableIds ? resolve(availableIds) : undefined, policy: policy ? resolve(policy) : undefined, pretty };
}

function artifactIds(): string[] {
  const ids = new Set<string>();
  for (const file of ['search-index.json', 'search-index-extended.json', 'facets.json']) {
    const value = readJson(resolve(root, 'app', 'public', 'data', file));
    if (!isRecord(value)) continue;
    const stored = value.storedFields; if (isRecord(stored)) for (const item of Object.values(stored)) if (isRecord(item) && typeof item.id === 'string') ids.add(item.id);
    if (Array.isArray(value.ordinals)) for (const id of value.ordinals) if (typeof id === 'string') ids.add(id);
  }
  return [...ids].sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
}
function idsFromFile(file: string): string[] {
  const value = readJson(file); const ids = Array.isArray(value) ? value : isRecord(value) && Array.isArray(value.ids) ? value.ids : null;
  if (!ids || ids.some((id) => typeof id !== 'string')) throw new Error(`${file} must contain a string array or {"ids": [...]}`);
  return [...new Set(ids)];
}
function failure(message: string): RankingReport {
  const report = { schemaVersion: 'search-ranking-improvement-v1', releaseId: null, fixtureSchemaVersion: null, policy: DEFAULT_POLICY, tuning: { split: 'development' as const, tunedCaseIds: [], holdoutUntouched: false }, baseline: { label: '', version: '', releaseId: '', metrics: null }, candidate: { label: '', version: '', releaseId: '', metrics: null }, comparison: { holdoutDeltas: { recallAt10: 0, ndcgAt10: 0, mrr: 0, exactSuccessRate: 0, facetSuccessRate: 0 }, caseComparisons: [], regressions: [] }, accepted: false, errors: [message] };
  return { ...report, reportSha256: sha256(stableJson(report)) };
}
export function runImprovement(args = process.argv.slice(2)): { code: number; report: RankingReport } {
  try {
    const options = parseArgs(args); const fixture = readJson(options.fixture) as JudgedSet; const payload = readJson(options.results);
    if (!isRecord(payload) || !isRecord(payload.baseline) || !isRecord(payload.candidate)) throw new Error('results file must contain baseline and candidate runs');
    const availableIds = options.availableIds ? idsFromFile(options.availableIds) : isRecord(payload) && Array.isArray(payload.availableIds) ? idsFromFileFromValue(payload.availableIds) : artifactIds();
    const filePolicy = options.policy ? readJson(options.policy) : isRecord(payload) ? payload.policy : undefined;
    const report = evaluateRankingImprovement({ judgedSet: fixture, availableIds, baseline: payload.baseline as unknown as RankedRun, candidate: payload.candidate as unknown as RankedRun, policy: filePolicy as Partial<RankingPolicy> });
    return { code: report.accepted ? 0 : 1, report };
  } catch (error) { return { code: 1, report: failure(error instanceof Error ? error.message : 'invalid improvement input') }; }
}
function idsFromFileFromValue(value: unknown): string[] { if (!Array.isArray(value) || value.some((id) => typeof id !== 'string')) throw new Error('results.availableIds must be a string array'); return [...new Set(value)]; }
export function main(args = process.argv.slice(2), io = { stdout: process.stdout }): number { const result = runImprovement(args); io.stdout.write(`${JSON.stringify(result.report, null, args.includes('--pretty') ? 2 : 0)}\n`); return result.code; }

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) process.exitCode = main();
