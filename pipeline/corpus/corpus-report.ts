import type { EntryWithChart, Reject } from '@hub/contracts';
import { atomicWriteFile } from '../stage-ledger.js';
import { auditPrivacyFiles } from '../audit-privacy.js';
import type { CrossCheckResult } from '../cross-check.js';
import type { MirrorDemotion } from '../rights/official-mirror.js';
import type { ElectResult } from '../dedup/elect.js';

export type CorpusReportOptions = {
  runId: string;
  reportPath: string;
  entriesPath: string;
  candidateCount: number;
  entriesWithChart: EntryWithChart[];
  rejects: Reject[];
  stageTimes: Record<string, number>;
  totalTime: number;
  electionStats: ElectResult['stats'];
  mirrorDemotion: MirrorDemotion;
  crossCheck: CrossCheckResult;
  officialBodiesMissing: number;
  officialBodiesGone: number;
  audit: boolean;
};

/**
 * STATS & REPORT GENERATION — the run report, and the privacy audit that has the
 * last word on whether the run is allowed to succeed. The audit reads the
 * entries and the report it just wrote, so it must run after both exist.
 */
export async function writeCorpusReport(options: CorpusReportOptions): Promise<{ privacyOk: boolean }> {
  const {
    runId,
    reportPath,
    entriesPath,
    candidateCount,
    entriesWithChart,
    rejects,
    stageTimes,
    totalTime,
    electionStats,
    mirrorDemotion,
    crossCheck: crossCheckRes,
    officialBodiesMissing,
    officialBodiesGone,
    audit,
  } = options;

  // Integration frequency
  const integrationCounts: Record<string, number> = {};
  const gradeCounts: Record<string, number> = { LOW: 0, MEDIUM: 0, HIGH: 0, CRITICAL: 0, UNKNOWN: 0 };
  const sourceStats: Record<string, { total: number; canonical: number; redistributable: number; linkOnly: number }> = {};
  const rightsCounts: Record<string, number> = { redistributable: 0, link_only: 0 };
  const rejectReasonCounts: Record<string, number> = {};

  for (const { entry } of entriesWithChart) {
    // Integration stats
    for (const tag of entry.tags) {
      integrationCounts[tag] = (integrationCounts[tag] || 0) + 1;
    }
    // Grade stats
    const g = entry.security?.grade || 'UNKNOWN';
    gradeCounts[g] = (gradeCounts[g] || 0) + 1;

    // Rights stats
    const r = entry.rights.status;
    rightsCounts[r] = (rightsCounts[r] || 0) + 1;

    // Source stats
    const sKey = entry.source.kind === 'n8n_official' ? 'n8n_official' : entry.source.repo || 'unknown';
    if (!sourceStats[sKey]) {
      sourceStats[sKey] = { total: 0, canonical: 0, redistributable: 0, linkOnly: 0 };
    }
    sourceStats[sKey].total += 1;
    if (entry.dedup.canonical) sourceStats[sKey].canonical += 1;
    if (entry.rights.status === 'redistributable') sourceStats[sKey].redistributable += 1;
    else sourceStats[sKey].linkOnly += 1;
  }

  for (const r of rejects) {
    rejectReasonCounts[r.reason] = (rejectReasonCounts[r.reason] || 0) + 1;
  }

  const topIntegrations = Object.entries(integrationCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 30);

  const reportMarkdown = `# Corpus Build Report — ${runId}

**Date:** ${new Date().toISOString()}  
**Run ID:** \`${runId}\`  
**Total Candidates:** ${candidateCount}  
**Total Canonicals:** ${electionStats.canonicals}  
**Total Wall-Clock Time:** ${totalTime} ms  

## Stage Timings

| Stage | Time (ms) |
| --- | ---: |
| Acquire | ${stageTimes['acquire'] ?? 0} |
| Rights | ${stageTimes['rights'] ?? 0} |
| Sanitize | ${stageTimes['sanitize'] ?? 0} |
| Scan | ${stageTimes['scan'] ?? 0} |
| Dedup | ${stageTimes['dedup'] ?? 0} |

## Source Breakdown

| Source | Candidates | Canonicals | Redistributable | Link-Only |
| --- | ---: | ---: | ---: | ---: |
${Object.entries(sourceStats)
  .map(([k, v]) => `| \`${k}\` | ${v.total} | ${v.canonical} | ${v.redistributable} | ${v.linkOnly} |`)
  .join('\n')}

## Official Library

- **Templates dropped for want of a workflow body:** ${officialBodiesMissing}
- **Of those, deleted upstream (API 404):** ${officialBodiesGone}
- **Structural groups containing an official template:** ${mirrorDemotion.groups}
- **Redistributable copies demoted to link-only as official mirrors:** ${mirrorDemotion.demoted}

## Rights Breakdown

- **Redistributable:** ${rightsCounts.redistributable} (${((rightsCounts.redistributable / (candidateCount || 1)) * 100).toFixed(1)}%)
- **Link-Only:** ${rightsCounts.link_only} (${((rightsCounts.link_only / (candidateCount || 1)) * 100).toFixed(1)}%)

## Security Grade Distribution

| Grade | Count | Percentage |
| --- | ---: | ---: |
${Object.entries(gradeCounts)
  .map(([g, count]) => `| ${g} | ${count} | ${((count / (candidateCount || 1)) * 100).toFixed(1)}% |`)
  .join('\n')}

## Deduplication Collapse

- **Total Candidates:** ${electionStats.candidates}
- **Exact Duplicates:** ${electionStats.exactDuplicates}
- **Structural Duplicates:** ${electionStats.structuralDuplicates}
- **Canonicals:** ${electionStats.canonicals}
- **Collapse Ratio:** ${(((1 - electionStats.canonicals / (electionStats.candidates || 1))) * 100).toFixed(1)}%

## Top 30 Integrations

| Integration | Count |
| --- | ---: |
${topIntegrations.map(([name, count]) => `| \`${name}\` | ${count} |`).join('\n')}

## Parse & Scan Failures

| Reason Code | Count |
| --- | ---: |
${Object.entries(rejectReasonCounts).length > 0
  ? Object.entries(rejectReasonCounts).map(([code, count]) => `| \`${code}\` | ${count} |`).join('\n')
  : '| None | 0 |'}

## Cross-Check Orphan Analysis (Legacy Harvest)

- **Total Vault Core Files:** ${crossCheckRes.totalVaultFiles}
- **Matched in Run:** ${crossCheckRes.matchedCount}
- **Orphans (Not in Run):** ${crossCheckRes.orphanCount}

| Prefix | Total Vault Files | Matched | Orphan |
| --- | ---: | ---: | ---: |
${Object.entries(crossCheckRes.prefixCounts)
  .map(([prefix, stats]) => `| \`${prefix}\` | ${stats.total} | ${stats.matched} | ${stats.orphan} |`)
  .join('\n')}
`;

  await atomicWriteFile(reportPath, reportMarkdown);

  let privacyOk = true;
  if (audit) {
    const auditRes = await auditPrivacyFiles([entriesPath, reportPath]);
    privacyOk = auditRes.ok;
    if (!privacyOk) {
      throw new Error(`Privacy audit failed with ${auditRes.hits.length} hit(s)`);
    }
  }

  return { privacyOk };
}
