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

export type NodeRefV2 = {
  ordinal: number;
  source: SourceMemberRefV2;
  explicitId?: string;
  name?: string;
  identityDigest: string;
};

export type EdgeRefV2 = {
  ordinal: number;
  sourceNode?: NodeRefV2;
  targetNode?: NodeRefV2;
  sourceLabel: string;
  targetLabel?: string;
  connectionType: string;
  sourcePort: number;
  targetPort: number;
  source: SourceMemberRefV2;
  resolution: 'RESOLVED' | 'AMBIGUOUS' | 'UNRESOLVED';
};

export type SubjectV2 =
  | { kind: 'WORKFLOW' }
  | { kind: 'NODE'; node: NodeRefV2 }
  | { kind: 'EDGE'; edge: EdgeRefV2 }
  | { kind: 'SOURCE'; source: SourceMemberRefV2 };

export type SourceScalarV2 =
  | { kind: 'NULL'; lexeme: string; value: null }
  | { kind: 'BOOLEAN'; lexeme: string; value: boolean }
  | { kind: 'NUMBER'; lexeme: string; value: number }
  | { kind: 'STRING'; lexeme: string; value: string };

export type SourceValueV2 =
  | SourceScalarV2
  | { kind: 'ARRAY'; ref: SourceMemberRefV2; items: readonly SourceValueV2[] }
  | { kind: 'OBJECT'; ref: SourceMemberRefV2; members: readonly SourceObjectMemberV2[] };

export type SourceObjectMemberV2 = {
  nameLexeme: string;
  name: string;
  occurrence: number;
  ref: SourceMemberRefV2;
  value: SourceValueV2;
};

export type ReadonlySourceDocumentV2 = {
  rawSha256: string;
  utf8Bytes: number;
  bom: 'NONE' | 'UTF8';
  root: SourceValueV2;
  duplicateCount: number;
  syntaxNodeCount: number;
};
