import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compareCanonicalStrings } from '@hub/contracts/stable-order';
import { checkRepository, fetchPinnedWorkflow, sha256, type CatalogueSourceRow } from './github-pinned-body.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const pipelineDir = path.resolve(here, '..');
const workspaceDir = path.resolve(pipelineDir, '..');
const cataloguePaths = Array.from({ length: 6 }, (_, index) => `data/catalogue-${index}.json`);
const expectedCounts: Record<string, number> = {
  'zengfr/n8n-workflow-all-templates': 201,
  'murataslan1/n8n-workflow-collection': 67,
  'ScraperNode/awesome-n8n-templates': 6,
  'Kookylo/claude_workflow_generator': 9,
  'pinecone-io/n8n-templates': 5,
};
const concurrency = 3;

type InventoryRow = CatalogueSourceRow & {
  bodyPath: string | null;
  sha256: string | null;
  bytes: number | null;
  resolved: boolean;
  reason?: string;
};

type AcquiredRow = {
  source: CatalogueSourceRow;
  bodyPath?: string;
  sha256?: string;
  bytes?: number;
  reason?: string;
};

export function extractRedistributableRows(catalogues: unknown[][]): CatalogueSourceRow[] {
  const rows: CatalogueSourceRow[] = [];
  for (const catalogue of catalogues) {
    for (const entry of catalogue) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
      const record = entry as Record<string, unknown>;
      const rights = record.rights;
      if (!rights || typeof rights !== 'object' || Array.isArray(rights) || (rights as Record<string, unknown>).status !== 'redistributable') continue;
      const rawSource = record.source;
      if (!rawSource || typeof rawSource !== 'object' || Array.isArray(rawSource)) continue;
      const source = rawSource as Record<string, unknown>;
      rows.push({
        kind: typeof source.kind === 'string' ? source.kind : null,
        repo: typeof source.repo === 'string' ? source.repo : null,
        owner: typeof source.owner === 'string' ? source.owner : null,
        path: typeof source.path === 'string' ? source.path : null,
        commit: typeof source.commit === 'string' ? source.commit : null,
        permalink: typeof source.permalink === 'string' ? source.permalink : null,
      });
    }
  }
  rows.sort((left, right) => {
    for (const field of ['repo', 'commit', 'path', 'owner', 'permalink', 'kind'] as const) {
      const order = compareCanonicalStrings(left[field] ?? '', right[field] ?? '');
      if (order !== 0) return order;
    }
    return 0;
  });
  return rows;
}

function sourceProblem(source: CatalogueSourceRow): string | null {
  if (source.kind !== 'github') return 'non_github_source';
  if (!source.repo || !source.commit || !source.path || !source.owner || !source.permalink) return 'missing_source_provenance';
  const repoParts = source.repo.split('/');
  if (repoParts.length !== 2 || repoParts.some((part) => !part || part === '.' || part === '..')) return 'invalid_repository';
  if (source.owner.toLowerCase() !== repoParts[0]!.toLowerCase()) return 'source_owner_mismatch';
  if (source.permalink !== `https://github.com/${source.repo}/blob/${source.commit}/${source.path}`) return 'source_permalink_mismatch';
  if (!/^(?:[a-f\d]{40}|[a-f\d]{64})$/i.test(source.commit)) return 'invalid_commit';
  const segments = source.path.split('/');
  if (source.path.startsWith('/') || source.path.includes('\\') || source.path.includes('\0') || segments.some((part) => !part || part === '.' || part === '..')) return 'invalid_path';
  return null;
}

