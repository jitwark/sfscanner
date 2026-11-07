import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { absentBodiesOutcome, resolveBodiesDirectory } from './local-only-corpus-policy.mjs';

/**
 * The CI skip is the one branch that turns this gate's silence into an exit 0, so
 * it is pinned at the decision level as well as end to end: the decision itself,
 * the wording that keeps it a skip rather than a pass, and the fail-closed
 * default that every other host gets.
 */
const root = path.resolve(import.meta.dirname, '..', '..');

describe('local-only corpus policy', () => {
  it('reads explicit inputs before the repository-local private input location', () => {
    expect(resolveBodiesDirectory({ root, override: 'D:/elsewhere', environment: {} })).toBe(path.resolve('D:/elsewhere'));
    expect(resolveBodiesDirectory({ root, environment: { OFFICIAL_BODIES_DIR: 'D:/env' } })).toBe(path.resolve('D:/env'));
    expect(resolveBodiesDirectory({ root, environment: {} })).toBe(
      path.resolve(root, '.work', 'inputs', 'official'),
    );
  });

  it('skips, labelled and loud, on CI — and says absence was NOT proven there', () => {
    const decision = absentBodiesOutcome({ root, bodiesDir: path.join(root, 'absent'), ci: 'true' });
    expect(decision.action).toBe('skip');
    expect(decision.message).toContain('check:published-secret-leak skipped —');
    expect(decision.message).toContain('Absence of leaked values was NOT proven in this environment');
    expect(decision.message).toContain('local-only by owner policy');
    // The skip is neither verdict, in either spelling.
    expect(decision.message).not.toContain('Published secret gate passed');
    expect(decision.message).not.toContain('Published secret gate failed');
  });

  it('fails closed on every host that is not CI, naming the missing input', () => {
    for (const ci of [undefined, '', 'false', '1', 'TRUE']) {
      const decision = absentBodiesOutcome({ root, bodiesDir: path.join(root, 'absent'), ci });
      expect(decision.action).toBe('fail');
      expect(decision.lines[0]).toContain('raw bodies not found');
      expect(decision.lines.join('\n')).not.toContain('skipped');
    }
  });
});
