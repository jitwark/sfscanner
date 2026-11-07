import type { Entry } from '@hub/contracts';
import { makeEntry } from '../test-support/make-entry';
import { MANIFEST_SCHEMA_VERSION, type Manifest } from './manifest';

export function makeTestEntry(status: 'redistributable' | 'link_only', overrides: Partial<Entry> = {}): Entry {
  return makeEntry({
    id: 'test-id-1', slug: 'test-workflow-slug', title: 'Test Workflow', summary: 'Test summary',
    description: 'Test description detail for workflow testing.',
    source: { kind: 'github', permalink: 'https://github.com/test/repo', fetchedAt: '2026-08-13T00:00:00.000Z' },
    rights: { status, licence: status === 'redistributable' ? 'MIT' : null, licenceUrl: null, reason: 'test reason' },
    structure: {
      nodeCount: 2, rawNodeCount: 2, connectionCount: 1, nodeTypes: ['n8n-nodes-base.manualTrigger'],
      integrations: [], trigger: 'manualTrigger', complexity: 'simple', hasCode: false, hasAI: false, hasWebhook: false,
    },
    // `sha256` is only well-formed: this fixture has no packed bytes to hash and
    // is never fetched. `download-http.test.ts` hashes real bytes.
    tags: [], download: status === 'redistributable' ? { pack: 0, line: 0, offset: 0, length: 200, sha256: 'a'.repeat(64) } : undefined,
    ...overrides,
  });
}

export function makeManifestFor(entry: Entry): Manifest {
  const download = entry.download!;
  return {
    schemaVersion: MANIFEST_SCHEMA_VERSION, generatedAt: '2026-08-13T00:00:00.000Z', totalEntries: 1,
    catalogueShards: { [entry.id]: 0 },
    artifacts: [{
      path: `packs/pack-${download.pack}.jsonl`, byteSize: download.offset + download.length, sha256: '0'.repeat(64),
      entryCount: download.line + 1, entryRange: [0, download.line], offsets: [download.offset], lengths: [download.length],
    }],
  };
}

export function workflowJsonText(nodeTypes: string[]): string {
  return JSON.stringify({
    name: 'Test workflow',
    nodes: nodeTypes.map((type, i) => ({
      id: String(i), name: `Node ${i}`, type, typeVersion: 1, position: [i * 100, 0], parameters: {},
    })),
    connections: {},
  });
}

export function contentRangeFor(offset: number, length: number, totalSize: number): string {
  return `bytes ${offset}-${offset + length - 1}/${totalSize}`;
}

export function padToBytes(text: string, targetBytes: number): string {
  const currentBytes = new TextEncoder().encode(text).byteLength;
  if (currentBytes > targetBytes) throw new Error(`fixture text already exceeds ${targetBytes} bytes`);
  return text + ' '.repeat(targetBytes - currentBytes);
}

export function mockRangeResponse(status: number, bytes: Uint8Array, contentRange?: string): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(contentRange !== undefined ? { 'content-range': contentRange } : {}),
    // Present so a `200` branch can prove it cancelled without reading.
    body: { cancel: async () => undefined },
    arrayBuffer: async () => Uint8Array.from(bytes).buffer,
  } as unknown as Response;
}
