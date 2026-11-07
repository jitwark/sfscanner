import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const outDir = path.join(root, 'app', 'out');
// GitHub Pages publishes at most 1 GB and fails a deployment that takes over
// ten minutes (verified against the Pages limits documentation, 2026-08-25).
// `bytes` is the budget that matters, and it is deliberately set below the
// host's ceiling so this gate fails before the host does.
const PAGES_CEILING = 1024 * 1024 * 1024;

const limits = {
  // Raised 2026-08-26. Two measured changes:
  //
  //  - Publication stopped asking about redistribution rights, so hubs admit
  //    12,923 entries rather than 287 and tag pagination went from ~52 pages to
  //    982. That is the path a crawler takes into the long tail, so it stays.
  //  - Every workflow gets a page (see `scripts/generate-lean-pages.tsx`),
  //    which is ~13,000 more files at roughly 23 KB each.
  //
  // Measured after both: 470 MB and 7,990 files before the lean pages, about
  // 760 MB and 21,000 after. The caps leave roughly a quarter of the Pages
  // ceiling free for corpus growth. Re-derive with `du -sm app/out` before
  // moving them again.
  files: Number(process.env.EXPORT_MAX_FILES ?? 25_000),
  bytes: Number(process.env.EXPORT_MAX_BYTES ?? 900 * 1024 * 1024),
  htmlBytes: Number(process.env.EXPORT_MAX_HTML_BYTES ?? 560_000_000),
  largestDataBytes: Number(process.env.EXPORT_MAX_DATA_FILE_BYTES ?? 40 * 1024 * 1024),
};

if (limits.bytes >= PAGES_CEILING) {
  console.error(`Export budget misconfigured: bytes ${limits.bytes} is at or above the 1 GB GitHub Pages ceiling.`);
  process.exit(1);
}

if (!fs.existsSync(outDir)) {
  console.error('Export budget gate failed: app/out does not exist.');
  process.exit(1);
}
let files = 0;
let bytes = 0;
let htmlBytes = 0;
let largestData = { path: '', bytes: 0 };
const rawWorkflowFiles = [];
function walk(directory) {
  for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, item.name);
    if (item.isDirectory()) { walk(absolute); continue; }
    const size = fs.statSync(absolute).size;
    const relative = path.relative(outDir, absolute).replaceAll(path.sep, '/');
    files++;
    bytes += size;
    if (relative.endsWith('.html')) htmlBytes += size;
    if (relative.startsWith('data/') && size > largestData.bytes) largestData = { path: relative, bytes: size };
    if (/data\/(?:raw|workflows?)\/.*\.json(?:l)?$/i.test(relative)) rawWorkflowFiles.push(relative);
  }
}
walk(outDir);
const failures = [];
if (files > limits.files) failures.push(`files ${files} > ${limits.files}`);
if (bytes > limits.bytes) failures.push(`bytes ${bytes} > ${limits.bytes}`);
if (htmlBytes > limits.htmlBytes) failures.push(`HTML bytes ${htmlBytes} > ${limits.htmlBytes}`);
if (largestData.bytes > limits.largestDataBytes) failures.push(`largest data ${largestData.path} (${largestData.bytes}) > ${limits.largestDataBytes}`);
if (rawWorkflowFiles.length) failures.push(`raw workflow JSON surfaced in export: ${rawWorkflowFiles.slice(0, 3).join(', ')}`);
if (failures.length) {
  console.error(`Export budget gate failed:\n- ${failures.join('\n- ')}`);
  process.exit(1);
}
console.log(`Export budget passed: ${files} files, ${bytes} bytes, ${htmlBytes} HTML bytes.`);
