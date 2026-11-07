/**
 * Are official security grades comparable to GitHub ones?
 *
 * `build-corpus` stage 3 sanitizes only `redistributable` candidates, and
 * stage 4 scans whatever `json` survives. So GitHub workflows are scanned
 * *after* their secrets are redacted and official workflows are scanned raw.
 * If secret-shaped values drive findings, official entries grade worse for a
 * structural reason rather than a real one — the same family of defect as
 * counting sticky notes as complexity.
 *
 * This scans the same official bodies twice, raw and sanitized, and reports
 * how many published grades move, plus how many inputs on each side could
 * not be graded at all. The measurement itself lives in
 * `sanitize-scan-bias-measure.ts`, which is what a test exercises directly;
 * this file is just the file-reading CLI wrapper around it.
 *
 * Usage: npx tsx pipeline/measure/sanitize-scan-bias.ts [runId] [sampleSize]
 */
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { measureSanitizeScanBias, type SanitizeScanBiasBody } from './sanitize-scan-bias-measure.js';

const runId = process.argv[2] ?? 'rederive-65';
const sampleSize = Number(process.argv[3] ?? 400);

const bodies: SanitizeScanBiasBody[] = [];
const reader = createInterface({
  input: createReadStream(`pipeline/.work/${runId}/official-workflows.jsonl`, { encoding: 'utf8' }),
  crlfDelay: Number.POSITIVE_INFINITY,
});
for await (const line of reader) {
  if (bodies.length >= sampleSize) break;
  if (!line) continue;
  try {
    bodies.push(JSON.parse(line));
  } catch {
    continue;
  }
}

const report = await measureSanitizeScanBias(bodies);
console.log(JSON.stringify({ runId, ...report }, null, 1));