function storageProblem(source: CatalogueSourceRow): string | null {
  const segments = source.path!.split('/');
  if (process.platform === 'win32' && segments.some((part) => /[<>:"|?*]/.test(part) || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(part))) return 'unsupported_local_path';
  return null;
}

function sourceKey(source: CatalogueSourceRow): string {
  return JSON.stringify([source.repo, source.commit, source.path]);
}

async function mapConcurrent<T, R>(items: T[], limit: number, visit: (item: T) => Promise<R>): Promise<R[]> {
  const results = Array<R>(items.length);
  let index = 0;
  async function worker(): Promise<void> {
    while (index < items.length) {
      const current = index++;
      results[current] = await visit(items[current]!);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function fsPath(filePath: string): string {
  return process.platform === 'win32' ? path.toNamespacedPath(filePath) : filePath;
}

function githubToken(): string {
  const environmentToken = process.env.GITHUB_TOKEN?.trim();
  if (environmentToken) return environmentToken;
  const token = execFileSync('gh', ['auth', 'token', '--hostname', 'github.com'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  if (!token) throw new Error('No GitHub token found in GITHUB_TOKEN or gh auth');
  return token;
}

function verifyPopulation(rows: CatalogueSourceRow[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const row of rows) {
    if (row.repo) counts.set(row.repo, (counts.get(row.repo) ?? 0) + 1);
  }
  const mismatch = rows.length !== 288 || Object.entries(expectedCounts).some(([repo, count]) => counts.get(repo) !== count) || counts.size !== Object.keys(expectedCounts).length;
  if (mismatch) throw new Error(`Catalogue population mismatch: total=${rows.length}, repos=${JSON.stringify(Object.fromEntries([...counts].sort(([a], [b]) => compareCanonicalStrings(a, b))))}`);
  return counts;
}

async function main(): Promise<void> {
  const runIndex = process.argv.indexOf('--run');
  const runId = runIndex >= 0 ? process.argv[runIndex + 1] : undefined;
  if (!runId || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(runId) || runId.includes('..')) {
    throw new Error('Usage: npx tsx pipeline/acquire/acquire-authentic-bodies.ts --run <safe-run-id>');
  }

  const catalogues: unknown[][] = [];
  for (const relativePath of cataloguePaths) {
    const parsed: unknown = JSON.parse(await readFile(path.join(workspaceDir, relativePath), 'utf8'));
    if (!Array.isArray(parsed)) throw new Error(`${relativePath} is not a catalogue array`);
    catalogues.push(parsed);
  }
  const sources = extractRedistributableRows(catalogues);
  const perRepo = verifyPopulation(sources);
  for (const [repo, count] of [...perRepo].sort(([left], [right]) => compareCanonicalStrings(left, right))) {
    console.log(`${repo}: ${count}`);
  }

  const token = githubToken();
  const sourceProblems = new Map(sources.map((source) => [source, sourceProblem(source)]));
  const repositories = [...new Set(sources.filter((source) => !sourceProblems.get(source)).map((source) => source.repo!))]
    .sort(compareCanonicalStrings);
  const repositoryProblems = new Map<string, string | null>();
  const repositoryChecks = await mapConcurrent(repositories, concurrency, async (repo) => [repo, await checkRepository(repo, token)] as const);
  for (const [repo, reason] of repositoryChecks) repositoryProblems.set(repo, reason);

  const storageProblems = new Map(sources.map((source) => [source, sourceProblem(source) ? null : storageProblem(source)]));
  const uniqueSources = new Map<string, CatalogueSourceRow>();
  for (const source of sources) {
    if (!sourceProblems.get(source) && !repositoryProblems.get(source.repo!) && !storageProblems.get(source)) uniqueSources.set(sourceKey(source), source);
  }
  if (process.platform === 'win32') {
    const pathOwners = new Map<string, string>();
    const collisions = new Set<string>();
    for (const [key, source] of uniqueSources) {
      const destination = `bodies/${source.repo}/${source.commit}/${source.path}`.toLowerCase();
      const previous = pathOwners.get(destination);
      if (previous && previous !== key) {
        collisions.add(previous);
        collisions.add(key);
      } else {
        pathOwners.set(destination, key);
      }
    }
    for (const key of collisions) {
      const source = uniqueSources.get(key)!;
      storageProblems.set(source, 'local_path_collision');
      uniqueSources.delete(key);
    }
  }
  const runDir = path.join(pipelineDir, '.work', runId);
  await mkdir(fsPath(path.dirname(runDir)), { recursive: true });
  await mkdir(fsPath(runDir));

  const fetchedRows = await mapConcurrent([...uniqueSources.values()], concurrency, async (source): Promise<AcquiredRow> => {
    const fetched = await fetchPinnedWorkflow(source, token);
    if (!fetched.body) return { source, reason: fetched.reason };
    const bodyPath = `bodies/${source.repo}/${source.commit}/${source.path}`;
    const outputPath = path.join(runDir, ...bodyPath.split('/'));
    await mkdir(fsPath(path.dirname(outputPath)), { recursive: true });
    await writeFile(fsPath(outputPath), fetched.body, { flag: 'wx' });
    return { source, bodyPath, sha256: sha256(fetched.body), bytes: fetched.body.length };
  });
  const fetchedByKey = new Map(fetchedRows.map((row) => [sourceKey(row.source), row]));

  const inventoryRows: InventoryRow[] = sources.map((source) => {
    const reason = sourceProblems.get(source) ?? repositoryProblems.get(source.repo ?? '') ?? storageProblems.get(source) ?? undefined;
    const fetched = reason ? undefined : fetchedByKey.get(sourceKey(source));
    if (reason || !fetched || fetched.reason) {
      return { ...source, bodyPath: null, sha256: null, bytes: null, resolved: false, reason: reason ?? fetched?.reason ?? 'acquisition_missing' };
    }
    return { ...source, bodyPath: fetched.bodyPath!, sha256: fetched.sha256!, bytes: fetched.bytes!, resolved: true };
  });
  const dropReasons = new Map<string, number>();
  for (const row of inventoryRows) {
    if (row.reason) dropReasons.set(row.reason, (dropReasons.get(row.reason) ?? 0) + 1);
  }
  const resolved = inventoryRows.filter((row) => row.resolved).length;
  const totalBytes = inventoryRows.reduce((total, row) => total + (row.bytes ?? 0), 0);
  const core = {
    schemaVersion: 1,
    method: 'GitHub REST Contents API with ref=source.commit; file bytes verified against Git blob SHA-1',
    inventoryDigestBasis: 'sha256(JSON.stringify(inventory fields excluding inventoryDigest))',
    sourceCatalogues: cataloguePaths,
    rowCount: inventoryRows.length,
    resolved,
    dropped: inventoryRows.length - resolved,
    totalBytes,
    dropReasons: Object.fromEntries([...dropReasons].sort(([left], [right]) => compareCanonicalStrings(left, right))),
    rows: inventoryRows,
  };
  const inventoryDigest = createHash('sha256').update(JSON.stringify(core)).digest('hex');
  const inventoryPath = path.join(runDir, 'inventory.json');
  await writeFile(fsPath(inventoryPath), `${JSON.stringify({ ...core, inventoryDigest: `sha256:${inventoryDigest}` }, null, 2)}\n`, 'utf8');
  console.log(`Resolved: ${resolved}; dropped: ${inventoryRows.length - resolved}; bytes: ${totalBytes}`);
  console.log(`Drop reasons: ${JSON.stringify(core.dropReasons)}`);
  console.log(`Inventory: pipeline/.work/${runId}/inventory.json`);
  console.log(`Inventory digest: sha256:${inventoryDigest}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
