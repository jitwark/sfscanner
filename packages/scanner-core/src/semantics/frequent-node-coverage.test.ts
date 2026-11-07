import { describe, expect, it } from 'vitest';
import { BUILTIN_SEMANTIC_CATALOGUE_V2 } from './builtin-catalogue';
import { resolveNodeSemantics } from './catalogue-resolver';
import { createSemanticCatalogueDigest } from './catalogue-admission';
import { resolveNodeSemanticsForScan } from './generic-fallback';

/**
 * The five families added for the v2 production cutover. Versions are the ones the available corpus
 * actually declares; the last case of each family proves the boundary is closed rather than a
 * wildcard. `telegram` typeVersion `2` was observed once upstream has not declared it, so it must
 * stay on the generic fallback.
 */
const OBSERVED = [
  ['n8n-nodes-base.gmail', ['1.0.0', '2.0.0', '2.1.0', '2.2.0'], 'message-mcp.gmail'],
  ['n8n-nodes-base.wait', ['1.0.0', '1.1.0'], 'flow-control.wait'],
  ['n8n-nodes-base.telegram', ['1.0.0', '1.1.0', '1.2.0'], 'message-mcp.telegram'],
  ['n8n-nodes-base.splitOut', ['1.0.0'], 'transform.split-out'],
  ['@n8n/n8n-nodes-langchain.outputParserStructured', ['1.0.0', '1.1.0', '1.2.0', '1.3.0'], 'ai.output-parser-structured'],
] as const;

const record = (semanticId: string) => BUILTIN_SEMANTIC_CATALOGUE_V2.records.find((item) => item.semanticId === semanticId)!;

describe('frequent node coverage', () => {
  it('resolves each family only at its declared upstream versions', () => {
    for (const [nodeType, versions, semanticId] of OBSERVED) {
      for (const version of versions) {
        expect(resolveNodeSemantics(BUILTIN_SEMANTIC_CATALOGUE_V2, { nodeType, version })?.semanticId, `${nodeType}@${version}`).toBe(semanticId);
      }
      expect(resolveNodeSemantics(BUILTIN_SEMANTIC_CATALOGUE_V2, { nodeType, version: '99.0.0' }), `${nodeType}@99`).toBeNull();
    }
  });

  it('keeps telegram typeVersion 2 on the generic fallback', () => {
    expect(resolveNodeSemantics(BUILTIN_SEMANTIC_CATALOGUE_V2, { nodeType: 'n8n-nodes-base.telegram', version: '2.0.0' })).toBeNull();
    const fallback = resolveNodeSemanticsForScan(BUILTIN_SEMANTIC_CATALOGUE_V2, {
      type: 'n8n-nodes-base.telegram',
      typeVersion: '2.0.0',
      parameters: [],
      scoringEligibility: 'ELIGIBLE',
    });
    expect(fallback?.origin).toBe('GENERIC_FALLBACK');
    expect(fallback?.semantics.semanticId).toBe('generic.fallback');
  });

  it('carries the credential, destination, effects and ports the pinned sources declare', () => {
    const gmail = record('message-mcp.gmail');
    expect(gmail.credentialPaths).toEqual(['/credentials/gmailOAuth2']);
    expect(gmail.destinationPaths).toContain('/sendTo');
    expect(gmail.effects).toEqual(['READ_EXTERNAL', 'SEND_MESSAGE', 'WRITE_EXTERNAL']);
    expect(gmail.ports).toEqual([{ type: 'main', index: 0, itemMode: 'EACH' }]);

    const telegram = record('message-mcp.telegram');
    expect(telegram.credentialPaths).toEqual(['/credentials/telegramApi']);
    expect(telegram.destinationPaths).toEqual(['/chatId']);
    expect(telegram.effects).toContain('SEND_MESSAGE');

    const structured = record('ai.output-parser-structured');
    expect(structured.effects).toEqual([]);
    expect(structured.ports.map((port) => port.type)).toEqual(['ai_languageModel', 'ai_outputParser']);

    for (const id of ['flow-control.wait', 'transform.split-out']) {
      expect(record(id).effects).toEqual([]);
      expect(record(id).credentialPaths).toEqual([]);
    }
  });

  it('recomputes the catalogue digest from the admitted body', () => {
    const { digest: _digest, ...body } = BUILTIN_SEMANTIC_CATALOGUE_V2;
    expect(BUILTIN_SEMANTIC_CATALOGUE_V2.version).toBe('2.2.0');
    expect(createSemanticCatalogueDigest(body)).toBe(BUILTIN_SEMANTIC_CATALOGUE_V2.digest);
  });
});
