import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { auditPublicRepoFiles } from './lib/public-repo-content-safety.mjs';
import { materializePublicRepositoryFromManifest } from './lib/public-repo-materializer.mjs';
import { compare as compareStable, issue, sortIssues } from './lib/public-repo-materializer-common.mjs';
import { DEFAULT_PUBLIC_ALLOWLIST, DEFAULT_PUBLIC_EXCLUSIONS, PUBLIC_REPO_FAIL_CLOSED_PATHS, findMissingRequiredPaths, STRUCTURAL_GAPS } from './lib/public-repo-allowlist.mjs';
import { applyContentExemptions, loadContentExemptions } from './lib/public-repo-exemptions.mjs';
import { buildIssueClassificationReport, renderIssueClassificationMarkdown, renderIssueClassificationSummary } from './lib/public-repo-issue-report.mjs';
import { checkAllowlistEntriesExist, normaliseAllowlist, normaliseRelative, walkRepositoryTree } from './lib/public-repo-walker.mjs';

export { verifyPublicRepositoryMaterialization } from './lib/public-repo-materializer.mjs';
export { DEFAULT_PUBLIC_ALLOWLIST, findMissingRequiredPaths, PHASE7_REQUIRED_TREE, STRUCTURAL_GAPS } from './lib/public-repo-allowlist.mjs';

const TARGET_REPOSITORY = 'n8n-Secureflow';
const SCHEMA_VERSION = 'public-repository-extraction-v1';
const REPORT_RELATIVE_PATH = path.join('docs', 'public-repository', 'EXTRACTION-ISSUES.md');

function requiredTreeIssues(root, enforceRequiredTree) {
  if (!enforceRequiredTree) return { requiredMissing: [], structuralGaps: [], issues: [] };
  const requiredMissing = findMissingRequiredPaths(root);
  const missingPaths = new Set(requiredMissing.map((entry) => entry.path));
  const structuralGaps = STRUCTURAL_GAPS.filter((gap) => missingPaths.has(gap.requiredPath));
  const issues = [
    ...requiredMissing.map((entry) => issue('missing-required-path', entry.path, entry.description)),
    ...structuralGaps.map((gap) => issue('structural-gap', gap.requiredPath, `${gap.description} (existing: ${gap.existingPath})`)),
  ];
  return { requiredMissing, structuralGaps, issues };
}

function removeFailClosedFiles(files, issues, reportIssues) {
  const kept = [];
  for (const file of files) {
    const denied = PUBLIC_REPO_FAIL_CLOSED_PATHS.find((entry) => file.path === entry || file.path.startsWith(`${entry}/`));
    if (denied) {
      if (reportIssues) issues.push(issue('denied-path', file.path, 'credential or deployment material is never eligible for extraction'));
    } else kept.push(file);
  }
  files.splice(0, files.length, ...kept);
}

