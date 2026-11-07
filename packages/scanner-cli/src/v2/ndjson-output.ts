import { canonicalizeJson } from '@hub/scanner-core/canonical-json';
import type { BatchResultV2 } from './batch-runner';
import { DEFAULT_PROJECTION_OPTIONS, projectBatchV2, type CliEnvelopeV2, type ProjectedBatchV2, type ProjectionOptionsV2 } from './json-output';

type HeaderV2 = Readonly<{ schemaVersion: 'n8n-scan-v2-ndjson'; type: 'header'; tool: CliEnvelopeV2['tool']; artifacts: CliEnvelopeV2['artifacts']; invocation: CliEnvelopeV2['invocation']; supplyChain?: NonNullable<CliEnvelopeV2['supplyChain']> }>;
type ResultLineV2 = Readonly<{ schemaVersion: 'n8n-scan-v2-ndjson'; type: 'result'; item: ProjectedBatchV2['items'][number] }>;
type SummaryLineV2 = Readonly<{ schemaVersion: 'n8n-scan-v2-ndjson'; type: 'summary'; summary: CliEnvelopeV2['summary']; exitReason: CliEnvelopeV2['exitReason'] }>;

export function serializeNdjsonV2(batch: BatchResultV2, options: ProjectionOptionsV2 = { ...DEFAULT_PROJECTION_OPTIONS, format: 'ndjson' }): string {
  const projected = projectBatchV2(batch, options);
  const envelope = projected.envelope;
  const header: HeaderV2 = { schemaVersion: 'n8n-scan-v2-ndjson', type: 'header', tool: envelope.tool, artifacts: envelope.artifacts, invocation: envelope.invocation, ...(envelope.supplyChain === undefined ? {} : { supplyChain: envelope.supplyChain }) };
  const lines: string[] = [canonicalizeJson(header)];
  for (const item of projected.items) lines.push(canonicalizeJson({ schemaVersion: 'n8n-scan-v2-ndjson' as const, type: 'result' as const, item } satisfies ResultLineV2));
  const summary: SummaryLineV2 = { schemaVersion: 'n8n-scan-v2-ndjson', type: 'summary', summary: envelope.summary, exitReason: envelope.exitReason };
  lines.push(canonicalizeJson(summary));
  return `${lines.join('\n')}\n`;
}
