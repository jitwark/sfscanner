import { describe, expect, it } from 'vitest';
import { validateScannerResultV2 } from '../../../../contracts/scanner-v2-result';
import { scanWorkflowV2 } from '../v2/index';
import { createAdmittedRuleView } from '../v2/admitted-registry';
import { redactLabelRefs, redactSecretShapedLabel, sanitizeDisplayLabel } from './display-label';
import { composeScannerResultV2 } from './compose-result';
import { createFindingId } from './identities';
import { validateTargetContextV3 } from '../semantics/target-context';
import { buildAdvisoryFactsV1 } from '../advisories/advisory-evaluation';
import { rekeyFacts } from './rekey-evidence';

/**
 * D-6. The sanitizer is pinned against the real gate rather than a copy of its vocabulary: for every
 * shape the result contract refuses in text, the sanitized label must be accepted by
 * `validateScannerResultV2` and the raw one must still be refused. If the contract's
 * `SECRET`/`UNSAFE` classes are ever widened, the raw row fails first and the sanitizer for the new
 * shape has to be taught; the check itself is never relaxed here.
 *
 * The vocabulary is three harms, not one. A credential is removed or redacted so it cannot ship;
 * failure-shaped prose is escaped so the five corpus rows D-6 rescues keep grading; neither
 * treatment is allowed to swallow the other.
 */
const scanned = (() => {
  const result = scanWorkflowV2({
    bytes: new TextEncoder().encode(JSON.stringify({
      nodes: [{ id: 'code', name: 'Clean Name', type: 'n8n-nodes-base.code', typeVersion: 2, parameters: { jsCode: 'eval(input)' }, position: [0, 0] }],
      connections: {},
    })),
    profile: { id: 'beta-default', version: '2.0.0' },
  });
  if (!result.ok) throw new Error(`fixture must scan: ${result.code}`);
  return result.result;
})();

function packageContext() {
  const { contextDigest: _contextDigest, ...body } = scanned.target;
  const target = validateTargetContextV3({ ...body, communityPackages: [{ name: 'secret-token-utils' }] });
  return { target, facts: [...scanned.facts.filter((fact) => !fact.kind.startsWith('advisory.')),
    ...rekeyFacts(buildAdvisoryFactsV1({ target }), scanned.input.semanticSha256)] };
}

type NameHolder = { findings: { subject: { node: { name: string } } }[] };

const accepted = (name: string): boolean => {
  const candidate = structuredClone(scanned) as unknown as NameHolder;
  candidate.findings[0]!.subject.node.name = name;
  return validateScannerResultV2(candidate).ok;
};

const TOKEN = 'sk-live_abc123def456';
const AWS_KEY = 'AKIAABCDEFGHIJKLMNOP';
const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0';

const ACCEPTED = ['Clean Name', 'HTTP: fetch orders', 'Error handling', 'Recepción: pedidos', 'Exemption log', '~/.n8n'];

