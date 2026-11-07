import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const args = process.argv.slice(2);
const value = (flag) => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
};
const runId = value('--run');
if (!runId) throw new Error('--run <runId> is required');
const workDir = path.resolve(process.cwd(), 'pipeline', '.work', runId);
const ledgerPath = path.resolve(process.cwd(), value('--batch-ledger') ?? path.join('pipeline', '.work', runId, 'enrichment-batches.json'));
const checkpointPath = path.resolve(process.cwd(), value('--checkpoint') ?? path.join('pipeline', '.work', runId, 'describe-checkpoint.json'));
const ledger = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
const checkpoint = JSON.parse(fs.readFileSync(checkpointPath, 'utf8'));
const requested = value('--batch');
const historyIndex = value('--history-index');
const records = Object.values(ledger);
const historyPath = `${ledgerPath}.history.json`;
const history = historyIndex !== undefined && fs.existsSync(historyPath)
  ? JSON.parse(fs.readFileSync(historyPath, 'utf8'))
  : undefined;
const record = history
  ? history[Number(historyIndex)]
  : requested !== undefined ? ledger[requested] : records.sort((a, b) => b.batchIndex - a.batchIndex)[0];
if (!record) throw new Error('No enrichment batch record was found');
const manifestPath = path.resolve(process.cwd(), record.inputManifestPath ?? path.join('pipeline', '.work', runId, 'enrichment-input-manifest.json'));
const inputManifest = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, 'utf8')) : undefined;
const ids = record.selectedIds ?? [];
const selectedEntries = ids.length ? ids.map((id) => ({ id, checkpoint: checkpoint[id] })).filter((item) => item.checkpoint) : [];
const issues = [];
if (record.status !== 'completed') issues.push(`batch status is ${record.status}, not completed`);
if (record.status === 'completed' && ids.length !== record.selectedCount) issues.push(`ledger selectedCount ${record.selectedCount} does not match selected IDs ${ids.length}`);
const manifestBatch = inputManifest?.batches?.find((item) => item.batchIndex === record.batchIndex);
if (manifestBatch && manifestBatch.identityHash !== record.identityHash) issues.push('ledger identity hash does not match the input manifest');
if (record.status === 'completed' && ids.length) {
  const checkpointHash = crypto.createHash('sha256').update(JSON.stringify(ids.map((id) => [id, checkpoint[id]]))).digest('hex');
  if (checkpointHash !== record.checkpointHash) issues.push('ledger checkpoint hash does not match selected checkpoint records');
}
if (record.status === 'completed' && selectedEntries.length !== record.acceptedCount) issues.push(`accepted count ${record.acceptedCount} does not match checkpoint records ${selectedEntries.length}`);
for (const item of selectedEntries) {
  const value = item.checkpoint;
  if (value.descriptionSource !== 'generated') issues.push(`${item.id}: non-generated source`);
  if (!value.descriptionContent) issues.push(`${item.id}: missing structured description`);
  const provenance = value.descriptionProvenance ?? {};
  for (const field of ['source', 'model', 'promptVersion', 'promptHash', 'schemaVersion', 'workflowHash', 'generatedAt']) {
    if (!provenance[field]) issues.push(`${item.id}: missing provenance.${field}`);
  }
}
const redact = (text) => text.replace(/(api[_ -]?key|token|secret|password)\s*[:=]\s*[^\s,;.]+/gi, '$1: [redacted]');
const wordCounts = selectedEntries.map((item) => ({ id: item.id, words: String(item.checkpoint.description ?? '').trim().split(/\s+/u).filter(Boolean).length }));
const excerpts = selectedEntries.slice(0, 3).map((item) => ({
  id: item.id,
  headline: redact(String(item.checkpoint.descriptionContent?.headline ?? '')),
  summary: redact(String(item.checkpoint.descriptionContent?.summary ?? '')),
  outcome: redact(String(item.checkpoint.descriptionContent?.outcome ?? '')).slice(0, 360),
}));
const identities = ids.map((id) => inputManifest?.entries?.find((item) => item.id === id)?.identity).filter(Boolean);
const report = {
  reportVersion: 1,
  runId,
  reportedAt: new Date().toISOString(),
  batch: record,
  selectedIds: ids,
  checkpointEntries: selectedEntries.length,
  validationErrors: record.validationErrors ?? [],
  identity: identities[0] ?? null,
  wordCounts,
  averageWords: wordCounts.length ? Math.round(wordCounts.reduce((total, item) => total + item.words, 0) / wordCounts.length) : 0,
  excerpts,
  issues,
  verified: record.status === 'completed' && issues.length === 0 && selectedEntries.length === record.acceptedCount,
};
const reportDir = path.resolve(process.cwd(), value('--report-dir') ?? path.join(path.dirname(checkpointPath), 'batch-reports'));
fs.mkdirSync(reportDir, { recursive: true });
const suffix = history ? `-${record.identityHash.slice(0, 12)}` : '';
const reportPath = path.join(reportDir, `batch-${record.batchIndex}${suffix}.json`);
fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(`${report.verified ? 'verified' : 'FAILED'} batch ${record.batchIndex}: ${record.acceptedCount ?? selectedEntries.length} checkpoint entries; ${issues.length} issue(s)`);
console.log(`report ${reportPath}`);
if (!report.verified) process.exitCode = 1;
