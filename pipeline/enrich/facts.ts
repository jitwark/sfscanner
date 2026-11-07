import type { Entry, Complexity } from '@hub/contracts';

export type FactPacket = {
  id: string;
  title: string;
  trigger: string;
  nodeCount: number;
  integrations: string[];
  capabilities: {
    hasCode: boolean;
    hasAI: boolean;
    hasWebhook: boolean;
  };
  complexity: Complexity;
  nodeNames: string[];
};

const FORBIDDEN_WORDS = [
  // Licences
  'mit', 'apache', 'gpl', 'bsd', 'isc', 'cc0', 'unlicense', 'proprietary',
  // Security verdicts
  'secure', 'insecure', 'safe', 'unsafe', 'vulnerable', 'malicious', 'trusted',
];

function sanitizeString(str: string): string {
  let cleaned = str
    .replace(/https?:\/\/\S+/gi, '')
    .replace(/www\.\S+/gi, '')
    .replace(/(bearer|token|api[_-]?key|password|secret)\s*[:=]?\s*\S+/gi, '');

  for (const word of FORBIDDEN_WORDS) {
    const reg = new RegExp(`\\b${word}\\b`, 'gi');
    cleaned = cleaned.replace(reg, '');
  }

  return cleaned.replace(/\s+/g, ' ').trim();
}

export function buildFacts(entry: Entry, nodeNames?: string[]): FactPacket {
  const title = sanitizeString(entry.title) || 'Untitled Workflow';
  const trigger = sanitizeString(entry.structure.trigger) || 'manual';
  const integrations = Array.from(
    new Set((entry.structure.integrations || []).map((i) => i.toLowerCase().trim())),
  ).sort();

  let names: string[] = [];
  if (nodeNames && nodeNames.length > 0) {
    names = nodeNames.map((n) => sanitizeString(n)).filter(Boolean).slice(0, 8);
  } else if (entry.structure.nodeTypes && entry.structure.nodeTypes.length > 0) {
    names = entry.structure.nodeTypes
      .map((t) => sanitizeString(t.split('.').pop() || t))
      .filter(Boolean)
      .slice(0, 8);
  }

  return {
    id: entry.id,
    title,
    trigger,
    nodeCount: entry.structure.nodeCount ?? 0,
    integrations,
    capabilities: {
      hasCode: Boolean(entry.structure.hasCode),
      hasAI: Boolean(entry.structure.hasAI),
      hasWebhook: Boolean(entry.structure.hasWebhook),
    },
    complexity: entry.structure.complexity || 'simple',
    nodeNames: names,
  };
}
