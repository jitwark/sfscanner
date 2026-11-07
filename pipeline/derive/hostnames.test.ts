import { describe, expect, it } from 'vitest';
import { deriveHostnames } from './hostnames.js';

function workflowWithUrl(url: unknown, key = 'url'): unknown {
  return {
    nodes: [
      {
        id: '1',
        name: 'HTTP Request',
        type: 'n8n-nodes-base.httpRequest',
        parameters: { [key]: url },
      },
    ],
  };
}

describe('deriveHostnames', () => {
  it('extracts a literal host from a fully determined URL', () => {
    const result = deriveHostnames(workflowWithUrl('https://api.stripe.com/v1/charges'));
    expect(result.literal).toEqual(['api.stripe.com']);
    expect(result.dynamic).toEqual([]);
    expect(result.undeterminable).toBe(0);
  });

  it('reports a known host with a templated path as dynamic, not literal', () => {
    const result = deriveHostnames(
      workflowWithUrl('=https://api.stripe.com/v1/customers/{{ $json.id }}'),
    );
    expect(result.literal).toEqual([]);
    expect(result.dynamic).toEqual([{ host: 'api.stripe.com' }]);
    expect(result.undeterminable).toBe(0);
  });

  it('marks a fully templated URL as undeterminable without guessing a host', () => {
    const result = deriveHostnames(workflowWithUrl('={{ $json.fullUrl }}'));
    expect(result.literal).toEqual([]);
    expect(result.dynamic).toEqual([]);
    expect(result.undeterminable).toBe(1);
  });

  it('marks a templated host segment as undeterminable, not a guessed suffix', () => {
    const result = deriveHostnames(
      workflowWithUrl('=https://{{ $json.subdomain }}.stripe.com/v1/x'),
    );
    expect(result.literal).toEqual([]);
    expect(result.dynamic).toEqual([]);
    expect(result.undeterminable).toBe(1);
  });

  it('detects $node[...] expressions as dynamic', () => {
    const result = deriveHostnames(
      workflowWithUrl("=https://api.example.com/{{ $node['Prev'].json.id }}"),
    );
    expect(result.dynamic).toEqual([{ host: 'api.example.com' }]);
    expect(result.undeterminable).toBe(0);
  });

  it('ignores malformed URLs without throwing', () => {
    const result = deriveHostnames(workflowWithUrl('https://'));
    expect(result.literal).toEqual([]);
    expect(result.dynamic).toEqual([]);
    expect(result.undeterminable).toBe(0);
  });

  it('ignores plain non-URL strings without throwing', () => {
    const result = deriveHostnames(workflowWithUrl('not a url at all'));
    expect(result.literal).toEqual([]);
    expect(result.undeterminable).toBe(0);
  });

  it('ignores non-http(s) schemes', () => {
    const result = deriveHostnames(workflowWithUrl('ftp://files.example.com/report.csv'));
    expect(result.literal).toEqual([]);
    expect(result.dynamic).toEqual([]);
    expect(result.undeterminable).toBe(0);
  });

  it('collapses duplicate hosts that differ only by case, and strips trailing dots', () => {
    const result = deriveHostnames({
      nodes: [
        { id: '1', type: 'n8n-nodes-base.httpRequest', parameters: { url: 'https://API.Stripe.com./v1/a' } },
        { id: '2', type: 'n8n-nodes-base.httpRequest', parameters: { url: 'https://api.stripe.com/v1/b' } },
      ],
    });
    expect(result.literal).toEqual(['api.stripe.com']);
  });

  it('never emits the path or query of a URL, even when it carries a secret', () => {
    const result = deriveHostnames(
      workflowWithUrl('https://hooks.slack.com/services/T00/B00/XXXXSECRET'),
    );
    expect(result.literal).toEqual(['hooks.slack.com']);
    expect(JSON.stringify(result)).not.toContain('XXXXSECRET');
    expect(JSON.stringify(result)).not.toContain('services');
  });

  it('never emits a query-string secret', () => {
    const result = deriveHostnames(
      workflowWithUrl('https://api.example.com/data?api_key=SUPERSECRET123'),
    );
    expect(result.literal).toEqual(['api.example.com']);
    expect(JSON.stringify(result)).not.toContain('SUPERSECRET123');
  });

  it('never emits userinfo credentials embedded in a URL', () => {
    const result = deriveHostnames(workflowWithUrl('https://admin:hunter2@api.example.com/x'));
    expect(result.literal).toEqual(['api.example.com']);
    expect(JSON.stringify(result)).not.toContain('hunter2');
  });

  it('returns empty for empty and non-object input', () => {
    expect(deriveHostnames({})).toEqual({ literal: [], dynamic: [], undeterminable: 0 });
    expect(deriveHostnames(null)).toEqual({ literal: [], dynamic: [], undeterminable: 0 });
    expect(deriveHostnames(undefined)).toEqual({ literal: [], dynamic: [], undeterminable: 0 });
    expect(deriveHostnames('a string, not a workflow')).toEqual({ literal: [], dynamic: [], undeterminable: 0 });
    expect(deriveHostnames(42)).toEqual({ literal: [], dynamic: [], undeterminable: 0 });
    expect(deriveHostnames([])).toEqual({ literal: [], dynamic: [], undeterminable: 0 });
  });

  it('handles an oversized nodes array without hanging or throwing', () => {
    const nodes = Array.from({ length: 50_000 }, (_, index) => ({
      id: `n${index}`,
      type: 'n8n-nodes-base.httpRequest',
      parameters: { url: index === 49_999 ? 'https://should-not-be-reached.example.com/x' : 'https://api.stripe.com/x' },
    }));
    const result = deriveHostnames({ nodes });
    expect(result.literal).toContain('api.stripe.com');
    expect(result.literal.length).toBeGreaterThan(0);
  });

  it('sorts literal and dynamic output deterministically regardless of node order', () => {
    const workflow = {
      nodes: [
        { id: '1', type: 'n8n-nodes-base.httpRequest', parameters: { url: 'https://zeta.example.com/x' } },
        { id: '2', type: 'n8n-nodes-base.httpRequest', parameters: { url: 'https://alpha.example.com/x' } },
        { id: '3', type: 'n8n-nodes-base.httpRequest', parameters: { url: '=https://mid.example.com/{{ $json.x }}' } },
      ],
    };
    const result = deriveHostnames(workflow);
    expect(result.literal).toEqual(['alpha.example.com', 'zeta.example.com']);
    expect(result.dynamic).toEqual([{ host: 'mid.example.com' }]);
  });

  it('finds a fully templated endpoint via a url-ish key even without a literal scheme token', () => {
    const result = deriveHostnames(workflowWithUrl('={{ $json.endpoint }}', 'endpoint'));
    expect(result.undeterminable).toBe(1);
  });

  it('ignores an expression-bearing value under an unrelated key', () => {
    const result = deriveHostnames(workflowWithUrl('={{ $json.channelName }}', 'channel'));
    expect(result.undeterminable).toBe(0);
    expect(result.literal).toEqual([]);
    expect(result.dynamic).toEqual([]);
  });
});
