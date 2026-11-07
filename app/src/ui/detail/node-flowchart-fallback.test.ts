import { describe, it, expect } from 'vitest';
import { generateNodeFlowchartSvg } from './node-flowchart-fallback';
import type { SvgPreviewListItem } from '@hub/contracts';

describe('generateNodeFlowchartSvg', () => {
  it('handles empty nodes gracefully', () => {
    const svg = generateNodeFlowchartSvg([]);
    expect(svg).toContain('<svg');
    expect(svg).toContain('No nodes');
  });

  it('renders SVG with connected node elements and bezier paths', () => {
    const mockNodes: SvgPreviewListItem[] = [
      { id: '1', name: 'Webhook', type: 'n8n-nodes-base.webhook', category: 'trigger' },
      { id: '2', name: 'OpenAI GPT-4', type: '@n8n/n8n-nodes-langchain.lmChatOpenAi', category: 'ai' },
      { id: '3', name: 'Send Email', type: 'n8n-nodes-base.emailSend', category: 'http' },
    ];
    const svg = generateNodeFlowchartSvg(mockNodes);
    expect(svg).toContain('<svg');
    expect(svg).toContain('Webhook');
    expect(svg).toContain('OpenAI GPT-4');
    expect(svg).toContain('<path');
    expect(svg).toContain('<rect');
    expect(svg).toContain('role="img"');
  });
});
