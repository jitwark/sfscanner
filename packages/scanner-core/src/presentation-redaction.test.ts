import { describe, expect, it } from 'vitest';
import { redactScanPresentation } from './presentation-redaction';

describe('R6-F2: location fields are length-bounded, findings are not', () => {
  const long = 'A'.repeat(5000);

  it('bounds a diagnostic JSON pointer built from a hostile node name', () => {
    const out = redactScanPresentation({
      analysisDiagnostics: [{
        code: 'MALFORMED_CONNECTION_INDEX',
        category: 'GRAPH',
        location: { path: `/connections/${long}/main/0/0/index` },
      }],
    });
    expect(out.analysisDiagnostics[0].location.path.length).toBe(240);
    expect(out.analysisDiagnostics[0].location.path.endsWith('…')).toBe(true);
  });

  it('bounds nodeName and nodeId at 160, matching the SARIF exporter', () => {
    const out = redactScanPresentation({
      analysisDiagnostics: [{ location: { nodeName: long, nodeId: long } }],
    });
    expect(out.analysisDiagnostics[0].location.nodeName.length).toBe(160);
    expect(out.analysisDiagnostics[0].location.nodeId.length).toBe(160);
  });

  it('leaves finding evidence and display text at full length', () => {
    // These carry their own truncation rules. Shortening them here would change
    // what a report says a policy actually found.
    const out = redactScanPresentation({
      findings: [{ evidence: 'B'.repeat(500), displayText: 'C'.repeat(500) }],
    });
    expect(out.findings[0].evidence.length).toBe(500);
    expect(out.findings[0].displayText.length).toBe(500);
  });

  it('leaves a short pointer exactly as it was', () => {
    const out = redactScanPresentation({
      analysisDiagnostics: [{ location: { path: '/connections/Webhook/main/0/0/index' } }],
    });
    expect(out.analysisDiagnostics[0].location.path).toBe('/connections/Webhook/main/0/0/index');
  });
});

