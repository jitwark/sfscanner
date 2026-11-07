import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * DOC-GATE-2 — a document may not name a source path that does not exist.
 *
 * The metadata, forbidden-phrase, link and corpus-figure checks all reason about
 * prose and markdown links. None of them asks whether a backticked path such as
 * `src/workflows/scan-service.ts` resolves to a file. That gap let the
 * repository-root CLAUDE.md describe a Supabase/Drizzle server application —
 * naming six source files, none of which existed — while every gate stayed
 * green.
 *
 * The check is deliberately conservative. A false positive here blocks a commit
 * over a documentation nicety, so anything that could plausibly be prose, a
 * command, a glob, an identifier or an environment variable is skipped. It
 * catches the case that actually bit: a concrete, extension-bearing path inside
 * backticks that names nothing.
 */

/** Extensions that make a token unambiguously a file path rather than prose. */
const SOURCE_EXTENSIONS = [
  '.ts', '.tsx', '.mjs', '.cjs', '.js', '.jsx',
  '.json', '.md', '.css', '.yml', '.yaml',
];

const FENCE = /^\s*```/;

/** Paths that exist only after a build, or only inside an install. */
const GENERATED_PREFIXES = [
  'app/out/', 'app/.next/', 'app/public/data/', 'node_modules/', 'coverage/',
];

/** Strip fenced code blocks: they hold commands and examples, not claims. */
function withoutFencedBlocks(source) {
  const kept = [];
  let inFence = false;
  for (const line of source.split(/\r?\n/)) {
    if (FENCE.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (!inFence) kept.push(line);
  }
  return kept.join('\n');
}

/** Top-level directories a documentation path may be rooted at. */
export const DEFAULT_ROOTS = [
  'app', 'packages', 'pipeline', 'contracts', 'scripts', 'docs', 'data',
  'examples', 'openspec', '.github',
];

function looksLikePath(token, roots) {
  // A path claim has a separator and no shell/glob/expression syntax.
  if (!token.includes('/')) return false;
  // Only a path rooted at a real top-level directory is a claim about layout.
  // `acquire/` inside a prose listing of pipeline stages is not.
  if (!roots.some((dir) => token === dir || token.startsWith(`${dir}/`))) return false;
  // Runtime scratch is gitignored and produced per run. A runbook naming an
  // example checkpoint path is documenting output, not claiming a tracked file.
  if (token.includes('/.work/')) return false;
  // Build output exists only after a build. Documenting where the export lands
  // is a true statement about the build, not a claim that the directory is in
  // the repository — and a gate that goes red because nobody has run `npm run
  // build` on this checkout is a gate people learn to ignore.
  if (GENERATED_PREFIXES.some((prefix) => token === prefix || token.startsWith(prefix))) return false;
  if (/[*?<>|$(){}\[\]!]/.test(token)) return false;
  if (/\s/.test(token)) return false;
  if (token.startsWith('-')) return false;
  if (token.startsWith('http://') || token.startsWith('https://')) return false;
  // A leading slash is a site route (`/library/`), not a repository path.
  if (token.startsWith('/')) return false;
  // `npm run x`, `npx tsx path` and similar arrive as multi-word tokens and are
  // already excluded by the whitespace test above.
  if (token.endsWith('/')) return true;
  return SOURCE_EXTENSIONS.some((extension) => token.endsWith(extension));
}

async function resolvesIn(root, token) {
  try {
    await stat(join(root, token));
    return true;
  } catch {
    return false;
  }
}

/**
 * A path resolves if it exists under the documentation root OR under any
 * alternate root supplied by the caller.
 *
 * Standalone callers use only their own root; nested consumers may explicitly
 * provide another authority. No parent is admitted implicitly.
 */
async function resolves(root, token, alternateRoots) {
  if (await resolvesIn(root, token)) return true;
  for (const alternate of alternateRoots) {
    if (await resolvesIn(alternate, token)) return true;
  }
  return false;
}

/**
 * @param {{ root: string, file: string, roots?: string[], alternateRoots?: string[] }} input
 * @returns {Promise<string[]>} one message per referenced path that does not exist
 */
export async function checkReferencedPaths({ root, file, roots = DEFAULT_ROOTS, alternateRoots = [] }) {
  let source;
  try {
    source = await readFile(join(root, file), 'utf8');
  } catch {
    return [`${file}: referenced-path check could not read the document`];
  }

  const prose = withoutFencedBlocks(source);
  const errors = [];
  const seen = new Set();

  for (const match of prose.matchAll(/`([^`\n]+)`/g)) {
    const token = match[1].trim().replace(/[.,;:]$/, '');
    if (seen.has(token)) continue;
    seen.add(token);
    if (!looksLikePath(token, roots)) continue;
    if (await resolves(root, token, alternateRoots)) continue;
    errors.push(`${file}: names \`${token}\`, which does not exist`);
  }

  return errors;
}