export function buildPublicRepositoryManifest({
  repositoryRoot, allowlist = DEFAULT_PUBLIC_ALLOWLIST, targetRepository = TARGET_REPOSITORY,
  contentExemptions, enforceRequiredTree = allowlist === DEFAULT_PUBLIC_ALLOWLIST, selectedOnly = false,
} = {}) {
  const issues = [];
  const files = [];
  const normalisedAllowlist = normaliseAllowlist(allowlist, issues);
  const root = path.resolve(repositoryRoot ?? process.cwd());
  let rootStats;
  try { rootStats = fs.lstatSync(root); } catch { issues.push(issue('missing-repository-root', '.', 'repository root does not exist')); }
  if (rootStats?.isSymbolicLink()) issues.push(issue('symlink-repository-root', '.', 'repository root must not be a symlink'));
  else if (rootStats && !rootStats.isDirectory()) issues.push(issue('invalid-repository-root', '.', 'repository root must be a directory'));
  if (rootStats?.isDirectory()) {
    checkAllowlistEntriesExist(root, normalisedAllowlist, issues);
    walkRepositoryTree(root, normalisedAllowlist, files, issues, { excludedPaths: DEFAULT_PUBLIC_EXCLUSIONS, selectedOnly });
    removeFailClosedFiles(files, issues, allowlist !== DEFAULT_PUBLIC_ALLOWLIST);
  }
  files.sort((a, b) => compareStable(a.path, b.path));

  const rawFindings = auditPublicRepoFiles(files.map(({ path: file }) => path.resolve(root, file)))
    .findings.map((finding) => ({ ...finding, path: path.relative(root, finding.path).replace(/\\/g, '/') }));
  const exemptionSource = contentExemptions ?? loadContentExemptions().exemptions;
  const { remaining, suppressed, stale } = applyContentExemptions(rawFindings, exemptionSource);
  for (const finding of remaining) issues.push(issue('unsafe-content', finding.path, `${finding.rule} at ${finding.line}:${finding.column}`));

  const { requiredMissing, structuralGaps, issues: requiredTreeIssueList } = requiredTreeIssues(root, enforceRequiredTree);
  issues.push(...requiredTreeIssueList);

  sortIssues(issues);
  return {
    schemaVersion: SCHEMA_VERSION, targetRepository, allowlist: normalisedAllowlist, files, issues, ok: issues.length === 0,
    requiredMissing, structuralGaps, contentExemptionSummary: { appliedCount: suppressed.length, stale },
  };
}
export function materializePublicRepository(options = {}) {
  return materializePublicRepositoryFromManifest({ ...options, manifest: buildPublicRepositoryManifest(options) });
}
export function validatePublicRepositoryManifest(manifest) {
  const errors = [];
  if (!manifest || manifest.schemaVersion !== SCHEMA_VERSION) errors.push('unsupported schemaVersion');
  if (!manifest || typeof manifest.targetRepository !== 'string' || manifest.targetRepository.length === 0) errors.push('targetRepository is required');
  for (const field of ['allowlist', 'files', 'issues']) if (!Array.isArray(manifest?.[field])) errors.push(`${field} must be an array`);
  if (!Array.isArray(manifest?.allowlist) || manifest.allowlist.some((item) => normaliseRelative(item) !== item)) errors.push('allowlist contains a non-normalized path');
  if (Array.isArray(manifest?.allowlist) && manifest.allowlist.join('\0') !== [...manifest.allowlist].sort(compareStable).join('\0')) errors.push('allowlist is not sorted');
  if (Array.isArray(manifest?.files)) {
    const paths = manifest.files.map((file) => file?.path);
    if (paths.some((item) => typeof item !== 'string' || normaliseRelative(item) !== item)) errors.push('files contain an invalid path');
    if (paths.join('\0') !== [...paths].sort(compareStable).join('\0')) errors.push('files are not sorted');
    if (new Set(paths).size !== paths.length) errors.push('files contain duplicates');
    for (const file of manifest.files) if (!Number.isInteger(file?.size) || file.size < 0 || !/^[a-f0-9]{64}$/.test(file?.sha256 ?? '')) errors.push(`invalid file record: ${file?.path ?? '<unknown>'}`);
  }
  if (Array.isArray(manifest?.issues)) {
    const serialised = manifest.issues.map((item) => `${item?.code}\0${item?.path}\0${item?.message}`);
    if (serialised.join('\0') !== [...serialised].sort(compareStable).join('\0')) errors.push('issues are not sorted');
    for (const item of manifest.issues) if (!item || typeof item.code !== 'string' || typeof item.path !== 'string' || typeof item.message !== 'string') errors.push('invalid issue record');
  }
  if (typeof manifest?.ok !== 'boolean' || manifest.ok !== (manifest.issues?.length === 0)) errors.push('ok does not match issues');
  return { ok: errors.length === 0, errors: [...new Set(errors)] };
}
export function renderPublicRepositoryManifest(manifest, { json = false } = {}) {
  if (json) return `${JSON.stringify(manifest, null, 2)}\n`;
  if (manifest.destinationRoot) return `${manifest.materialized ? 'materialized' : 'not materialized'} extraction for ${manifest.targetRepository}: ${manifest.files.length} file(s), ${manifest.issues.length} issue(s)\n`;
  return `${manifest.ok ? 'valid' : 'invalid'} extraction manifest for ${manifest.targetRepository}: ${manifest.files.length} file(s), ${manifest.issues.length} issue(s)\n`;
}
function writeIssueClassificationReport(root, manifest) {
  const report = buildIssueClassificationReport({
    manifest, requiredMissing: manifest.requiredMissing, structuralGaps: manifest.structuralGaps, exemptionSummary: manifest.contentExemptionSummary,
  });
  const destination = path.resolve(root, REPORT_RELATIVE_PATH);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, renderIssueClassificationMarkdown(report));
  return report;
}
export function runPublicRepositoryExtractionCli(argv, env = process.env) {
  const options = { repositoryRoot: env.PUBLIC_REPO_ROOT ?? process.cwd(), allowlist: DEFAULT_PUBLIC_ALLOWLIST, targetRepository: TARGET_REPOSITORY, destinationRoot: null, json: false, selectedOnly: false };
  const customAllowlist = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--json') options.json = true;
    else if (argument === '--selected-only') options.selectedOnly = true;
    else if (argument === '--root' && argv[index + 1]) options.repositoryRoot = argv[++index];
    else if (argument.startsWith('--root=')) options.repositoryRoot = argument.slice(7);
    else if (argument === '--allow' && argv[index + 1]) customAllowlist.push(argv[++index]);
    else if (argument.startsWith('--allow=')) customAllowlist.push(argument.slice(8));
    else if (argument === '--target' && argv[index + 1]) options.targetRepository = argv[++index];
    else if (argument.startsWith('--target=')) options.targetRepository = argument.slice(9);
    else if ((argument === '--materialize' || argument === '--destination') && argv[index + 1]) options.destinationRoot = argv[++index];
    else if (argument.startsWith('--materialize=')) { if (argument.length === 13) return { exitCode: 2, stdout: '', stderr: 'missing value for --materialize\n' }; options.destinationRoot = argument.slice(13); }
    else if (argument.startsWith('--destination=')) { if (argument.length === 14) return { exitCode: 2, stdout: '', stderr: 'missing value for --destination\n' }; options.destinationRoot = argument.slice(14); }
    else return { exitCode: 2, stdout: '', stderr: `unknown option: ${argument}\n` };
  }
  if (customAllowlist.length > 0) options.allowlist = customAllowlist;
  const manifest = options.destinationRoot ? materializePublicRepository(options) : buildPublicRepositoryManifest(options);
  let stdout = renderPublicRepositoryManifest(manifest, options);
  if (!options.json && !options.destinationRoot) {
    const report = writeIssueClassificationReport(path.resolve(options.repositoryRoot), manifest);
    stdout += renderIssueClassificationSummary(report);
  }
  return { exitCode: manifest.ok ? 0 : 1, stdout, stderr: '' };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = runPublicRepositoryExtractionCli(process.argv.slice(2));
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  process.exitCode = result.exitCode;
}
