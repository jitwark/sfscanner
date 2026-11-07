export type CompanionStat = {
  name: string;
  count: number;
};

export type GradeSpread = {
  low: number;
  medium: number;
  high: number;
  critical: number;
  unknown: number;
};

export type HubKind = 'integration' | 'tag' | 'trigger' | 'security';

export type HubInfo = {
  kind: HubKind;
  slug: string;
  title: string;
  entryIds: string[];
  totalEntries: number;
  totalPages: number;
  companionIntegrations: CompanionStat[];
  companionTags: CompanionStat[];
  dominantTrigger: string;
  gradeSpread: GradeSpread;
  introCopy: string;
};

export type HubIndex = {
  integrations: Record<string, HubInfo>;
  tags: Record<string, HubInfo>;
  triggers: Record<string, HubInfo>;
  security: Record<string, HubInfo>;
};
