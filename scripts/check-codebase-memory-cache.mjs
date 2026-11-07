import { execFileSync } from 'node:child_process';
import {
  readdirSync,
  statSync,
  statfsSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_CACHE_DIR = join(homedir(), '.cache', 'codebase-memory-mcp');
const MEBIBYTE = 1024 * 1024;
const GIBIBYTE = 1024 * MEBIBYTE;

function readProcessCount() {
  if (process.platform !== 'win32') return null;
  try {
    const output = execFileSync(
      'tasklist.exe',
      ['/FI', 'IMAGENAME eq codebase-memory-mcp.exe', '/FO', 'CSV', '/NH'],
      { encoding: 'utf8', windowsHide: true },
    );
    return output.split(/\r?\n/).filter((line) => (
      /"codebase-memory-mcp\.exe"/i.test(line)
    )).length;
  } catch {
    return null;
  }
}

function readFreeBytes(cacheDir) {
  try {
    const stats = statfsSync(cacheDir);
    return Number(stats.bavail) * Number(stats.bsize);
  } catch {
    return null;
  }
}

function envNumber(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

export function collectCacheReport({
  cacheDir = process.env.CBM_CACHE_DIR || DEFAULT_CACHE_DIR,
  freeBytes = readFreeBytes(cacheDir),
  processCount = readProcessCount(),
} = {}) {
  const directory = resolve(cacheDir);
  let names;
  try {
    names = readdirSync(directory);
  } catch (error) {
    return {
      cacheDir: directory,
      exists: false,
      error: error.code || 'read_failed',
      freeBytes,
      processCount,
      walFiles: [],
      totalWalBytes: 0,
    };
  }

  const walFiles = names
    .filter((name) => name.toLowerCase().endsWith('.db-wal'))
    .map((name) => {
      const filePath = join(directory, name);
      try {
        return { name, bytes: statSync(filePath).size };
      } catch {
        return { name, bytes: null };
      }
    })
    .sort((left, right) => left.name.localeCompare(right.name));

  return {
    cacheDir: directory,
    exists: true,
    error: null,
    freeBytes,
    processCount,
    walFiles,
    totalWalBytes: walFiles.reduce(
      (total, file) => total + (file.bytes || 0),
      0,
    ),
  };
}

export function evaluateCacheReport(report, {
  warnWalBytes = 512 * MEBIBYTE,
  failWalBytes = GIBIBYTE,
  maxProcessCount = 8,
  minFreeBytes = 10 * GIBIBYTE,
} = {}) {
  const reasons = [];
  const warnings = [];

  if (!report.exists) reasons.push(`cache directory unavailable: ${report.error}`);
  if (report.walFiles.some((file) => file.bytes === null)) {
    reasons.push('WAL size unavailable');
  }
  if (report.processCount === null) {
    reasons.push('MCP process count unavailable');
  }
  if (report.freeBytes === null) {
    reasons.push('cache volume free space unavailable');
  }
  if (report.totalWalBytes >= failWalBytes) {
    reasons.push('WAL exceeds hard threshold');
  } else if (report.totalWalBytes >= warnWalBytes) {
    warnings.push('WAL exceeds warning threshold');
  }
  if (report.processCount !== null && report.processCount > maxProcessCount) {
    reasons.push('too many MCP processes');
  }
  if (report.freeBytes !== null && report.freeBytes < minFreeBytes) {
    reasons.push('cache volume is low on free space');
  }

  return { ok: reasons.length === 0, reasons, warnings };
}

function formatBytes(bytes) {
  return bytes === null ? 'unknown' : `${bytes} bytes`;
}

export function formatCacheReport(report, result = null) {
  const lines = [
    `cache: ${report.cacheDir}`,
    `exists: ${report.exists}`,
    `free: ${formatBytes(report.freeBytes)}`,
    `MCP processes: ${report.processCount ?? 'unknown'}`,
    `total WAL: ${formatBytes(report.totalWalBytes)}`,
  ];
  for (const file of report.walFiles) {
    lines.push(`  ${file.name}: ${formatBytes(file.bytes)}`);
  }
  if (result?.warnings.length) lines.push(`warnings: ${result.warnings.join('; ')}`);
  if (result?.reasons.length) lines.push(`failures: ${result.reasons.join('; ')}`);
  return lines.join('\n');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const report = collectCacheReport();
  const result = evaluateCacheReport(report, {
    warnWalBytes: envNumber('CBM_WAL_WARN_BYTES', 512 * MEBIBYTE),
    failWalBytes: envNumber('CBM_WAL_FAIL_BYTES', GIBIBYTE),
    maxProcessCount: envNumber('CBM_MAX_PROCESSES', 8),
    minFreeBytes: envNumber('CBM_MIN_FREE_BYTES', 10 * GIBIBYTE),
  });
  console.log(formatCacheReport(report, result));
  process.exitCode = result.ok ? 0 : 1;
}
