/** Browser-safe prerequisite observations. These shapes describe export evidence only, never live state. */
export type RawNodeV1 = Readonly<{
  index: number;
  name: string;
  type: string;
  typeVersion: string | null;
  parameters: unknown;
  credentials: Readonly<Record<string, unknown>> | null;
}>;

export type PreflightNodeEvidenceV1 = Readonly<{
  source: 'WORKFLOW_EXPORT';
  pointer: string;
  node: string;
  nodeType: string;
  typeVersion: string | null;
}>;

export type PreflightEnvironmentV1 = Readonly<{
  namespace: 'ENV' | 'VARS';
  name: string;
  value: 'UNKNOWN';
  availability: 'UNKNOWN';
  evidence: PreflightNodeEvidenceV1;
}>;

export type PreflightProvenanceV1 = Readonly<{
  source: 'WORKFLOW_EXPORT';
  pointer: '/';
  repository: 'UNKNOWN';
  commit: 'UNKNOWN';
  licence: 'UNKNOWN';
  verification: 'UNKNOWN';
}>;

export type PreflightCredentialV1 = Readonly<{
  credentialType: string;
  credentialName: string | null;
  reference: 'ID_AND_NAME' | 'ID_ONLY' | 'NAME_ONLY' | 'EMPTY';
  node: string;
  nodeType: string;
  pointer: string;
  offlineValidity: 'UNKNOWN';
  ownership: 'UNKNOWN';
}>;

export type PreflightCommunityNodeV1 = Readonly<{
  packageName: string | null;
  nodeTypes: readonly string[];
  nodes: readonly string[];
  typeVersions: readonly string[];
  evidence: readonly PreflightNodeEvidenceV1[];
  packageVersion: null;
  installed: 'UNKNOWN';
}>;

export type PreflightIntegrationV1 = Readonly<{
  service: string;
  nodeType: string;
  nodes: readonly string[];
  credentialTypes: readonly string[];
  evidence: readonly PreflightNodeEvidenceV1[];
}>;

export type PreflightSubworkflowV1 = Readonly<{
  node: string;
  pointer: string;
  targetWorkflowId: string | null;
  resolution: 'LITERAL' | 'DYNAMIC' | 'ABSENT';
  targetExistence: 'UNKNOWN';
}>;

export type PreflightPrerequisitesV1 = Readonly<{
  credentials: readonly PreflightCredentialV1[];
  communityNodes: readonly PreflightCommunityNodeV1[];
  integrations: readonly PreflightIntegrationV1[];
  subworkflows: readonly PreflightSubworkflowV1[];
  environment: readonly PreflightEnvironmentV1[];
  provenance: PreflightProvenanceV1;
  unknowns: readonly string[];
}>;