describe('sanitizeDisplayLabel', () => {
  it('returns every label the contract already accepts untouched', () => {
    for (const label of ACCEPTED) {
      expect({ label, sanitized: sanitizeDisplayLabel(label) }).toEqual({ label, sanitized: label });
      expect(accepted(label)).toBe(true);
    }
  });

  it('removes a credential name and separator, even with no value present', () => {
    const removed: Readonly<Record<string, string>> = { 'Token:': '[REDACTED]', 'api_key=': '[REDACTED]', 'secret:': '[REDACTED]', 'Authorization:': '[REDACTED]', 'Token: ': '[REDACTED]', 'authorization=x': 'x', 'password: hunter2': ' hunter2' };
    for (const [label, expected] of Object.entries(removed)) {
      expect({ label, refused: accepted(label) }).toEqual({ label, refused: false });
      const sanitized = sanitizeDisplayLabel(label);
      // The declaration is removed whole, not merely escaped: `T\oken:` still publishes "token".
      expect({ label, sanitized }).toEqual({ label, sanitized: expected });
      expect(sanitized).not.toMatch(/(?:api[ _-]*key|password|secret|credential|authorization|cookie|bearer|token)\s*[:=]/i);
      expect({ label, sanitizedAccepted: accepted(sanitized) }).toEqual({ label, sanitizedAccepted: true });
    }
    // The full combination: the declaration goes and the value is redacted.
    expect(sanitizeDisplayLabel(`Token: ${TOKEN}`)).toBe(' [REDACTED]');
    // A label that was already empty or whitespace-only is not ours to rewrite.
    expect(sanitizeDisplayLabel('')).toBe('');
    expect(sanitizeDisplayLabel('   ')).toBe('   ');
  });

  it('redacts a credential value so it can never ship, escaped or otherwise', () => {
    for (const value of [TOKEN, AWS_KEY, JWT]) {
      const label = `Token: ${value}`;
      const sanitized = sanitizeDisplayLabel(label);
      // D-6 shipped `s\k-live-…`: the pattern was broken, the payload recoverable. Both forms now fail.
      expect({ value, sanitized, escapedShip: sanitized.replaceAll('\\', '').includes(value) }).toEqual({ value, sanitized, escapedShip: false });
      expect(sanitized).toContain('[REDACTED]');
      expect({ value, sanitizedAccepted: accepted(sanitized) }).toEqual({ value, sanitizedAccepted: true });
    }
    // A value without a field name is still a credential: D-6 left this one publishable as `A\KIA…`.
    for (const value of [TOKEN, AWS_KEY, JWT]) {
      expect(sanitizeDisplayLabel(value)).toBe('[REDACTED]');
      expect(accepted(sanitizeDisplayLabel(value))).toBe(true);
    }
    // Removing a name must not splice its neighbours into a new value shape.
    expect(sanitizeDisplayLabel('sToken:k-live_abc123def456')).toBe('[REDACTED]');
  });

  it('redacts a credential whose value boundary the name removal would destroy', () => {
    // Reviewer F1, verbatim: removing `credential:` used to leave `db_sk-live_…`, whose leading `\b`
    // is gone, so both the value pass and the contract miss it and the token published.
    const cases: Readonly<Record<string, string>> = {
      'db_credential:sk-live_abc123def456': 'db_[REDACTED]',
      'my_credential:sk-live_abc123def456': 'my_[REDACTED]',
      'prod_authorization:sk-live_abc123def456': 'prod_[REDACTED]',
      'prod_authorization:AKIAABCDEFGHIJKLMNOP': 'prod_[REDACTED]',
      'xcredential:AKIAABCDEFGHIJKLMNOP': 'x[REDACTED]',
      'xcredential:eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0': 'x[REDACTED]',
      'xcookie:eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0': 'x[REDACTED]',
      'xbearer:sk-live_abc123def456': 'x[REDACTED]',
      'xToken:sk-live_abc123def456': 'x[REDACTED]',
    };
    for (const [label, expected] of Object.entries(cases)) {
      const sanitized = sanitizeDisplayLabel(label);
      expect({ label, sanitized }).toEqual({ label, sanitized: expected });
      expect({ label, tokenAbsent: !/sk-live|AKIA|eyJ/.test(sanitized) }).toEqual({ label, tokenAbsent: true });
      // The fixed point is idempotent: a second call changes nothing.
      expect(sanitizeDisplayLabel(sanitized)).toBe(sanitized);
    }
    // F2: a removal can create a *new* class-1 match (`toToken:ken:` → `token:`), so the pass runs
    // to a fixed point rather than once; a label the passes empty gets the visible marker.
    expect(sanitizeDisplayLabel('toToken:ken:')).toBe('[REDACTED]');
    expect(sanitizeDisplayLabel(sanitizeDisplayLabel('toToken:ken:'))).toBe('[REDACTED]');
    expect(sanitizeDisplayLabel('apiToken:key=')).toBe('[REDACTED]');
  });

  it('keeps failure-shaped labels readable and publishable instead of redacting them', () => {
    for (const label of ['Exception', 'Receive Exception Request', 'Exception Escalation Agent Tool', 'Error: boom', 'stack trace']) {
      const sanitized = sanitizeDisplayLabel(label);
      // The D-6 escape stays for prose: it is insert-only, so undoing it gives the label back.
      expect({ label, restored: sanitized.replaceAll('\\', '') }).toEqual({ label, restored: label });
      expect({ label, sanitizedAccepted: accepted(sanitized) }).toEqual({ label, sanitizedAccepted: true });
    }
  });

  it('escapes shape-only labels and is idempotent', () => {
    for (const label of ['https://example.invalid/hook', '/etc/passwd', '../secrets', 'C:\\data', 'Traceback at C:\\logs']) {
      expect({ label, refused: accepted(label) }).toEqual({ label, refused: false });
      const sanitized = sanitizeDisplayLabel(label);
      expect({ label, sanitizedAccepted: accepted(sanitized) }).toEqual({ label, sanitizedAccepted: true });
      expect(sanitizeDisplayLabel(sanitized)).toBe(sanitized);
    }
  });
});

