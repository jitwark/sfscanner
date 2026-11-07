import { describe, expect, it } from 'vitest';
import { extractImportSpecifiers } from './check-import-boundary.mjs';

describe('import-boundary source parser', () => {
  it('detects side-effect imports as boundary dependencies', () => {
    expect(extractImportSpecifiers("import '../../../pipeline/index/facets';")).toEqual([
      '../../../pipeline/index/facets',
    ]);
  });
});
