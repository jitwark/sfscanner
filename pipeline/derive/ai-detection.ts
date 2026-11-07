/**
 * Whether a node type is an AI model call.
 *
 * This exists as one shared definition because the previous rule was written
 * twice and the older copy was wrong. `deriveStructure` tested
 * `type.includes('ai')`, and `ai` is a substring of `airtable`, `gmail`,
 * `emailSend`, and `mail`. Measured over the 2,591 published entries: 48.1%
 * carried `hasAI`, and **21.8% of the whole catalogue was flagged as calling an
 * AI model when it contains no AI vendor at all**.
 *
 * That is the same defect class as counting sticky notes as complexity — a
 * plausible-looking flag that is wrong in the direction that sounds alarming,
 * and it feeds tags, facets, the search index, and the readiness report's
 * "Runs an AI model" row.
 *
 * The fix is vendor names, not a substring. Matching is on the compact type
 * segment so a package namespace cannot smuggle a match in, and each term is a
 * real provider rather than a generic word.
 */

const AI_VENDORS = [
  'openai',
  'langchain',
  'anthropic',
  'gemini',
  'claude',
  'perplexity',
  'deepseek',
  'mistral',
  'groq',
  'ollama',
  'openrouter',
  'huggingface',
  'cohere',
  'replicate',
  'bedrock',
  'vertexai',
  'azureopenai',
] as const;

/**
 * Also matched: n8n's own AI building blocks, which carry no vendor name.
 * Anchored on word boundaries within the compact type so `aiTransform` matches
 * and `airtable` cannot.
 */
const AI_PRIMITIVES = /^(?:ai(?:agent|transform|chain)|agent|chaintools?|chainllm|embeddings.*|lmchat.*|vectorstore.*|memorybuffer.*|outputparser.*|toolworkflow|toolcode)$/;

const VENDOR_PATTERN = new RegExp(AI_VENDORS.join('|'));

/** The segment after the last dot, lowercased. `@n8n/n8n-nodes-langchain.lmChatOpenAi` -> `lmchatopenai`. */
function compactType(type: string): string {
  const segments = type.split('.');
  return (segments[segments.length - 1] ?? type).toLowerCase();
}

/** True when the node calls a model, rather than merely having "ai" in its name. */
export function isAiNodeType(type: string): boolean {
  if (typeof type !== 'string' || type.length === 0) return false;
  // The langchain package name appears before the dot, so test the full type too.
  if (/n8n-nodes-langchain/i.test(type)) return true;

  const compact = compactType(type);
  return VENDOR_PATTERN.test(compact) || AI_PRIMITIVES.test(compact);
}

/** True when any node in the list calls a model. */
export function hasAiNode(types: ReadonlyArray<string>): boolean {
  return types.some(isAiNodeType);
}
