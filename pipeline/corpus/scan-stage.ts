import type { Candidate, EntrySecurity } from '@hub/contracts';
import { processCandidateWorkflow } from '../sanitize/process-candidate.js';
import { deriveStructure, deriveChart } from '../derive/structure.js';
import { deriveReadiness } from '../derive/readiness.js';
import { deriveHostnames } from '../derive/hostnames.js';
import { deriveCompatibility } from '../derive/compatibility.js';
import compatibilityTarget from '../config/n8n-compatibility-target.json';
import { getScannerVersion } from '../scan/scan-entry.js';
import { ADMITTED_V2_SCAN_IDENTITY, rescanRecordOfEvidence, retainCorpusWorkflowV2Evidence, type V2RescanRecord } from '../scan/v2-corpus-adapter.js';
import { evaluateV2FastForward } from '../scan/v2-fast-forward.js';
import { makeV2RescanManifest, writeV2RescanManifest } from '../scan/v2-rescan-manifest.js';
import { createV2ReleaseReport, writeV2ReleaseReport } from '../scan/v2-release-report.js';
import { appendStageRecord } from '../stage-ledger.js';
import { canonicalizeJsonForHash } from '../dedup/signatures.js';
import { sha256 } from './run-context.js';
import { type V2SourceReceipt, buildScannerSourceReceipt } from '../scan/v2-source-receipt.js';

export type PreviousScanRun = {
  manifestRecords: ReadonlyMap<string, V2RescanRecord>;
  securitySummaries: ReadonlyMap<string, EntrySecurity>;
  receipt?: V2SourceReceipt;
};

export type ScanStageOptions = {
  runId: string;
  workDir: string;
  /** Mutated in place: bodies are replaced with their sanitized copies as the loop proceeds. */
  candidates: Candidate[];
  ledgerPath: string;
  previousRun?: PreviousScanRun;
  currentReceipt?: V2SourceReceipt;
  onScanExecuted?: (candidate: Candidate) => void;
};

/**
 * STAGE 3: SCAN, STRUCTURE & SANITIZE — analyze each acquired body, then replace
 * it with the sanitized copy in the same pass.
 *
 * Analyze before redaction, sanitize immediately after. Keeping raw bodies in a
 * second map while holding the sanitized corpus doubled peak memory and made a
 * full rebuild exceed Node's default heap on large corpora.
 */
