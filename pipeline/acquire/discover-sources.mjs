import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const QUERIES = ['n8n workflows', 'n8n templates', 'topic:n8n', 'awesome n8n', 'n8n automation collection'];
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const registryPath = path.join(root, 'sources.json');

async function githubSearch(query, token) {
  const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'n8n-community-hub-source-discovery' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(`https://api.github.com/search/repositories?q=${encodeURIComponent(query)}&sort=stars&order=desc&per_page=100`, { headers });
  if (!response.ok) throw new Error(`GitHub search ${JSON.stringify(query)} failed: HTTP ${response.status}`);
  const body = await response.json();
  return Array.isArray(body.items) ? body.items : [];
}

export async function discoverSources({ fetcher = githubSearch, token = process.env.GITHUB_TOKEN, registry = registryPath } = {}) {
  const configured = JSON.parse(await readFile(registry, 'utf8'));
  const known = new Set(configured.filter((source) => source.kind === 'github').map((source) => source.repo.toLowerCase()));
  const found = new Map();
  for (const query of QUERIES) {
    for (const item of await fetcher(query, token)) {
      if (!item?.full_name || known.has(String(item.full_name).toLowerCase())) continue;
      found.set(String(item.full_name).toLowerCase(), item);
    }
  }
  return [...found.values()]
    .filter((item) => !item.archived && !item.fork)
    .sort((a, b) => (b.stargazers_count ?? 0) - (a.stargazers_count ?? 0));
}

function printTable(items) {
  console.log('| full_name | stars | spdx | size_mb | pushed_at | description |');
  console.log('| --- | ---: | --- | ---: | --- | --- |');
  for (const item of items) {
    const description = String(item.description ?? '').replace(/[\r\n|]/g, ' ').trim();
    const sizeMb = ((Number(item.size) || 0) / 1024).toFixed(2);
    console.log(`| ${item.full_name} | ${item.stargazers_count ?? 0} | ${item.license?.spdx_id ?? 'NOASSERTION'} | ${sizeMb} | ${item.pushed_at ?? ''} | ${description} |`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    printTable(await discoverSources());
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
