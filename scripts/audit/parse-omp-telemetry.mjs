#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { applyAdvisorEvent, applyMainEvent, createMainScanState, createTelemetrySkeleton } from './omp-telemetry-events.mjs';

export async function extractTelemetry({
  mainJsonlPath = process.env.OMP_PRIMARY_JSONL,
  advisorJsonlPath = process.env.OMP_ADVISOR_JSONL,
  folderPath = process.env.OMP_SESSION_FOLDER,
} = {}) {
  if (![mainJsonlPath, advisorJsonlPath, folderPath].every((value) => typeof value === 'string' && value.length > 0)) {
    throw new Error('Telemetry requires explicit primary, advisor and session-folder paths.');
  }
  const telemetry = createTelemetrySkeleton();

  // 1. Parse Main Session JSONL
  const mainStream = fs.createReadStream(mainJsonlPath);
  const mainRl = readline.createInterface({ input: mainStream, crlfDelay: Infinity });

  const state = createMainScanState();
  const { bashCounts, readCounts, editCounts, writeCounts } = state;

  for await (const line of mainRl) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line);
      applyMainEvent(telemetry, state, obj);

    } catch (e) {}
  }

  // 2. Churn calculations
  const totalBash = Object.values(bashCounts).reduce((a, b) => a + b, 0);
  const uniqueBash = Object.keys(bashCounts).length;
  telemetry.churn.bash = {
    total: totalBash,
    unique: uniqueBash,
    repeatRatePct: totalBash ? +(((totalBash - uniqueBash) / totalBash) * 100).toFixed(2) : 0,
    topCommands: Object.entries(bashCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([cmd, count]) => ({ count, cmd })),
  };

  const totalReads = Object.values(readCounts).reduce((a, b) => a + b, 0);
  const uniqueReads = Object.keys(readCounts).length;
  telemetry.churn.reads = {
    total: totalReads,
    unique: uniqueReads,
    repeatRatePct: totalReads ? +(((totalReads - uniqueReads) / totalReads) * 100).toFixed(2) : 0,
    topFiles: Object.entries(readCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([path, count]) => ({ count, path })),
  };

  const totalEdits = Object.values(editCounts).reduce((a, b) => a + b, 0);
  const uniqueEdits = Object.keys(editCounts).length;
  telemetry.churn.edits = {
    total: totalEdits,
    unique: uniqueEdits,
    failedCount: telemetry.tools.errorsByName['edit'] || 0,
    topFiles: Object.entries(editCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([path, count]) => ({ count, path })),
  };

  const totalWrites = Object.values(writeCounts).reduce((a, b) => a + b, 0);
  const uniqueWrites = Object.keys(writeCounts).length;
  telemetry.churn.writes = {
    total: totalWrites,
    unique: uniqueWrites,
    topFiles: Object.entries(writeCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([path, count]) => ({ count, path })),
  };

  // Efficiency metrics
  telemetry.tools.errorRatePct = telemetry.tools.totalResults
    ? +((telemetry.tools.totalErrors / telemetry.tools.totalResults) * 100).toFixed(2)
    : 0;
  telemetry.tokensAndEfficiency.thinkingToTextRatioChars = telemetry.tokensAndEfficiency.textCharacters
    ? +(telemetry.tokensAndEfficiency.thinkingCharacters / telemetry.tokensAndEfficiency.textCharacters).toFixed(2)
    : 0;
  telemetry.tokensAndEfficiency.reasoningToOutputTokenPct = telemetry.tokensAndEfficiency.totalOutputTokens
    ? +(
        (telemetry.tokensAndEfficiency.totalReasoningTokens /
          telemetry.tokensAndEfficiency.totalOutputTokens) *
        100
      ).toFixed(2)
    : 0;

  if (telemetry.session.startTime && telemetry.session.endTime) {
    const diffMs =
      new Date(telemetry.session.endTime).getTime() - new Date(telemetry.session.startTime).getTime();
    telemetry.session.durationHours = +(diffMs / (1000 * 60 * 60)).toFixed(2);
  }

  // 3. Parse Advisor JSONL
  if (fs.existsSync(advisorJsonlPath)) {
    const advStream = fs.createReadStream(advisorJsonlPath);
    const advRl = readline.createInterface({ input: advStream, crlfDelay: Infinity });

    for await (const line of advRl) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line);
        applyAdvisorEvent(telemetry, obj);
      } catch (e) {}
    }
  }

  // 4. Parse Subagent Directory
  if (fs.existsSync(folderPath)) {
    const files = fs.readdirSync(folderPath);
    const subagentMap = new Map();

    for (const f of files) {
      if (f === '__advisor.jsonl') continue;
      const ext = path.extname(f);
      if (ext === '.jsonl' || ext === '.md') {
        const base = path.basename(f, ext);
        if (!subagentMap.has(base)) {
          subagentMap.set(base, { name: base, jsonlSize: 0, mdSize: 0, hasMd: false, hasJsonl: false });
        }
        const s = subagentMap.get(base);
        const stat = fs.statSync(path.join(folderPath, f));
        if (ext === '.jsonl') {
          s.jsonlSize = stat.size;
          s.hasJsonl = true;
          telemetry.subagents.totalFleetSizeMb += stat.size / (1024 * 1024);
        } else if (ext === '.md') {
          s.mdSize = stat.size;
          s.hasMd = true;
        }
      }
    }

    telemetry.subagents.totalSpawnedFiles = files.filter(f => f.endsWith('.jsonl') || f.endsWith('.md')).length - 1; // minus __advisor
    telemetry.subagents.totalUniqueSubagents = subagentMap.size;
    telemetry.subagents.totalFleetSizeMb = +telemetry.subagents.totalFleetSizeMb.toFixed(2);

    for (const [name, s] of subagentMap.entries()) {
      const lower = name.toLowerCase();
      let archetype = 'other';
      if (lower.includes('writer') || (lower.includes('slice') && !lower.includes('review'))) {
        archetype = 'writer';
        telemetry.subagents.archetypes.writers++;
      } else if (lower.includes('review') || lower.includes('check')) {
        archetype = 'reviewer';
        telemetry.subagents.archetypes.reviewers++;
      } else if (lower.includes('scout') || lower.includes('audit')) {
        archetype = 'scout';
        telemetry.subagents.archetypes.scouts++;
      } else {
        archetype = 'other';
        telemetry.subagents.archetypes.others++;
      }
      telemetry.subagents.list.push({ ...s, archetype });
    }
    telemetry.subagents.list.sort((a, b) => b.jsonlSize - a.jsonlSize);
  }

  return telemetry;
}

// CLI execution
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('parse-omp-telemetry.mjs')) {
  extractTelemetry({ mainJsonlPath: process.argv[2] ?? process.env.OMP_PRIMARY_JSONL, advisorJsonlPath: process.argv[3] ?? process.env.OMP_ADVISOR_JSONL, folderPath: process.argv[4] ?? process.env.OMP_SESSION_FOLDER }).then((t) => {
    console.log(JSON.stringify(t, null, 2));
  }).catch((error) => { console.error(error.message); process.exitCode = 1; });
}
