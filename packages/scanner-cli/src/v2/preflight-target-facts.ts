export type PinnedTargetSourceV1 = Readonly<{
  kind: 'PINNED_SOURCE';
  tag: 'n8n@2.0.0' | 'n8n@2.45.6';
  commit: string;
  path: string;
  startLine: number;
  endLine: number;
  sha256: string;
}>;

export type PinnedTargetFactV1 = Readonly<{
  version: '2.0.0' | '2.45.6';
  nodeType: 'n8n-nodes-base.executeCommand';
  source: string;
  evidence: PinnedTargetSourceV1;
}>;

const NODES_CONFIG = 'packages/@n8n/config/src/configs/nodes.config.ts';
const PINNED_TARGET_FACTS: Readonly<Record<'2.0.0' | '2.45.6', PinnedTargetFactV1>> = Object.freeze({
  '2.0.0': Object.freeze({
    version: '2.0.0' as const,
    nodeType: 'n8n-nodes-base.executeCommand' as const,
    source: 'https://raw.githubusercontent.com/n8n-io/n8n/a8ecda44f7627630bc8b78cf671405157ad41c4f/packages/%40n8n/config/src/configs/nodes.config.ts',
    evidence: Object.freeze({
      kind: 'PINNED_SOURCE' as const,
      tag: 'n8n@2.0.0' as const,
      commit: 'a8ecda44f7627630bc8b78cf671405157ad41c4f',
      path: NODES_CONFIG,
      startLine: 29,
      endLine: 36,
      sha256: '88f7169bf5a39d053a8b256a7711afa5f0f66c0f84eeae214497537c6a70ebe8',
    }),
  }),
  '2.45.6': Object.freeze({
    version: '2.45.6' as const,
    nodeType: 'n8n-nodes-base.executeCommand' as const,
    source: 'https://raw.githubusercontent.com/n8n-io/n8n/e1024601bc8e523198804de13d2f8e27eed92896/packages/%40n8n/config/src/configs/nodes.config.ts',
    evidence: Object.freeze({
      kind: 'PINNED_SOURCE' as const,
      tag: 'n8n@2.45.6' as const,
      commit: 'e1024601bc8e523198804de13d2f8e27eed92896',
      path: NODES_CONFIG,
      startLine: 31,
      endLine: 39,
      sha256: '1f57a7f5044d4dc2df9b5880669fa37cc4928e4564c378c8e0aef17db30b5aa3',
    }),
  }),
});

export function pinnedTargetFactV1(version: string): PinnedTargetFactV1 | undefined {
  if (version !== '2.0.0' && version !== '2.45.6') return undefined;
  return PINNED_TARGET_FACTS[version];
}
