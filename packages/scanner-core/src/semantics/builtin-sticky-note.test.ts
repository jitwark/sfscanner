import { describe, expect, it } from 'vitest';
import { BUILTIN_SEMANTIC_CATALOGUE_V2 } from './builtin-catalogue';
import { resolveNodeSemantics } from './catalogue-resolver';
import { builtinSourceProvenance } from './builtin-provenance';

const CORE_DOCS = 'https://docs.n8n.io/integrations/builtin/core-nodes/';

describe('inert sticky-note semantics', () => {
  it('resolves exactly v1.0.0 as an annotation with no execution surface', () => {
    const resolved = resolveNodeSemantics(BUILTIN_SEMANTIC_CATALOGUE_V2, {
      nodeType: 'n8n-nodes-base.stickyNote',
      version: '1.0.0',
      operation: null,
    });
    expect(resolved).toEqual({
      semanticId: 'annotation.sticky-note',
      nodeType: 'n8n-nodes-base.stickyNote',
      versionRange: { clauses: [[{ op: 'EQ', version: '1.0.0' }]] },
      operation: null,
      entry: 'NONE',
      parameterPaths: [],
      authentication: null,
      credentialPaths: [],
      destinationPaths: [],
      effects: [],
      endpoints: [],
      ports: [],
      overwritePaths: [],
      errorMode: 'UNKNOWN',
      retryMode: 'UNKNOWN',
      disabledMode: 'SKIP',
      provenance: builtinSourceProvenance('annotation.sticky-note', CORE_DOCS),
    });
  });

  it('does not claim an unsupported note version', () => {
    expect(resolveNodeSemantics(BUILTIN_SEMANTIC_CATALOGUE_V2, {
      nodeType: 'n8n-nodes-base.stickyNote',
      version: '2.0.0',
      operation: null,
    })).toBeNull();
  });

  it('keeps the existing noOp passthrough exact and unchanged', () => {
    const resolved = resolveNodeSemantics(BUILTIN_SEMANTIC_CATALOGUE_V2, {
      nodeType: 'n8n-nodes-base.noOp',
      version: '1.0.0',
      operation: null,
    });
    expect(resolved?.semanticId).toBe('noop.passthrough');
    expect(resolved?.ports).toEqual([{ type: 'main', index: 0, itemMode: 'EACH' }]);
  });
});
