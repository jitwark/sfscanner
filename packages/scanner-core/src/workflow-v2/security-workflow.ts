import type { ScannerLimitsV2 } from '@hub/contracts';
import type { ReadonlySourceDocumentV2, SourceMemberRefV2 } from '../source/source-types';

export type SemanticClassification =
  | 'PLAIN'
  | 'EXPRESSION'
  | 'CODE'
  | 'CREDENTIAL_REF'
  | 'SECRET_CANDIDATE';

export type SemanticFieldV2 = {
  pointer: string;
  occurrences: readonly SourceMemberRefV2[];
  value: null | boolean | number | string | readonly SemanticFieldV2[];
  classification: SemanticClassification;
};

export type NodeRefV2 = {
  ordinal: number;
  source: SourceMemberRefV2;
  explicitId?: string;
  name?: string;
  identityDigest: string;
};

export type EdgeResolution = 'RESOLVED' | 'AMBIGUOUS' | 'UNRESOLVED';

export type EdgeRefV2 = {
  ordinal: number;
  sourceNode?: NodeRefV2;
  sourceLabel: string;
  targetNode?: NodeRefV2;
  targetLabel?: string;
  connectionType: string;
  sourcePort: number;
  targetPort: number;
  source: SourceMemberRefV2;
  resolution: EdgeResolution;
};

export type SecurityNodeV2 = {
  ref: NodeRefV2;
  type: string;
  typeVersion?: string;
  disabled: boolean;
  scoringEligibility: 'ELIGIBLE' | 'INDETERMINATE';
  parameters: readonly SemanticFieldV2[];
  credentials: readonly SemanticFieldV2[];
  settings: readonly SemanticFieldV2[];
};

export type NormalizationAmbiguityKind =
  | 'DUPLICATE_MEMBER'
  | 'AMBIGUOUS_NODE'
  | 'AMBIGUOUS_EDGE'
  | 'UNRESOLVED_EDGE'
  | 'MALFORMED_SECURITY_VALUE';

export type NormalizationSecurityImpact = 'METADATA_ONLY' | 'SCORING_INPUT' | 'GRAPH_IDENTITY';
export type NormalizationResolution = 'RETAINED_ALL' | 'EXCLUDED_FROM_SCORING' | 'UNRESOLVED';

export type NormalizationAmbiguityV2 = {
  ambiguityId: string;
  kind: NormalizationAmbiguityKind;
  subject: SourceMemberRefV2;
  related: readonly SourceMemberRefV2[];
  securityImpact: NormalizationSecurityImpact;
  resolution: NormalizationResolution;
};

export type SecurityWorkflowV2 = {
  workflowFields: readonly SemanticFieldV2[];
  nodes: readonly SecurityNodeV2[];
  edges: readonly EdgeRefV2[];
  ambiguities: readonly NormalizationAmbiguityV2[];
};

export type NormalizationComplexityCause =
  | 'NODE_LIMIT'
  | 'RAW_EDGE_LIMIT'
  | 'EDGE_LIMIT'
  | 'CONNECTION_DEPTH_LIMIT'
  | 'PARAMETER_DEPTH_LIMIT'
  | 'PARAMETER_LEAF_LIMIT';

export type SecurityWorkflowCounters = {
  nodesExamined: number;
  rawEdgesExamined: number;
  edgesRetained: number;
  connectionDepth: number;
  parameterDepth: number;
  parameterLeaves: number;
};

export type SecurityWorkflowResult =
  | {
      ok: true;
      workflow: SecurityWorkflowV2;
      semanticSha256: string;
      ambiguitySha256: string;
      ambiguityCount: number;
      counters: SecurityWorkflowCounters;
    }
  | {
      ok: false;
      code: 'MALFORMED_WORKFLOW';
      message: string;
    }
  | {
      ok: false;
      code: 'WORKFLOW_TOO_COMPLEX';
      cause: NormalizationComplexityCause;
      message: string;
    };

export type NormalizationContext = {
  source: ReadonlySourceDocumentV2;
  limits: ScannerLimitsV2;
};