describe('Q06: secret-shaped node and edge labels are redacted', () => {
  const API_KEY_CANARY = 'api_key_canary_9ab712345678';
  const SECRET_TOKEN_CANARY = 'secret_token_canary_AWS_credential';
  const DIGEST = 'd'.repeat(64);
  const SOURCE = {
    pointer: '/nodes/0',
    occurrencePath: [0],
    astNodeId: 'c'.repeat(64),
    span: {
      start: { line: 1, column: 1, utf16Offset: 0, utf8ByteOffset: 0 },
      end: { line: 1, column: 6, utf16Offset: 5, utf8ByteOffset: 5 },
    },
  };
  const node = (ordinal: number, explicitId: string, name: string) => ({ ordinal, explicitId, name, identityDigest: DIGEST, source: SOURCE });
  const edge = (ordinal: number, sourceLabel: string, targetLabel: string) => ({
    ordinal, sourceLabel, targetLabel, connectionType: 'main', sourcePort: 0, targetPort: 0, source: SOURCE, resolution: 'RESOLVED',
  });
  const result = {
    findings: [
      {
        findingId: 'a'.repeat(64),
        subject: { kind: 'NODE', node: node(7, API_KEY_CANARY, SECRET_TOKEN_CANARY) },
        traceRefs: [{ ordinal: 0, subject: { kind: 'EDGE', edge: edge(2, API_KEY_CANARY, SECRET_TOKEN_CANARY) } }],
      },
      {
        findingId: 'b'.repeat(64),
        subject: { kind: 'NODE', node: node(1, 'command', 'Run') },
        traceRefs: [{ ordinal: 1, subject: { kind: 'EDGE', edge: edge(3, 'main', 'Run') } }],
      },
    ],
  };

  it('redacts node ids/names and edge labels without touching identity, spans or ordinary labels', () => {
    const out = redactScanPresentation(result);
    const serialized = JSON.stringify(out);
    expect(serialized).not.toContain(API_KEY_CANARY);
    expect(serialized).not.toContain(SECRET_TOKEN_CANARY);
    const [hostile, ordinary] = out.findings;
    expect([hostile.subject.node.explicitId, hostile.subject.node.name]).toEqual(['[REDACTED]', '[REDACTED]']);
    expect([hostile.traceRefs[0].subject.edge.sourceLabel, hostile.traceRefs[0].subject.edge.targetLabel]).toEqual(['[REDACTED]', '[REDACTED]']);
    expect([hostile.subject.node.ordinal, hostile.subject.node.identityDigest, hostile.subject.node.source.pointer, hostile.subject.node.source.span])
      .toEqual([7, DIGEST, '/nodes/0', SOURCE.span]);
    expect([hostile.traceRefs[0].subject.edge.ordinal, hostile.traceRefs[0].subject.edge.source.span]).toEqual([2, SOURCE.span]);
    expect([ordinary.subject.node.explicitId, ordinary.subject.node.name]).toEqual(['command', 'Run']);
    expect([ordinary.traceRefs[0].subject.edge.sourceLabel, ordinary.traceRefs[0].subject.edge.targetLabel]).toEqual(['main', 'Run']);
    // Non-mutating: the caller's result still carries its own strings.
    expect(result.findings[0].subject.node.explicitId).toBe(API_KEY_CANARY);
  });

  it('redacts a secret-shaped label embedded in derived prose but not in identifiers or non-ref names', () => {
    const out = redactScanPresentation({
      humanSummary: {
        findingHighlights: [`HIGH: Raw secret in ${SECRET_TOKEN_CANARY}.`],
        riskNarrative: `Code nodes referencing ${API_KEY_CANARY} were reviewed.`,
      },
      findings: [
        { title: `Raw secret in ${SECRET_TOKEN_CANARY}`, message: `Check ${API_KEY_CANARY} now.` },
        { ruleId: 'RAW_SECRET_INDICATOR', policyId: 'RAW_SECRET_INDICATOR' },
      ],
      facts: [{
        properties: {
          observation: 'SECRET_INDICATOR',
          dataExposure: `Reachable from ${API_KEY_CANARY}.`,
          topRisks: [`Leaked ${SECRET_TOKEN_CANARY}`],
        },
      }],
      workflow: { name: 'secret-token-utils' },
      target: { communityPackages: [{ name: 'secret-token-utils' }] },
    });
    expect(out.humanSummary.findingHighlights[0]).toBe('HIGH: Raw secret in [REDACTED].');
    expect(out.humanSummary.riskNarrative).toBe('Code nodes referencing [REDACTED] were reviewed.');
    expect(out.findings[0].title).toBe('Raw secret in [REDACTED]');
    expect(out.findings[0].message).toBe('Check [REDACTED] now.');
    // Machine identifiers and enum tokens are not prose and must stay verbatim.
    expect([out.findings[1].ruleId, out.findings[1].policyId]).toEqual(['RAW_SECRET_INDICATOR', 'RAW_SECRET_INDICATOR']);
    expect(out.facts[0].properties.observation).toBe('SECRET_INDICATOR');
    expect(out.facts[0].properties.dataExposure).toBe('Reachable from [REDACTED].');
    expect(out.facts[0].properties.topRisks).toEqual(['Leaked [REDACTED]']);
    // A workflow name and a community-package name are not node identifiers.
    expect(out.workflow.name).toBe('secret-token-utils');
    expect(out.target.communityPackages[0].name).toBe('secret-token-utils');
  });

  it('redacts secret-shaped source node fields in presentation', () => {
    const input = { facts: [{ properties: { sourceNodeId: 'api_key_canary_9ab712345678', sourceNodeName: 'secret_token_canary_AWS_credential' } }] };
    const output = redactScanPresentation(input) as typeof input;
    expect(JSON.stringify(output)).not.toContain('api_key_canary_9ab712345678');
    expect(JSON.stringify(output)).not.toContain('secret_token_canary_AWS_credential');
    expect(output.facts[0]!.properties).toMatchObject({ sourceNodeId: '[REDACTED]', sourceNodeName: '[REDACTED]' });
  });

  it('redacts a secret-shaped label embedded in node and edge text, keeping the readable remainder', () => {
    const EMBEDDED = 'job-api_key_canary_9ab712345678';
    const PREFIXED = 'prefixed_secret_token_canary_AWS_credential';
    const out = redactScanPresentation({
      findings: [{
        findingId: 'a'.repeat(64),
        subject: { kind: 'NODE', node: node(7, EMBEDDED, `Run ${EMBEDDED} node`) },
        traceRefs: [{ ordinal: 0, subject: { kind: 'EDGE', edge: edge(2, `from ${EMBEDDED}`, `${PREFIXED} to`) } }],
      }],
    });
    const serialized = JSON.stringify(out);
    expect(serialized).not.toContain(API_KEY_CANARY);
    expect(serialized).not.toContain(SECRET_TOKEN_CANARY);
    const [hostile] = out.findings;
    expect([hostile.subject.node.explicitId, hostile.subject.node.name]).toEqual(['job-[REDACTED]', 'Run job-[REDACTED] node']);
    expect([hostile.traceRefs[0].subject.edge.sourceLabel, hostile.traceRefs[0].subject.edge.targetLabel]).toEqual(['from job-[REDACTED]', 'prefixed_[REDACTED] to']);
    // Identity, ordinals and spans did not move.
    expect([hostile.subject.node.ordinal, hostile.subject.node.identityDigest, hostile.subject.node.source]).toEqual([7, DIGEST, SOURCE]);
    expect([hostile.traceRefs[0].subject.edge.ordinal, hostile.traceRefs[0].subject.edge.source]).toEqual([2, SOURCE]);
  });

  it('redacts source node fields embedded in a larger string and leaves non-ref names alone', () => {
    const EMBEDDED = 'job-api_key_canary_9ab712345678';
    const PREFIXED = 'prefixed_secret_token_canary_AWS_credential';
    const out = redactScanPresentation({
      facts: [{ properties: { sourceNodeId: `node-${EMBEDDED}`, sourceNodeName: `Run ${PREFIXED} step`, sourceNodeType: 'n8n-nodes-base.httpRequest' } }],
      workflow: { name: EMBEDDED },
      target: { communityPackages: [{ name: EMBEDDED }] },
    });
    expect(out.facts[0]!.properties).toMatchObject({ sourceNodeId: 'node-job-[REDACTED]', sourceNodeName: 'Run prefixed_[REDACTED] step', sourceNodeType: 'n8n-nodes-base.httpRequest' });
    // Non-ref names are metadata, not node identifiers.
    expect(out.workflow.name).toBe(EMBEDDED);
    expect(out.target.communityPackages[0]!.name).toBe(EMBEDDED);
    // The exact canary is still fully redacted, not partially.
    const exact = redactScanPresentation({ facts: [{ properties: { sourceNodeName: API_KEY_CANARY } }] }) as { facts: { properties: { sourceNodeName: string } }[] };
    expect(exact.facts[0]!.properties.sourceNodeName).toBe('[REDACTED]');
  });
});