/**
 * Q06. The canonical result must not publish a node identifier that is itself a credential name.
 * The contract's `SECRET` class sees a `name: value` declaration, not `api_key_canary_…`, so this is
 * a separate, deliberately narrow shape: the whole label, one credential word, one separator, a
 * nonempty suffix. Ordinary labels and prose keep their display text.
 */
describe('redactSecretShapedLabel', () => {
  it('redacts the exact canaries the result contract cannot see', () => {
    for (const label of ['api_key_canary_9ab712345678', 'secret_token_canary_AWS_credential', 'private-key-prod-123456']) {
      expect({ label, redacted: redactSecretShapedLabel(label) }).toEqual({ label, redacted: '[REDACTED]' });
    }
  });

  it('leaves ordinary labels and credential words without a separator or suffix alone', () => {
    for (const label of ['HTTP Request', 'Send email', 'apikeyvalue', 'api_key', 'secret-token', 'my_secret_token', 'Token']) {
      expect({ label, redacted: redactSecretShapedLabel(label) }).toEqual({ label, redacted: label });
    }
  });
});

/**
 * Edge endpoint labels are connection-key node names, so they publish the same display text the
 * node refs do. These are composed directly: a scanned workflow publishes no EDGE subject, but the
 * result boundary accepts one (the compat projector produces them), so the walk is pinned here.
 */
const EDGE_SOURCE = {
  pointer: '/connections', occurrencePath: [0], astNodeId: 'a'.repeat(64),
  span: { start: { line: 1, column: 1, utf16Offset: 0, utf8ByteOffset: 0 }, end: { line: 1, column: 2, utf16Offset: 1, utf8ByteOffset: 1 } },
} as const;

const edgeSubject = (sourceLabel: string, targetLabel: string) => ({
  kind: 'EDGE' as const,
  edge: { ordinal: 0, sourceLabel, targetLabel, connectionType: 'main', sourcePort: 0, targetPort: 0, source: EDGE_SOURCE, resolution: 'RESOLVED' as const },
});

