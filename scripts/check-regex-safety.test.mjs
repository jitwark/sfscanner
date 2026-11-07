import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { detectCatastrophicPatterns } from './regex-safety-detector.mjs';
import { extractRegexCandidates, findRegexSafetyViolations } from './check-regex-safety.mjs';

describe('detectCatastrophicPatterns', () => {
  it('flags nested quantifiers', () => {
    expect(detectCatastrophicPatterns('(a+)+')).not.toEqual([]);
    expect(detectCatastrophicPatterns('(a*)*')).not.toEqual([]);
    expect(detectCatastrophicPatterns('(a+)*')).not.toEqual([]);
  });

  it('flags overlapping alternation under a quantifier', () => {
    expect(detectCatastrophicPatterns('(a|a)*')).not.toEqual([]);
    expect(detectCatastrophicPatterns('(\\w|\\d)+')).not.toEqual([]);
  });

  it('does not flag anchored literals', () => {
    expect(detectCatastrophicPatterns('^https://example\\.com$')).toEqual([]);
  });

  it('does not flag bounded quantifiers', () => {
    expect(detectCatastrophicPatterns('^[A-Za-z0-9]{1,64}$')).toEqual([]);
    expect(detectCatastrophicPatterns('^(?:foo){1,64}$')).toEqual([]);
  });

  it('does not flag a character class with a single quantifier', () => {
    expect(detectCatastrophicPatterns('[A-Za-z0-9_-]{8,}')).toEqual([]);
  });

  it('does not flag a negated character class quantified once', () => {
    expect(detectCatastrophicPatterns('[^"]*')).toEqual([]);
  });

  it('does not flag a plain grouping paren with no outer quantifier', () => {
    expect(detectCatastrophicPatterns('(?:api[-_ ]?key|token|secret)')).toEqual([]);
  });

  it('does not flag an optional group (bounded 0-or-1 repetition)', () => {
    expect(detectCatastrophicPatterns('(?:abc)?[a-z]+')).toEqual([]);
  });

  it('does not flag a group with no trailing quantifier at all', () => {
    expect(detectCatastrophicPatterns('(?:ghp|glpat)-?[A-Za-z0-9_]{12,}')).toEqual([]);
  });
});

describe('extractRegexCandidates', () => {
  it('finds regex literals and reports their line number', () => {
    const source = "const a = 1;\nconst re = /a+b/gi;\n";
    expect(extractRegexCandidates(source, 'x.ts')).toEqual([
      { file: 'x.ts', line: 2, pattern: 'a+b', flags: 'gi', kind: 'literal' },
    ]);
  });

  it('ignores a shebang line', () => {
    const source = '#!/usr/bin/env node\nimport { run } from "./cli.js";\n';
    expect(extractRegexCandidates(source, 'main.ts')).toEqual([]);
  });

  it('does not mistake division for a regex literal', () => {
    const source = 'const half = total / 2 / count;\n';
    expect(extractRegexCandidates(source, 'x.ts')).toEqual([]);
  });

  it('extracts a plain string literal passed to new RegExp', () => {
    const source = "const re = new RegExp('^a+b$', 'i');\n";
    expect(extractRegexCandidates(source, 'x.ts')).toEqual([
      { file: 'x.ts', line: 1, pattern: '^a+b$', flags: 'i', kind: 'new RegExp' },
    ]);
  });

  it('extracts a body: string literal from a provider-token-pattern-shaped object', () => {
    const source = "export const P = [{ kind: 'x', body: 'sk_(?:live|test)_[A-Za-z0-9_]{8,}', flags: '' }];\n";
    expect(extractRegexCandidates(source, 'provider-token-patterns.ts')).toEqual([
      { file: 'provider-token-patterns.ts', line: 1, pattern: 'sk_(?:live|test)_[A-Za-z0-9_]{8,}', flags: '', kind: 'body' },
    ]);
  });
});

function withFixture(files, callback) {
  const root = mkdtempSync(join(tmpdir(), 'regex-safety-'));
  try {
    for (const [relativePath, source] of Object.entries(files)) {
      const filePath = join(root, relativePath);
      mkdirSync(join(filePath, '..'), { recursive: true });
      writeFileSync(filePath, source, 'utf8');
    }
    return callback(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe('findRegexSafetyViolations', () => {
  it('reports a genuinely vulnerable pattern with file, line, and pattern', () => {
    withFixture({
      'packages/scanner-core/src/bad.ts': 'export const evil = /(a+)+$/;\n',
    }, (root) => {
      expect(findRegexSafetyViolations(root)).toEqual([
        expect.objectContaining({ file: 'packages/scanner-core/src/bad.ts', line: 1, pattern: '(a+)+$' }),
      ]);
    });
  });

  it('does not report the benign patterns actually used in the scanner', () => {
    withFixture({
      'packages/scanner-core/src/good.ts': "export const ok = /^[A-Za-z0-9]{1,64}$/;\nexport const url = /https?:\\/\\/[^\\s\"'<>]+/gi;\n",
      'packages/scanner-core/src/good.test.ts': 'export const skipped = /(a+)+/;\n',
    }, (root) => {
      expect(findRegexSafetyViolations(root)).toEqual([]);
    });
  });
});
