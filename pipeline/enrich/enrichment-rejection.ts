import fs from 'node:fs';
import path from 'node:path';

export type EnrichmentRejection = { id: string; reason: string };

export function safeRejectionReason(reason: string): string {
  return reason.replace(/(api[_ -]?key|token|secret|password)\s*[:=]\s*[^\s,;.]+/gi, '$1: [redacted]')
    .replace(/https?:\/\/[^\s]+/gi, '[url]').replace(/\s+/g, ' ').slice(0, 220);
}

export function writeEnrichmentRejections(checkpointPath: string | undefined, rejections: EnrichmentRejection[]): void {
  if (!checkpointPath) return;
  const target = path.join(path.dirname(checkpointPath), 'enrichment-rejections.json');
  if (rejections.length === 0) {
    fs.rmSync(target, { force: true });
    return;
  }
  fs.writeFileSync(target, JSON.stringify(rejections, null, 2), 'utf8');
}
