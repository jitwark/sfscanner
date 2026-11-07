import type { EntryStructure } from '@hub/contracts';
import { compareCanonicalStrings } from '@hub/contracts/stable-order';
import { getIntegrationInfo } from './integration-map.js';

export function deriveTags(input1: unknown, input2?: unknown): string[] {
  let structure: Partial<EntryStructure> = {};
  let rawNodeTypes: string[] = [];

  // Parse arguments flexibly
  if (input1 && typeof input1 === 'object') {
    if ('nodeTypes' in input1 && Array.isArray((input1 as Record<string, unknown>).nodeTypes)) {
      structure = input1 as Partial<EntryStructure>;
      if (Array.isArray(input2)) {
        rawNodeTypes = input2.map(n => typeof n === 'string' ? n : (n && typeof n === 'object' && 'type' in n ? String(n.type) : ''));
      } else {
        rawNodeTypes = structure.nodeTypes || [];
      }
    } else if (Array.isArray(input1)) {
      rawNodeTypes = input1.map(n => typeof n === 'string' ? n : (n && typeof n === 'object' && 'type' in n ? String(n.type) : ''));
      if (input2 && typeof input2 === 'object') {
        structure = input2 as Partial<EntryStructure>;
      }
    }
  }

  const techTagsSet = new Set<string>();
  const capabilityTagsSet = new Set<string>();
  const techTagCounts = new Map<string, number>();

  const lowerTypes = rawNodeTypes.map(t => t.toLowerCase());

  // 1. Integration technology tags
  for (const nodeType of rawNodeTypes) {
    const info = getIntegrationInfo(nodeType);
    if (info && info.tags) {
      for (const tag of info.tags) {
        const normTag = tag.toLowerCase().trim();
        if (normTag) {
          techTagsSet.add(normTag);
          techTagCounts.set(normTag, (techTagCounts.get(normTag) || 0) + 1);
        }
      }
    }
  }

  // 2. Capability tags
  const hasWebhook = structure.hasWebhook || lowerTypes.some(t => t.includes('webhook'));
  const hasSchedule = structure.trigger === 'Schedule' || lowerTypes.some(t => t.includes('schedule') || t.includes('cron'));
  const hasCode = structure.hasCode || lowerTypes.some(t => t.includes('code') || t.includes('function'));
  const hasAgent = lowerTypes.some(t => t.includes('langchain.agent') || t.includes('agenttool'));
  const hasRag = lowerTypes.some(t => t.includes('vectorstore') || t.includes('embeddings') || t.includes('dataloader') || t.includes('textsplitter'));
  const hasDb = lowerTypes.some(t => t.includes('postgres') || t.includes('mysql') || t.includes('mongodb') || t.includes('redis') || t.includes('supabase') || t.includes('nocodb') || t.includes('baserow') || t.includes('datatable'));
  const hasEmail = lowerTypes.some(t => t.includes('email') || t.includes('gmail') || t.includes('outlook') || t.includes('smtp'));
  const hasFile = lowerTypes.some(t => t.includes('file') || t.includes('spreadsheetfile') || t.includes('binarydata'));
  const hasScraping = lowerTypes.some(t => t.includes('apify') || t.includes('firecrawl') || t.includes('scrapegraph') || t.includes('phantombuster') || t.includes('puppeteer'));
  const hasNotification = lowerTypes.some(t => t.includes('slack') || t.includes('telegram') || t.includes('discord') || t.includes('twilio') || t.includes('whatsapp') || t.includes('teams'));

  if (hasAgent) capabilityTagsSet.add('ai-agent');
  if (hasRag) capabilityTagsSet.add('rag');
  if (hasWebhook) capabilityTagsSet.add('webhook');
  if (hasSchedule) capabilityTagsSet.add('schedule');
  if (hasCode) capabilityTagsSet.add('code');
  if (hasDb) capabilityTagsSet.add('database');
  if (hasEmail) capabilityTagsSet.add('email');
  if (hasFile) capabilityTagsSet.add('file-processing');
  if (hasScraping) capabilityTagsSet.add('scraping');
  if (hasNotification) capabilityTagsSet.add('notification');

  // 3. Complexity tag
  const complexityTag = structure.complexity || 'simple';

  // Sort tech tags by frequency (descending) then alphabetically
  const sortedTech = Array.from(techTagsSet).sort((a, b) => {
    const countA = techTagCounts.get(a) || 0;
    const countB = techTagCounts.get(b) || 0;
    if (countB !== countA) return countB - countA;
    return compareCanonicalStrings(a, b);
  });

  // Sort capability tags alphabetically
  const sortedCap = Array.from(capabilityTagsSet).sort(compareCanonicalStrings);

  // Build 12-tag budget preserving capability & complexity tags
  const reservedForCapAndComplexity = sortedCap.length + 1; // capability tags + 1 complexity tag
  const maxTechAllowed = Math.max(1, 12 - reservedForCapAndComplexity);

  const selectedTech = sortedTech.slice(0, maxTechAllowed);
  const combined = [...selectedTech, ...sortedCap];
  if (!combined.includes(complexityTag)) {
    combined.push(complexityTag);
  }

  // Deduplicate and cap at 12
  const finalTags = Array.from(new Set(combined)).slice(0, 12);
  return finalTags;
}
