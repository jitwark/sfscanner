import type { Entry } from '@hub/contracts';

export type SearchText = {
  title: string;
  summary: string;
  tags: string;
  integrations: string;
  trigger: string;
  content: string;
};

function clean(value: string): string {
  return value
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(/(?:bearer|token|api[_-]?key|password|secret)\s*[:=]?\s*\S+/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function buildSearchText(entry: Entry): SearchText {
  const content = entry.descriptionContent;
  const structured = content ? [
    content.headline, content.outcome, content.exampleScenario,
    content.beforeAfter.before, content.beforeAfter.after,
    ...content.howItWorks, ...content.limitations, content.audience,
  ] : [entry.description];
  return {
    title: clean(entry.title || ''),
    summary: clean(entry.summary || content?.summary || ''),
    tags: clean((entry.tags || []).join(' ')),
    integrations: clean((entry.structure?.integrations || []).join(' ')),
    trigger: clean(entry.structure?.trigger || 'Manual'),
    content: clean(structured.join(' ')),
  };
}