describe('redaction in canonical composition', () => {
  it('redacts connection labels on a published edge without touching identity or span', () => {
    const rule = createAdmittedRuleView().rules.get('JAVASCRIPT_DYNAMIC_EXECUTION');
    if (rule === undefined) throw new Error('fixture rule authority is incomplete');
    const canaries = ['api_key_canary_9ab712345678', 'secret_token_canary_AWS_credential'] as const;
    const findingInput = {
      ruleId: rule.ruleId, evidenceClass: 'SUSPICIOUS_SYNTAX' as const, conclusion: 'OBSERVED' as const, applicability: 'APPLICABLE' as const,
      subject: edgeSubject(canaries[0], canaries[1]), factRefs: [], traceRefs: [], remediationId: rule.remediationId,
    };
    const body = { ...findingInput, ruleRevision: rule.revision, effect: rule.effect, severity: rule.severity, confidence: rule.confidence };
    const findingId = createFindingId(body, { semanticSha256: scanned.input.semanticSha256 });
    if (scanned.assessment === null) throw new Error('fixture assessment is missing');
    // The extra finding is classified as uncertain so the assessment still accounts for it.
    const { schemaVersion: _schemaVersion, ...scannedInput } = scanned;
    const composed = composeScannerResultV2({
      ...scannedInput,
      ...packageContext(),
      findings: [...scanned.findings, findingInput],
      assessment: { ...scanned.assessment, excludedUncertainFindingIds: [findingId], unknownEvidenceCount: 1 },
    });
    expect(composed.ok, composed.ok ? '' : composed.errors.join(' | ')).toBe(true);
    if (!composed.ok) return;
    const json = JSON.stringify(composed.result);
    for (const canary of canaries) expect(json).not.toContain(canary);
    // A package name is not a node ref: it keeps its text even though it has the same shape.
    expect(redactSecretShapedLabel('secret-token-utils')).toBe('[REDACTED]');
    expect(composed.result.target.communityPackages).toEqual([{ name: 'secret-token-utils' }]);
    expect(json).toContain('secret-token-utils');
    const finding = composed.result.findings.find(({ subject }) => subject.kind === 'EDGE');
    expect(finding?.subject).toMatchObject({ kind: 'EDGE', edge: { ordinal: 0, sourceLabel: '[REDACTED]', targetLabel: '[REDACTED]', resolution: 'RESOLVED' } });
    if (finding?.subject.kind !== 'EDGE') return;
    expect(finding.subject.edge.source).toEqual(EDGE_SOURCE);
    // Identity was derived from the unredacted labels before composition and did not move.
    expect(finding.findingId).toBe(createFindingId(body, { semanticSha256: scanned.input.semanticSha256 }));
  });

  it('redacts secret-shaped source node fields anywhere in the result', () => {
    const input = { facts: [{ properties: { sourceNodeId: 'api_key_canary_9ab712345678', sourceNodeName: 'secret_token_canary_AWS_credential', sourceNodeType: 'n8n-nodes-base.httpRequest' } }] };
    const output = redactLabelRefs(input) as typeof input;
    expect(JSON.stringify(output)).not.toContain('api_key_canary_9ab712345678');
    expect(JSON.stringify(output)).not.toContain('secret_token_canary_AWS_credential');
    expect(output.facts[0]!.properties).toMatchObject({ sourceNodeId: '[REDACTED]', sourceNodeName: '[REDACTED]', sourceNodeType: 'n8n-nodes-base.httpRequest' });
  });

  /**
   * Final review. Anchoring the label rule to the whole string let `job-api_key_canary_…` publish:
   * the canary was embedded, so neither the label rule nor the contract's `name: value` class saw
   * it. The node/edge/source-node label fields now run the non-anchored matcher derived prose
   * already used, leaving the surrounding display text intact; the whole-label helper keeps its
   * anchored meaning for callers that want it.
   */
  it('redacts a canary embedded in a canonical node label without moving identity or source', () => {
    const rule = createAdmittedRuleView().rules.get('JAVASCRIPT_DYNAMIC_EXECUTION');
    if (rule === undefined) throw new Error('fixture rule authority is incomplete');
    const node = { ordinal: 4, explicitId: 'job-api_key_canary_9ab712345678', name: 'Run job-api_key_canary_9ab712345678 node', identityDigest: 'a'.repeat(64), source: EDGE_SOURCE };
    const findingInput = {
      ruleId: rule.ruleId, evidenceClass: 'SUSPICIOUS_SYNTAX' as const, conclusion: 'OBSERVED' as const, applicability: 'APPLICABLE' as const,
      subject: { kind: 'NODE' as const, node }, factRefs: [], traceRefs: [], remediationId: rule.remediationId,
    };
    const body = { ...findingInput, ruleRevision: rule.revision, effect: rule.effect, severity: rule.severity, confidence: rule.confidence };
    const findingId = createFindingId(body, { semanticSha256: scanned.input.semanticSha256 });
    if (scanned.assessment === null) throw new Error('fixture assessment is missing');
    const { schemaVersion: _schemaVersion, ...scannedInput } = scanned;
    const composed = composeScannerResultV2({
      ...scannedInput,
      ...packageContext(),
      findings: [...scanned.findings, findingInput],
      assessment: { ...scanned.assessment, excludedUncertainFindingIds: [findingId], unknownEvidenceCount: 1 },
    });
    expect(composed.ok, composed.ok ? '' : composed.errors.join(' | ')).toBe(true);
    if (!composed.ok) return;
    const json = JSON.stringify(composed.result);
    expect(json).not.toContain('api_key_canary_9ab712345678');
    const finding = composed.result.findings.find(({ findingId: id }) => id === findingId);
    expect(finding?.subject).toMatchObject({ kind: 'NODE', node: { ordinal: 4, explicitId: 'job-[REDACTED]', name: 'Run job-[REDACTED] node', identityDigest: 'a'.repeat(64) } });
    if (finding?.subject.kind !== 'NODE') return;
    // Identity was derived from the pre-redaction subject and did not move.
    expect(finding.findingId).toBe(createFindingId(body, { semanticSha256: scanned.input.semanticSha256 }));
    expect(finding.subject.node.source).toEqual(EDGE_SOURCE);
    // A community-package name is not a node ref: it keeps its text even when it has the shape.
    expect(composed.result.target.communityPackages).toEqual([{ name: 'secret-token-utils' }]);
    expect(json).toContain('secret-token-utils');
  });

  it('redacts embedded canaries in edge labels and source node fields, and keeps the anchored helper whole-label only', () => {
    const embedded = ['job-api_key_canary_9ab712345678', 'prefixed_secret_token_canary_AWS_credential'] as const;
    const input = {
      workflow: { name: embedded[0] },
      target: { communityPackages: [{ name: embedded[0] }] },
      findings: [{ subject: edgeSubject(`from ${embedded[0]}`, `${embedded[1]} to`) }],
      facts: [{ properties: { sourceNodeId: `node-${embedded[0]}`, sourceNodeName: `Run ${embedded[1]} step`, sourceNodeType: 'n8n-nodes-base.httpRequest' } }],
    };
    const output = redactLabelRefs(input) as typeof input;
    const labels = JSON.stringify([output.findings, output.facts]);
    expect(labels).not.toContain('api_key_canary_9ab712345678');
    expect(labels).not.toContain('secret_token_canary_AWS_credential');
    expect([output.findings[0]!.subject.edge.sourceLabel, output.findings[0]!.subject.edge.targetLabel]).toEqual(['from job-[REDACTED]', 'prefixed_[REDACTED] to']);
    expect(output.facts[0]!.properties).toMatchObject({ sourceNodeId: 'node-job-[REDACTED]', sourceNodeName: 'Run prefixed_[REDACTED] step', sourceNodeType: 'n8n-nodes-base.httpRequest' });
    // Non-ref names are metadata, not node identifiers.
    expect(output.workflow.name).toBe(embedded[0]);
    expect(output.target.communityPackages[0]!.name).toBe(embedded[0]);
    // The exact canary is still fully redacted, and the exported whole-label helper keeps its anchored contract.
    expect(redactLabelRefs({ properties: { sourceNodeName: 'api_key_canary_9ab712345678' } })).toEqual({ properties: { sourceNodeName: '[REDACTED]' } });
    expect(redactSecretShapedLabel(embedded[0])).toBe(embedded[0]);
  });
});
