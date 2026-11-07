export type SourcePositionV2 = {
  line: number;
  column: number;
  utf16Offset: number;
  utf8ByteOffset: number;
};

export type SourceSpanV2 = { start: SourcePositionV2; end: SourcePositionV2 };

export type SourceMemberRefV2 = {
  pointer: string;
  occurrencePath: readonly number[];
  astNodeId: string;
  span: SourceSpanV2 | null;
};

export type SourceScalarV2 =
  | { kind: 'NULL'; lexeme: string; value: null }
  | { kind: 'BOOLEAN'; lexeme: string; value: boolean }
  | { kind: 'NUMBER'; lexeme: string; value: number }
  | { kind: 'STRING'; lexeme: string; value: string };

export type SourceObjectMemberV2 = {
  nameLexeme: string;
  name: string;
  occurrence: number;
  ref: SourceMemberRefV2;
  value: SourceValueV2;
};

export type SourceValueV2 = (SourceScalarV2 & { ref: SourceMemberRefV2 })
  | { kind: 'ARRAY'; ref: SourceMemberRefV2; items: readonly SourceValueV2[] }
  | { kind: 'OBJECT'; ref: SourceMemberRefV2; members: readonly SourceObjectMemberV2[] };

export type ReadonlySourceDocumentV2 = {
  rawSha256: string;
  utf8Bytes: number;
  bom: 'NONE' | 'UTF8';
  root: SourceValueV2;
  duplicateCount: number;
  syntaxNodeCount: number;
};

/**
 * What the stored-span budget actually did. `examined` is every node the parser had to place a
 * span on, `omitted` the nodes whose span the bound dropped. It is produced by the same decision
 * that keeps spans, so a run cannot report the bound as unspent while evidence is missing.
 */
export type SourceSpanUsageV2 = Readonly<{ examined: number; omitted: number }>;

export type SourceComplexityCauseV2 =
  | 'SYNTAX_NODE_LIMIT'
  | 'DOCUMENT_DEPTH_LIMIT'
  | 'MEMBER_ELEMENT_LIMIT'
  | 'DUPLICATE_KEY_LIMIT'
  | 'SOURCE_WORK_LIMIT';

export type SourceParseResult =
  | { ok: true; document: ReadonlySourceDocumentV2; sourceWorkUnits: number; sourceSpanUsage: SourceSpanUsageV2 }
  | { ok: false; code: 'UTF8_DECODING_FAILED' | 'INVALID_JSON' | 'WORKFLOW_TOO_LARGE'; message: string }
  | { ok: false; code: 'WORKFLOW_TOO_COMPLEX'; cause: SourceComplexityCauseV2; message: string };
