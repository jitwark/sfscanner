import type { Candidate, Grade } from '@hub/contracts';
import { sanitizeWorkflow } from '../sanitize/redact.js';
import { scanCandidate } from '../scan/scan-entry.js';

export type SanitizeScanBiasBody = { templateId: string | number; workflow: Record<string, unknown> };

export type SanitizeScanBiasReport = {
  sampled: number;
  scanned: number;
  sanitizeRefused: number;
  gradeChangedAfterSanitize: number;
  gradeChangedShare: string;
  meanScoreOverstatementWhenRaw: number;
  moves: Record<string, number>;
  rawGrades: Record<string, number>;
  sanitizedGrades: Record<string, number>;
  // AUDIT-SCAN-002 follow-up: this pipeline's scan path used to lose parser
  // diagnostics on reparse in the worker, silently reporting `COMPLETE`
  // instead of `INDETERMINATE` for malformed inputs. These counts make that
  // class of understatement visible in the bias measurement itself.
  rawIndeterminate: number;
  sanitizedIndeterminate: number;
};

function asCandidate(id: string, json: unknown): Candidate {
  return {
    id,
    source: { kind: 'n8n_official', permalink: `https://n8n.io/workflows/${id}`, fetchedAt: '' },
    rights: { status: 'link_only', licence: null, licenceUrl: null, reason: 'measurement' },
    title: id,
    json,
    bytes: 0,
  } as unknown as Candidate;
}

/**
 * Are official security grades comparable to GitHub ones? Scans the same
 * official bodies raw and sanitized with the shipped `scanCandidate` and
 * `sanitizeWorkflow` (not a copy, so it cannot drift from the site) and
 * reports how many published grades move, plus how many inputs on each side
 * could not be graded at all (`analysisStatus === 'INDETERMINATE'`).
 */
export async function measureSanitizeScanBias(
  bodies: readonly SanitizeScanBiasBody[],
): Promise<SanitizeScanBiasReport> {
  let gradeChanged = 0;
  let scoreDelta = 0;
  let sanitizeRefused = 0;
  let rawIndeterminate = 0;
  let sanitizedIndeterminate = 0;
  const moves: Record<string, number> = {};
  const rawGrades: Record<string, number> = {};
  const sanitizedGrades: Record<string, number> = {};

  for (const body of bodies) {
    const id = String(body.templateId);
    const raw = await scanCandidate(asCandidate(id, body.workflow));
    const san = sanitizeWorkflow(body.workflow);
    if (!san.ok) {
      sanitizeRefused += 1;
      continue;
    }
    const clean = await scanCandidate(asCandidate(id, san.workflow));

    rawGrades[raw.grade] = (rawGrades[raw.grade] ?? 0) + 1;
    sanitizedGrades[clean.grade] = (sanitizedGrades[clean.grade] ?? 0) + 1;
    if (raw.analysisStatus === 'INDETERMINATE') rawIndeterminate += 1;
    if (clean.analysisStatus === 'INDETERMINATE') sanitizedIndeterminate += 1;
    scoreDelta += raw.score - clean.score;
    if (raw.grade !== clean.grade) {
      gradeChanged += 1;
      const key = `${raw.grade as Grade}->${clean.grade as Grade}`;
      moves[key] = (moves[key] ?? 0) + 1;
    }
  }

  const scanned = bodies.length - sanitizeRefused;
  return {
    sampled: bodies.length,
    scanned,
    sanitizeRefused,
    gradeChangedAfterSanitize: gradeChanged,
    gradeChangedShare: `${((gradeChanged / (scanned || 1)) * 100).toFixed(1)}%`,
    meanScoreOverstatementWhenRaw: Number((scoreDelta / (scanned || 1)).toFixed(2)),
    moves,
    rawGrades,
    sanitizedGrades,
    rawIndeterminate,
    sanitizedIndeterminate,
  };
}
