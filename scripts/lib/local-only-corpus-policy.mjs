/**
 * Owner policy (2026-10-18): the published-secret gate is local-only.
 *
 * The raw official corpus is local-only and non-redistributable by legal design,
 * so a cloud runner cannot possess it — and `deploy.yml` runs the full
 * `release:gates`, so a hard failure here fails every deploy on an input the
 * runner is not allowed to have. On CI (`CI === 'true'`) the absence is a
 * labelled skip, never a pass: it names the missing input and says out loud that
 * absence was NOT proven in this environment. Everywhere else the gate keeps
 * failing closed — its whole value is that it cannot prove absence without the
 * source it is asserting absence about.
 *
 * This is a statement about which machines may hold the corpus, not about
 * detection, so it lives apart from the sweep. Nothing here exits: the gate owns
 * its log routing (`--json` stdout stays report-only), its exit codes and its
 * verdict; this module owns where the corpus is read from and what its absence
 * means.
 */
import path from 'node:path';
import { relative } from './published-secret-report.mjs';

/** Private, ignored local inputs; external authorized folders require explicit configuration. */
const DEFAULT_BODIES_SEGMENTS = ['.work', 'inputs', 'official'];

/** `--bodies`, then `OFFICIAL_BODIES_DIR`, then private repository-local storage. */
export function resolveBodiesDirectory({ root, override, environment = process.env }) {
  return path.resolve(override ?? environment.OFFICIAL_BODIES_DIR ?? path.resolve(root, ...DEFAULT_BODIES_SEGMENTS));
}

/**
 * What an absent bodies directory means, as a decision the caller acts on:
 * `{action: 'skip', message}` on a CI runner — the labelled message a runner must
 * read, which is the reason the absence is a skip and not a pass — and
 * `{action: 'fail', lines}` on every other host, the fail-closed lines that name
 * the missing input and how to point the gate at it.
 */
export function absentBodiesOutcome({ root, bodiesDir, ci }) {
  const location = relative(root, bodiesDir);
  if (ci === 'true') {
    return {
      action: 'skip',
      message:
        `check:published-secret-leak skipped — raw bodies not found at ${location} and CI=true, ` +
        'so this is a shared cloud runner that cannot possess the local-only corpus. Absence of leaked values ' +
        'was NOT proven in this environment: this check is local-only by owner policy and must be run on a ' +
        'machine holding the authorized corpus before release promotion.',
    };
  }
  return {
    action: 'fail',
    lines: [
      `Published secret gate failed: raw bodies not found at ${location}.`,
      'Set OFFICIAL_BODIES_DIR or pass --bodies <dir>. This gate fails closed: it cannot',
      'prove absence without the source it is asserting absence about.',
    ],
  };
}
