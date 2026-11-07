/**
 * SCAN-4 — run both scanner profiles over a corpus and report observations.
 *
 * Read-only over the supplied corpus. Output lands in `pipeline/.work/`, which is gitignored.
 *
 *   npx tsx pipeline/validate-scanner.ts [--corpus <dir>] [--limit N] [--profile P]
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { join, resolve } from 'node:path';
import { DEFAULT_SCANNER_LIMITS, toWorkflowParseOptions } from '@hub/contracts';
import { parseWorkflowJson } from '@hub/scanner-core/workflow';
import { SCANNER_VERSION } from '@hub/scanner-core/scanner-version';
import { scanWorkflowWithCore } from './scan/scanner-core-adapter.js';

type Profile = 'beta-default' | 'beta-hardened';
const PROFILES: Profile[] = ['beta-default', 'beta-hardened'];

type ProfileReport = {
  profile: Profile;
  scanned: number;
  crashes: Array<{ file: string; message: string }>;
  grades: Record<string, number>;
  policyCounts: Record<string, number>;
  findingTitles: Record<string, string>;
  examples: Record<string, string[]>;
  durationsMs: number[];
  heapDeltasBytes: number[];
};

type Report = {
  generatedAt: string;
  corpusRoot: string;
  scannerVersion: string;
  deviceProfile: string;
  totalFiles: number;
  invalidUtf8Files: number;
  byteSizes: number[];
  parseFailures: Array<{ file: string; code: string; message: string }>;
  profiles: ProfileReport[];
};

function args(): { corpus: string; limit: number; only: Profile[] } {
  const argv = process.argv.slice(2);
  const get = (flag: string): string | undefined => {
    const index = argv.indexOf(flag);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const rawLimit = get('--limit');
  const limit = Number(rawLimit ?? Number.MAX_SAFE_INTEGER);
  const profile = get('--profile');
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('--limit must be a positive integer');
  if (profile && !PROFILES.includes(profile as Profile)) throw new Error(`Unsupported --profile: ${profile}`);
  return { corpus: get('--corpus') ?? 'D:/projects/n8n-vault-core/templates', limit, only: profile ? [profile as Profile] : PROFILES };
}

function scannerVersion(): typeof SCANNER_VERSION { return SCANNER_VERSION; }

function deviceProfile(): string {
  const cpu = cpus()[0]?.model?.replace(/\s+/g, ' ').trim() || 'unknown CPU';
  return `Node.js ${process.versions.node} · ${process.platform}/${process.arch} · ${cpu}`;
}

function bump(counter: Record<string, number>, key: string): void { counter[key] = (counter[key] ?? 0) + 1; }

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return Number((sorted[index] ?? 0).toFixed(3));
}

function summary(values: number[]): string {
  const sorted = [...values].sort((a, b) => a - b);
  return `min ${percentile(sorted, 0)} · p50 ${percentile(sorted, 50)} · p95 ${percentile(sorted, 95)} · max ${percentile(sorted, 100)}`;
}

function emptyProfile(profile: Profile): ProfileReport {
  return { profile, scanned: 0, crashes: [], grades: {}, policyCounts: {}, findingTitles: {}, examples: {}, durationsMs: [], heapDeltasBytes: [] };
}

function main(): void {
  let config: ReturnType<typeof args>;
  try { config = args(); } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
    return;
  }
  const { corpus, limit, only } = config;
  const files = readdirSync(corpus).filter((file) => file.endsWith('.json')).sort().slice(0, limit);
  const report: Report = {
    generatedAt: new Date().toISOString(), corpusRoot: corpus, scannerVersion: scannerVersion(), deviceProfile: deviceProfile(),
    totalFiles: files.length, invalidUtf8Files: 0, byteSizes: [], parseFailures: [], profiles: only.map(emptyProfile),
  };
  const decoder = new TextDecoder('utf-8', { fatal: true });

  for (const [index, file] of files.entries()) {
    if (index % 1000 === 0) process.stdout.write(`  ${index}/${files.length}\n`);
    const bytes = readFileSync(join(corpus, file));
    report.byteSizes.push(bytes.byteLength);
    let raw: string;
    try { raw = decoder.decode(bytes); } catch {
      report.invalidUtf8Files += 1;
      report.parseFailures.push({ file, code: 'INVALID_UTF8', message: 'Input is not valid UTF-8.' });
      continue;
    }
    const parsed = parseWorkflowJson(raw, toWorkflowParseOptions(DEFAULT_SCANNER_LIMITS));
    if (!parsed.ok) { report.parseFailures.push({ file, code: parsed.code, message: parsed.message }); continue; }
    for (const profileReport of report.profiles) {
      const started = performance.now();
      const heapBefore = process.memoryUsage().heapUsed;
      try {
        const result = scanWorkflowWithCore(parsed.workflow, { policyProfile: profileReport.profile });
        profileReport.scanned += 1;
        bump(profileReport.grades, result.riskAssessment?.grade ?? 'INDETERMINATE');
        for (const finding of result.findings) {
          bump(profileReport.policyCounts, finding.policyId);
          profileReport.findingTitles[finding.policyId] = finding.title;
          const examples = (profileReport.examples[finding.policyId] ??= []);
          if (examples.length < 3 && !examples.includes(file)) examples.push(file);
        }
      } catch (error) {
        profileReport.crashes.push({ file, message: error instanceof Error ? error.message : String(error) });
      } finally {
        profileReport.durationsMs.push(performance.now() - started);
        profileReport.heapDeltasBytes.push(Math.max(0, process.memoryUsage().heapUsed - heapBefore));
      }
    }
  }

  const outDir = resolve(import.meta.dirname, '.work');
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'scanner-report.json'), `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(join(outDir, 'scanner-report.md'), renderMarkdown(report));
  process.stdout.write(`\nWrote ${outDir}/scanner-report.{json,md}\n`);
}

function renderMarkdown(report: Report): string {
  const lines: string[] = [
    '# Scanner corpus validation', '', `Generated: ${report.generatedAt}`, `Scanner version: \`${report.scannerVersion}\``,
    `Corpus: \`${report.corpusRoot}\``, '', `Files: **${report.totalFiles}** · parse failures: **${report.parseFailures.length}**`, '',
    '## Resource evidence', '', `Device profile: **${report.deviceProfile}**`,
    `Input bytes — ${summary(report.byteSizes)} · invalid UTF-8 files: **${report.invalidUtf8Files}**`, '',
  ];
  const failureCodes: Record<string, number> = {};
  for (const failure of report.parseFailures) bump(failureCodes, failure.code);
  if (report.parseFailures.length > 0) {
    lines.push('## Parse failures by code', '');
    for (const [code, count] of Object.entries(failureCodes).sort((a, b) => b[1] - a[1])) lines.push(`- \`${code}\` — ${count}`);
    lines.push('');
  }
  for (const profile of report.profiles) {
    const top = Object.entries(profile.policyCounts).sort((a, b) => b[1] - a[1]).slice(0, 30);
    lines.push(`## Profile \`${profile.profile}\``, '', `Scanned: **${profile.scanned}** · crashes: **${profile.crashes.length}**`,
      `Duration ms — ${summary(profile.durationsMs)}`, `Observed heap delta bytes — ${summary(profile.heapDeltasBytes)}`,
      '', '### Grade distribution', '');
    for (const [grade, count] of Object.entries(profile.grades).sort((a, b) => b[1] - a[1])) {
      lines.push(`- ${grade}: ${count} (${((count / Math.max(1, profile.scanned)) * 100).toFixed(1)}%)`);
    }
    lines.push('', '### Top 30 findings', '', '| # | policy | title | fired | share | examples |', '| --- | --- | --- | --- | --- | --- |');
    for (const [rank, [policyId, count]] of top.entries()) {
      const examples = (profile.examples[policyId] ?? []).map((example) => `\`${example}\``).join('<br>');
      lines.push(`| ${rank + 1} | \`${policyId}\` | ${profile.findingTitles[policyId] ?? ''} | ${count} | ${((count / Math.max(1, profile.scanned)) * 100).toFixed(1)}% | ${examples} |`);
    }
    lines.push('');
    if (profile.crashes.length > 0) {
      lines.push('### Crashes', '');
      for (const crash of profile.crashes.slice(0, 50)) lines.push(`- \`${crash.file}\` — ${crash.message}`);
      lines.push('');
    }
  }
  lines.push('## False-positive review', '', 'Filled in by SCAN-5. One row per reviewed finding.', '');
  return `${lines.join('\n')}\n`;
}

main();