export async function runScanStage(options: ScanStageOptions): Promise<void> {
  const { runId, workDir, candidates, ledgerPath } = options;

  const currentReceipt =
    options.currentReceipt ??
    (await buildScannerSourceReceipt({
      runId,
      candidateInputs: candidates
        .filter((c) => Boolean(c.json))
        .map((c) => {
          const txt = typeof c.json === 'string' ? c.json : JSON.stringify(c.json) ?? '';
          return { entryId: c.id, inputSha256: sha256(txt) };
        }),
    }));

  const v2RescanRecords: V2RescanRecord[] = [];
  const scannerVer = getScannerVersion();

  for (const c of candidates) {
    if (c.json) {
      // Keep this local until analysis and sanitization finish; do not retain a second corpus-wide reference to the raw body.
      const analysisJson = c.json;
      const sourceText = typeof analysisJson === 'string' ? analysisJson : JSON.stringify(analysisJson) ?? '';
      const sourceBytes = new TextEncoder().encode(sourceText);
      let security: EntrySecurity;
      let v2Record: V2RescanRecord;
      const fastForward = options.previousRun
        ? evaluateV2FastForward(
            sourceBytes,
            c.id,
            c.rights.status,
            options.previousRun.manifestRecords.get(c.id),
            options.previousRun.securitySummaries.get(c.id),
            ADMITTED_V2_SCAN_IDENTITY,
            {
              currentReceipt,
              previousReceipt: options.previousRun.receipt,
              requireSourceReceipt: true,
            },
          )
        : null;
      if (fastForward?.kind === 'HIT') {
        security = fastForward.security;
        v2Record = fastForward.record;
      } else {
        options.onScanExecuted?.(c);
        const v2Evidence = retainCorpusWorkflowV2Evidence(sourceBytes, c.id, c.rights.status);
        v2Record = rescanRecordOfEvidence(v2Evidence);
        security = v2Evidence.security;
      }
      v2RescanRecords.push(v2Record);
      const inputHash = sha256(canonicalizeJsonForHash({ entryId: c.id, scannerVersion: scannerVer, v2Authority: v2Record }));
      const struct = deriveStructure(analysisJson);
      const chart = deriveChart(analysisJson);
      (c as unknown as Record<string, unknown>).structure = struct;
      (c as unknown as Record<string, unknown>).chart = chart;
      // Readiness and hostnames need the workflow JSON, so they are derived
      // here beside structure. A candidate without JSON gets neither field
      // rather than an empty one: "nothing to set up" and "we could not look"
      // are different answers, and only one of them is true.
      (c as unknown as Record<string, unknown>).readiness = deriveReadiness(analysisJson);
      (c as unknown as Record<string, unknown>).hostnames = deriveHostnames(analysisJson);
      (c as unknown as Record<string, unknown>).compatibility = deriveCompatibility(analysisJson, {
        targetVersion: compatibilityTarget.version,
        checkedAt: compatibilityTarget.checkedAt,
        source: compatibilityTarget.source,
      });
      // The canonical security summary is the native v2 result's own projection: real findings and
      // severity counts, with the aggregate grade absent when the engine published none. Ledger
      // entries and stored stamps never authorize a stale security value.
      (c as unknown as Record<string, unknown>).security = security;
      const sanitizeInputHash = sha256(c.id + ':sanitize:v1');
      const sanRes = processCandidateWorkflow(analysisJson);
      if (!sanRes.ok) {
        // A candidate that was never redistributable keeps the reason it already
        // had: "official n8n template" is why it is link-only, and overwriting
        // that with "sanitize_failed" would misreport the licence position on
        // the published page.
        if (c.rights.status === 'redistributable') {
          c.rights = {
            status: 'link_only',
            licence: c.rights.licence,
            licenceUrl: c.rights.licenceUrl,
            reason: 'sanitize_failed: ' + sanRes.errors.join(', '),
          };
        }
        await appendStageRecord(ledgerPath, { entryId: c.id, stage: 'sanitize', ok: false, code: 'sanitize_failed', inputHash: sanitizeInputHash, outputHash: sha256(canonicalizeJsonForHash({ json: analysisJson, rights: c.rights })) });
      } else {
        c.json = sanRes.workflow;
        await appendStageRecord(ledgerPath, { entryId: c.id, stage: 'sanitize', ok: true, inputHash: sanitizeInputHash, outputHash: sha256(canonicalizeJsonForHash({ json: c.json, rights: c.rights })) });
      }
      await appendStageRecord(ledgerPath, { entryId: c.id, stage: 'scan', ok: true, inputHash, outputHash: sha256(canonicalizeJsonForHash({ security, structure: struct, chart, readiness: (c as unknown as Record<string, unknown>).readiness, hostnames: (c as unknown as Record<string, unknown>).hostnames, compatibility: (c as unknown as Record<string, unknown>).compatibility })) });
    } else if (!((c as unknown as Record<string, unknown>).security)) {
      // Fallback security for link-only candidate without JSON
      (c as unknown as Record<string, unknown>).security = {
        grade: 'UNKNOWN',
        score: 0,
        counts: { critical: 0, high: 0, medium: 0, low: 0, info: 0 },
        findings: [],
        hardenedExtra: 0,
        scannerVersion: 'not-scanned',
        profile: 'beta-default',
      };
    }
  }

  // Keep v2 authority records beside this disposable run;
  // they never enter committed public data and contain only hashes, identities, and bounded finding metadata.
  const v2Manifest = makeV2RescanManifest(runId, v2RescanRecords, currentReceipt);
  await Promise.all([writeV2RescanManifest(workDir, v2Manifest), writeV2ReleaseReport(workDir, createV2ReleaseReport(runId, v2RescanRecords))]);
}
