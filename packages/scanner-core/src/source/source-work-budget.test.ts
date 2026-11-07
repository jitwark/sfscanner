import { describe, expect, it } from 'vitest';
import { DEFAULT_SCANNER_LIMITS_V2 } from '@hub/contracts';
import { parseSourceDocument } from './source-parser';

const encode = (text: string) => new TextEncoder().encode(text);
const parse = (text: string, maxSourceWork: number) => parseSourceDocument(encode(text), {
  ...DEFAULT_SCANNER_LIMITS_V2,
  maxSourceWork,
});

describe('source parser work budget', () => {
  it('rejects even the root context when its unit exceeds a zero budget', () => {
    expect(parse('{}', 0)).toMatchObject({
      ok: false,
      code: 'WORKFLOW_TOO_COMPLEX',
      cause: 'SOURCE_WORK_LIMIT',
    });
  });

  it('counts the root and each context depth with an inclusive maximum', () => {
    const source = '{"a":[1],"a":2}';
    const exact = parse(source, 8);
    const under = parse(source, 7);
    expect(exact).toMatchObject({ ok: true, sourceWorkUnits: 8 });
    expect(under).toMatchObject({
      ok: false,
      code: 'WORKFLOW_TOO_COMPLEX',
      cause: 'SOURCE_WORK_LIMIT',
    });
  });

  it('keeps existing parser error precedence when source work is also over budget', () => {
    expect(parseSourceDocument(encode('{}'), {
      ...DEFAULT_SCANNER_LIMITS_V2,
      maxSourceWork: 0,
      maxSyntaxNodes: 0,
    })).toMatchObject({
      ok: false,
      code: 'WORKFLOW_TOO_COMPLEX',
      cause: 'SYNTAX_NODE_LIMIT',
    });
    expect(parseSourceDocument(encode('{"a":1,"a":2}'), {
      ...DEFAULT_SCANNER_LIMITS_V2,
      maxSourceWork: 0,
      maxDuplicateKeys: 0,
    })).toMatchObject({
      ok: false,
      code: 'WORKFLOW_TOO_COMPLEX',
      cause: 'DUPLICATE_KEY_LIMIT',
    });
  });
});
