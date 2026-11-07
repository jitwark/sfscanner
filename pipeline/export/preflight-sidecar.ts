import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  readPublicPreflightCoverageRow, readPublicPreflightEvidenceRow, validatePublicPreflightRelations,
} from '../../contracts/public-preflight-data.js';
import type { SafePrerequisites } from './preflight-safe-builder.js';

export const PREFLIGHT_SIDECAR_PATH = 'scanner/preflight-prerequisites.ndjson';
export const PREFLIGHT_SIDECAR_SCHEMA = 'safe-preflight-sidecar-v1';
const fail = (): never => { throw new Error('Preflight sidecar invalid, missing or mixed; rerun corpus maintenance with verified body sources.'); };
const hash = (bytes: Uint8Array) => crypto.createHash('sha256').update(bytes).digest('hex');
export type PreflightManifestArtifact = { path: string; byteSize: number; sha256: string; entryCount?: number };

/** Rechecks the closed C1b schema and population before any bytes are published. */
export function validateSafeSidecar(records: readonly SafePrerequisites[], inventorySha256: string, workflowIds: readonly string[]): void {
  const ids = records.map((record) => record.coverage.workflowId);
  if (new Set(ids).size !== ids.length || ids.length !== workflowIds.length
    || [...ids].sort().join('\0') !== [...workflowIds].sort().join('\0')
    || records.some(({ coverage, evidence }) => coverage.inventorySha256 !== inventorySha256
      || evidence.some((row) => row.workflowId !== coverage.workflowId))
    || !validatePublicPreflightRelations(records.map((r) => r.coverage), records.flatMap((r) => r.evidence))) fail();
}

export function writePreflightSidecar(dataDir: string, records: readonly SafePrerequisites[], inventorySha256: string, workflowIds: readonly string[]): PreflightManifestArtifact {
  const ordered = [...records].sort((a, b) => Buffer.compare(Buffer.from(a.coverage.workflowId), Buffer.from(b.coverage.workflowId)));
  validateSafeSidecar(ordered, inventorySha256, workflowIds);
  const bytes = Buffer.from(ordered.map((record) => JSON.stringify({ schemaVersion: PREFLIGHT_SIDECAR_SCHEMA, ...record }) + '\n').join(''));
  const file = path.join(dataDir, PREFLIGHT_SIDECAR_PATH);
  fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes);
  return { path: PREFLIGHT_SIDECAR_PATH, byteSize: bytes.length, sha256: hash(bytes), entryCount: ordered.length };
}

/** One sidecar read, reused by pending and final projections. Never consults source bodies. */
export function readPreflightSidecar(dataDir: string, artifacts: readonly PreflightManifestArtifact[], inventorySha256: string, workflowIds: readonly string[]): readonly SafePrerequisites[] {
  if (!Array.isArray(artifacts)) return fail();
  const owned = artifacts.filter((artifact) => artifact.path === PREFLIGHT_SIDECAR_PATH);
  if (owned.length !== 1) fail();
  let bytes: Buffer;
  try { bytes = fs.readFileSync(path.join(dataDir, PREFLIGHT_SIDECAR_PATH)); } catch { return fail(); }
  const artifact = owned[0]!;
  if (bytes.length !== artifact.byteSize || hash(bytes) !== artifact.sha256 || artifact.entryCount !== workflowIds.length) fail();
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  if (text && !text.endsWith('\n')) fail();
  const records = (text ? text.slice(0, -1).split('\n') : []).map((line): SafePrerequisites => {
    let record: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(line);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return fail();
      record = parsed as Record<string, unknown>;
    } catch { return fail(); }
    if (Object.keys(record).sort().join() !== 'coverage,evidence,schemaVersion' || record.schemaVersion !== PREFLIGHT_SIDECAR_SCHEMA || !Array.isArray(record.evidence)) fail();
    const coverage = readPublicPreflightCoverageRow(record.coverage);
    const rawEvidence = record.evidence;
    if (!Array.isArray(rawEvidence)) return fail();
    const evidence = rawEvidence.map((row: unknown) => readPublicPreflightEvidenceRow(row));
    if (!coverage || evidence.some((row) => !row)) return fail();
    return { coverage, evidence: evidence.map((row) => row!) };
  });
  validateSafeSidecar(records, inventorySha256, workflowIds);
  return records;
}
