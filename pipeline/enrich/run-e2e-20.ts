import * as fs from 'node:fs';
import * as path from 'node:path';
import { describeEntries } from './describe';
import { deriveStructure } from '../derive/structure';
import type { Entry } from '@hub/contracts';

// This script used to carry its own copy of structure derivation, which drifted:
// it counted sticky notes, banded complexity on different thresholds, and had a
// hand-maintained integration stop-list. A second implementation of a published
// metric is a second set of numbers, so it now calls the real one.

async function runE2E() {
  const dir = 'D:/projects/n8n-vault-core/templates';
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).slice(0, 20);

  const entries: Entry[] = files.map((file, idx) => {
    const filePath = path.join(dir, file);
    const content = fs.readFileSync(filePath, 'utf-8');
    let json: any = {};
    try {
      json = JSON.parse(content);
    } catch {}

    const rawTitle = json.name || file.replace(/^official__\d+_/, '').replace(/\.json$/, '').replace(/_/g, ' ');
    const structure = deriveStructure(json);

    return {
      id: `e2e-real-${idx + 1}`,
      slug: `e2e-real-${idx + 1}`,
      title: rawTitle,
      summary: '',
      description: '',
      descriptionSource: 'fallback',
      source: { kind: 'n8n_official', permalink: `https://n8n.io/workflows/${idx}`, fetchedAt: '2026-08-13' },
      rights: { status: 'link_only', licence: null, licenceUrl: null, reason: 'Official template' },
      structure,
      security: {
        grade: 'LOW',
        score: 0,
        counts: { critical: 0, high: 0, medium: 0, low: 0, info: 0 },
        findings: [],
        hardenedExtra: 0,
        scannerVersion: '1.0',
        profile: 'beta-default',
      },
      tags: structure.integrations,
      dedup: { fingerprint: `fp-${idx}`, structuralHash: `sh-${idx}`, canonical: true, alsoFoundIn: [] },
    };
  });

  const checkpointPath = path.resolve(process.cwd(), 'pipeline/enrich/.e2e-checkpoint.json');
  if (fs.existsSync(checkpointPath)) fs.unlinkSync(checkpointPath);

  console.log(`Starting real end-to-end run of ${entries.length} entries through omp (Gemini 3.6 Flash)...`);
  const systemPromptPath = path.resolve(process.cwd(), 'pipeline/enrich/describe-system.txt');

  const result = await describeEntries(entries, {
    systemPromptPath,
    checkpointPath,
    model: 'google-antigravity/gemini-3.7-flash',
    batchSize: 5,
    concurrency: 2,
    maxFallbackRate: 0.5, // allow batch observation
  });

  console.log('\n========================================');
  console.log('=== REAL E2E BATCH RESULTS ===');
  console.log('========================================');
  console.log(`Total entries: ${result.stats.total}`);
  console.log(`Passed validation first try: ${result.stats.passedFirstTry}`);
  console.log(`Needed retry: ${result.stats.neededRetry}`);
  console.log(`Fell back: ${result.stats.fellBack}`);
  console.log(`Wall clock time: ${result.stats.wallClockMs} ms (${(result.stats.wallClockMs / 1000).toFixed(2)} s)`);
  console.log('\n--- VERBATIM EXAMPLE DESCRIPTION 1 ---');
  if (result.stats.exampleDescriptions[0]) {
    console.log(`ID: ${result.stats.exampleDescriptions[0].id}`);
    console.log(`SUMMARY: ${result.stats.exampleDescriptions[0].summary}`);
    console.log(`DESCRIPTION:\n${result.stats.exampleDescriptions[0].description}`);
  }
  console.log('\n--- VERBATIM EXAMPLE DESCRIPTION 2 ---');
  if (result.stats.exampleDescriptions[1]) {
    console.log(`ID: ${result.stats.exampleDescriptions[1].id}`);
    console.log(`SUMMARY: ${result.stats.exampleDescriptions[1].summary}`);
    console.log(`DESCRIPTION:\n${result.stats.exampleDescriptions[1].description}`);
  }
  console.log('========================================\n');
}

runE2E().catch((err) => {
  console.error('E2E run failed:', err);
  process.exit(1);
});
