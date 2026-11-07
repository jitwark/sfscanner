import { describe, expect, it } from 'vitest';
import { SPEC_HARD_LINES, SPEC_TARGET_LINES, validateSpecPackage } from './spec-validate.mjs';

function packageWith(overrides = []) {
  return {
    id: '2026-08-26-example-capability',
    files: [
      { path: 'proposal.md', lines: 40 },
      { path: 'design.md', lines: 80 },
      { path: 'tasks.md', lines: 30 },
      { path: 'specs/example-capability/spec.md', lines: 90 },
      ...overrides,
    ],
  };
}

describe('validateSpecPackage', () => {
  it('accepts a package with all four required artifacts', () => {
    const result = validateSpecPackage(packageWith());

    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it('rejects a package missing proposal.md', () => {
    const pkg = packageWith();
    pkg.files = pkg.files.filter((file) => file.path !== 'proposal.md');

    const result = validateSpecPackage(pkg);

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('proposal.md');
  });

  it('rejects a package missing design.md', () => {
    const pkg = packageWith();
    pkg.files = pkg.files.filter((file) => file.path !== 'design.md');

    const result = validateSpecPackage(pkg);

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('design.md');
  });

  it('rejects a package missing tasks.md', () => {
    const pkg = packageWith();
    pkg.files = pkg.files.filter((file) => file.path !== 'tasks.md');

    const result = validateSpecPackage(pkg);

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('tasks.md');
  });

  it('rejects a package with no capability spec', () => {
    const pkg = packageWith();
    pkg.files = pkg.files.filter((file) => !file.path.startsWith('specs/'));

    const result = validateSpecPackage(pkg);

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('specs/<capability>/spec.md');
  });

  it('rejects a markdown file over the hard line ceiling', () => {
    const result = validateSpecPackage(packageWith([{ path: 'notes.md', lines: SPEC_HARD_LINES + 1 }]));

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain(String(SPEC_HARD_LINES));
  });

  it('warns about a markdown file over the target but under the ceiling', () => {
    const result = validateSpecPackage(packageWith([{ path: 'notes.md', lines: SPEC_TARGET_LINES + 1 }]));

    expect(result.errors).toEqual([]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain(String(SPEC_TARGET_LINES));
  });

  it('ignores non-markdown files for the line ceiling', () => {
    const result = validateSpecPackage(packageWith([{ path: 'fixtures/data.json', lines: SPEC_HARD_LINES + 500 }]));

    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it('respects package-supplied limit overrides', () => {
    const result = validateSpecPackage({
      ...packageWith([{ path: 'notes.md', lines: 120 }]),
      limits: { targetLines: 100, hardLines: 150 },
    });

    expect(result.errors).toEqual([]);
    expect(result.warnings).toHaveLength(1);
  });
});
