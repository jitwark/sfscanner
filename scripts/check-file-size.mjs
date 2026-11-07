import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const limit = Number(process.env.FILE_SIZE_LIMIT ?? 250);
const projectRoot = path.resolve(import.meta.dirname, '..');
const SOURCE_ROOTS = Object.freeze(['app', 'pipeline', 'contracts', 'packages', 'scripts']);
// Tests and recorded fixtures are exempt by policy: a table-driven suite or a
// provenance-carrying fixture is long because it is thorough, and splitting it
// to satisfy a line count makes it harder to read, not easier.
const EXEMPT = /(\.test\.|\.spec\.|(^|\/)__fixtures__\/)/;
const gitOptions = { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], cwd: projectRoot };

export function countLines(content) {
  if (content.length === 0) return 0;
  return content.split(/\r?\n/).length - (/\r?\n$/.test(content) ? 1 : 0);
}

function toProjectRelative(file, root = projectRoot, gitRoot = root) {
  const normalized = file.replace(/\\/g, '/');
  const projectPrefix = path.relative(gitRoot, root).replace(/\\/g, '/');
  const relativeInput = projectPrefix && (normalized === projectPrefix || normalized.startsWith(`${projectPrefix}/`))
    ? normalized.slice(projectPrefix.length + 1)
    : normalized;
  const absolute = path.resolve(root, relativeInput);
  const relative = path.relative(root, absolute).replace(/\\/g, '/');
  if (!relative || relative === '..' || relative.startsWith('../') || path.isAbsolute(relative)) return null;
  return relative;
}

export function selectSourceFiles({ all, tracked = [], changed = [], staged = [], untracked = [], root = projectRoot, gitRoot = root }) {
  const candidates = all ? [...tracked, ...untracked] : [...changed, ...staged, ...untracked];
  const sourcePattern = new RegExp(`^(?:${SOURCE_ROOTS.join('|')})\\/.*\\.(?:ts|tsx|mjs|cjs)$`);
  return [...new Set(candidates.map((file) => toProjectRelative(file, root, gitRoot)).filter(Boolean))]
    .filter((file) => sourcePattern.test(file))
    .filter((file) => !EXEMPT.test(file))
    .filter((file) => !/(^|\/)(out|out-canary|\.next)\//.test(file));
}

function gitFiles(args) {
  return execFileSync('git', args, gitOptions).split('\0').filter(Boolean);
}

function readBaseline(root) {
  const baselinePath = path.join(root, 'scripts', 'file-size-baseline.json');
  return fs.existsSync(baselinePath) ? JSON.parse(fs.readFileSync(baselinePath, 'utf8')) : {};
}

export function main(args = process.argv.slice(2)) {
  const all = args.includes('--all');
  const baseline = readBaseline(projectRoot);
  const gitRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], gitOptions).trim();
  const changed = gitFiles(['diff', '--name-only', '--diff-filter=AM', '-z', 'HEAD']);
  const staged = gitFiles(['diff', '--cached', '--name-only', '--diff-filter=AM', '-z']);
  const untracked = gitFiles(['ls-files', '--others', '--exclude-standard', '-z', '--', ...SOURCE_ROOTS]);
  const tracked = all ? gitFiles(['ls-files', '-z', '--', ...SOURCE_ROOTS]) : [];
  const sourceFiles = selectSourceFiles({ all, tracked, changed, staged, untracked, root: projectRoot, gitRoot });
  const violations = [];

  for (const file of sourceFiles) {
    const absolute = path.join(projectRoot, file);
    if (!fs.existsSync(absolute)) continue;
    const lines = countLines(fs.readFileSync(absolute, 'utf8'));
    const allowed = Number.isInteger(baseline[file]) ? baseline[file] : limit;
    if (lines > allowed) violations.push(`${file}: ${lines} lines (baseline ${allowed})`);
  }

  // A ratchet only ratchets if something tightens it. Enforced on the full sweep
  // only: an incremental run legitimately sees a subset, and failing a developer's
  // working tree for shrinking a file would be hostile. A deliberate gate run is
  // where drift should surface, and the fix is one number.
  if (all) {
    const drift = [];
    for (const [file, recorded] of Object.entries(baseline)) {
      const absolute = path.join(projectRoot, file);
      if (!fs.existsSync(absolute)) {
        drift.push(`${file}: baselined but no longer on disk. Remove the entry.`);
        continue;
      }
      const lines = countLines(fs.readFileSync(absolute, 'utf8'));
      if (lines < limit) {
        drift.push(`${file}: ${lines} lines, now under the ${limit}-line limit. Remove the entry — it no longer needs one.`);
      } else if (lines < recorded) {
        drift.push(`${file}: ${lines} lines against a baseline of ${recorded}. Lower it to ${lines}, or the file may silently grow back.`);
      }
    }
    if (drift.length) violations.push(...drift);
  }

  if (violations.length) {
    console.error(`Source file size gate failed for ${violations.length} file(s):\n${violations.join('\n')}`);
    return 1;
  }

  // A full sweep that matches nothing is a broken walk, not a clean repository.
  // The incremental mode legitimately inspects zero files on an unchanged tree;
  // `--all` never should, and reporting "passed" when it does is how this gate
  // stayed a no-op in CI.
  if (all && sourceFiles.length === 0) {
    console.error('Source file size gate matched no source files in --all mode; check the walk roots.');
    return 1;
  }

  const mode = all ? 'full sweep' : 'changed files';
  console.log(`Source file size gate passed (${mode}: ${sourceFiles.length} source file(s) checked; new-file limit ${limit}; legacy baselines enforced; tests and __fixtures__ exempt).`);
  return 0;
}

const modulePath = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === modulePath) process.exit(main());
