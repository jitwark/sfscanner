export type AntigravityProxyOptions = {
  baseUrl: string;
  apiKey: string;
  model: string;
  systemPrompt: string;
  workflows: unknown[];
  timeoutMs: number;
  maxOutputBytes: number;
  fetchFn?: typeof fetch;
};

export type AntigravityProxyResult =
  | { ok: true; data: unknown[] }
  | { ok: false; error: string };

function cleanError(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text
    .replace(/(authorization|api[_ -]?key|token|secret|password)\s*[:=]\s*[^\s,;.]+/gi, '$1=[redacted]')
    .replace(/https?:\/\/[^\s]+/gi, '[url]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 240);
}

function contentText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  return value.map((part) => {
    if (typeof part === 'string') return part;
    if (part && typeof part === 'object' && 'text' in part && typeof part.text === 'string') return part.text;
    return '';
  }).join('');
}

function parseModelArray(body: string): unknown[] | undefined {
  let parsed: unknown;
  try { parsed = JSON.parse(body); } catch { return undefined; }
  if (!parsed || typeof parsed !== 'object' || !('choices' in parsed) || !Array.isArray(parsed.choices)) return undefined;
  const first = parsed.choices[0];
  const message = first && typeof first === 'object' && 'message' in first ? first.message : undefined;
  const content = message && typeof message === 'object' && 'content' in message ? message.content : undefined;
  const text = contentText(content).replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();
  if (!text) return undefined;
  try {
    const output = JSON.parse(text) as unknown;
    return Array.isArray(output) ? output : undefined;
  } catch {
    return undefined;
  }
}

export async function invokeAntigravityProxy(options: AntigravityProxyOptions): Promise<AntigravityProxyResult> {
  const baseUrl = options.baseUrl.trim().replace(/\/+$/, '');
  if (!baseUrl) return { ok: false, error: 'Antigravity proxy base URL is missing' };
  if (!options.apiKey.trim()) return { ok: false, error: 'Antigravity proxy API key is missing' };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);
  timer.unref?.();
  const fetchFn = options.fetchFn ?? fetch;
  try {
    const response = await fetchFn(`${baseUrl}/chat/completions`, {
      method: 'POST',
      signal: controller.signal,
      headers: { Authorization: `Bearer ${options.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: options.model,
        temperature: 0,
        stream: false,
        messages: [
          { role: 'system', content: options.systemPrompt },
          { role: 'user', content: JSON.stringify(options.workflows) },
        ],
      }),
    });
    const body = await response.text();
    if (Buffer.byteLength(body, 'utf8') > options.maxOutputBytes) {
      return { ok: false, error: `Antigravity proxy output exceeded cap of ${options.maxOutputBytes} bytes` };
    }
    if (!response.ok) return { ok: false, error: `Antigravity proxy HTTP ${response.status}: ${cleanError(body) || response.statusText}` };
    const data = parseModelArray(body);
    if (data) return { ok: true, data };
    const normalized = body.toLowerCase();
    if (normalized.includes('prohibited use policy') || normalized.includes('prompt could not be submitted')) {
      return { ok: false, error: 'Antigravity proxy policy refusal' };
    }
    return { ok: false, error: 'Antigravity proxy returned no parseable JSON array' };
  } catch (error) {
    return { ok: false, error: controller.signal.aborted ? `Antigravity proxy timed out after ${options.timeoutMs}ms` : `Antigravity proxy request failed: ${cleanError(error)}` };
  } finally {
    clearTimeout(timer);
  }
}

export const DEFAULT_OMP_MODEL = 'google-antigravity/gemini-3.7-flash';
export const DEFAULT_ANTIGRAVITY_PROXY_MODEL = 'gemini-3.7-flash-low';

export function resolveEnrichmentModel(): string {
  if (process.env.ANTIGRAVITY_BASE_URL?.trim()) return process.env.ANTIGRAVITY_MODEL?.trim() || DEFAULT_ANTIGRAVITY_PROXY_MODEL;
  return DEFAULT_OMP_MODEL;
}
