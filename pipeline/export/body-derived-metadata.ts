import crypto from 'node:crypto';
import type { EntryWithChart } from '@hub/contracts';
import type { CorpusV2InputReceipt } from '../../scripts/lib/corpus-v2-input-inventory.js';
import { projectNodeSample, type NodeSample } from '../regenerate/node-coverage.js';
import { deriveStructure, deriveChart } from '../derive/structure.js';
import { deriveReadiness } from '../derive/readiness.js';
import { deriveHostnames } from '../derive/hostnames.js';
import { deriveCompatibility } from '../derive/compatibility.js';
import compatibilityTarget from '../config/n8n-compatibility-target.json';
import { buildSafePrerequisites, type SafePrerequisites } from './preflight-safe-builder.js';

export type BodyDerivedMetadata = Readonly<{
  preflight: SafePrerequisites;
  sample?: NodeSample;
  replacement?: Pick<EntryWithChart['entry'], 'structure' | 'readiness' | 'hostnames' | 'compatibility'> & Pick<EntryWithChart, 'chart'>;
}>;

export function publicSourceId(entry: EntryWithChart['entry']): string {
  return 'source-' + crypto.createHash('sha256').update(`${entry.source.kind}\0${entry.source.repo ?? entry.source.permalink}`).digest('hex');
}

/** Called before scanner transfer; raw values are local and not retained in the returned record. */
export function deriveCapturedBody(receipt: CorpusV2InputReceipt, inventorySha256: string, sourceId: string, bytes?: Uint8Array, replaceReadiness = false): BodyDerivedMetadata {
  if (receipt.bodySha256 !== null) {
    if (!bytes || bytes.length !== receipt.byteLength || crypto.createHash('sha256').update(bytes).digest('hex') !== receipt.bodySha256) {
      throw new Error('Corpus body differs from inventory hash/length; rerun input inventory.');
    }
  } else if (bytes !== undefined || receipt.status === 'AVAILABLE') throw new Error('Corpus body has no inventory binding.');
  let value: unknown;
  if (bytes && bytes.length <= 8 * 1024 * 1024) {
    try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
    catch { if (receipt.status === 'AVAILABLE') throw new Error('AVAILABLE inventory body no longer parses.'); }
  }
  const preflight = buildSafePrerequisites(receipt, inventorySha256, sourceId, value);
  if (receipt.status !== 'AVAILABLE' || value === undefined) return { preflight };
  const sample = projectNodeSample(receipt.entryId, bytes!);
  if (!replaceReadiness) return { preflight, sample };
  return { preflight, sample, replacement: {
    structure: deriveStructure(value), chart: deriveChart(value), readiness: deriveReadiness(value), hostnames: deriveHostnames(value),
    compatibility: deriveCompatibility(value, { targetVersion: compatibilityTarget.version, checkedAt: compatibilityTarget.checkedAt, source: compatibilityTarget.source }),
  } };
}
