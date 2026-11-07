import { describe, expect, test } from 'vitest';
import { invokeAntigravityProxy } from './antigravity-proxy';

describe('invokeAntigravityProxy', () => {
  test('sends only the system prompt and model-safe workflow JSON to the OpenAI-compatible endpoint', async () => {
    let request: { url: string; init: RequestInit } | undefined;
    const fetchFn: typeof fetch = async (input, init) => {
      request = { url: String(input), init: init ?? {} };
      return new Response(JSON.stringify({ choices: [{ message: { content: '[{"headline":"ok"}]' } }] }), { status: 200 });
    };

    const result = await invokeAntigravityProxy({
      baseUrl: 'http://127.0.0.1:8045/v1',
      apiKey: 'test-key',
      model: 'gemini-3.7-flash-low',
      systemPrompt: 'Explain the workflow in plain language.',
      workflows: [{ nodes: [{ type: 'n8n-nodes-base.webhook' }], connections: {} }],
      timeoutMs: 1000,
      maxOutputBytes: 4096,
      fetchFn,
    });

    expect(result).toEqual({ ok: true, data: [{ headline: 'ok' }] });
    expect(request?.url).toBe('http://127.0.0.1:8045/v1/chat/completions');
    expect(request?.init.headers).toMatchObject({ Authorization: 'Bearer test-key', 'Content-Type': 'application/json' });
    const body = JSON.parse(String(request?.init.body));
    expect(body).toMatchObject({ model: 'gemini-3.7-flash-low', temperature: 0, stream: false });
    expect(body.messages).toEqual([
      { role: 'system', content: 'Explain the workflow in plain language.' },
      { role: 'user', content: '[{"nodes":[{"type":"n8n-nodes-base.webhook"}],"connections":{}}]' },
    ]);
  });

  test('fails closed when proxy configuration is partial', async () => {
    const result = await invokeAntigravityProxy({
      baseUrl: 'http://127.0.0.1:8045/v1',
      apiKey: '',
      model: 'gemini-3.7-flash-low',
      systemPrompt: 'prompt',
      workflows: [],
      timeoutMs: 1000,
      maxOutputBytes: 4096,
      fetchFn: fetch,
    });

    expect(result).toEqual({ ok: false, error: 'Antigravity proxy API key is missing' });
  });

  test('classifies provider policy refusals without exposing provider prose', async () => {
    const result = await invokeAntigravityProxy({
      baseUrl: 'http://127.0.0.1:8045/v1',
      apiKey: 'test-key',
      model: 'gemini-3.7-flash-low',
      systemPrompt: 'prompt',
      workflows: [{ nodes: [], connections: {} }],
      timeoutMs: 1000,
      maxOutputBytes: 4096,
      fetchFn: async () => new Response(JSON.stringify({ choices: [{ message: { content: 'The prompt could not be submitted because of the Generative AI Prohibited Use policy.' } }] }), { status: 200 }),
    });

    expect(result).toEqual({ ok: false, error: 'Antigravity proxy policy refusal' });
  });
});
