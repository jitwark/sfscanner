import { describe, expect, it } from 'vitest';
import { validateScannerResultV2 } from '../../../../contracts/scanner-v2-result';
import { createNodeIdentityDigest } from '../workflow-v2/node-edge-identity';
import { scanWorkflowV2 } from './index';

/**
 * D-6 (2026-10-17). A finding-bearing node's *name* is user-chosen display text, and the result
 * contract refuses text that looks like scanner-internal failure output (`\bexception`, `error:`) or
 * a credential (`token:`). A label only reaches the result when a node carries a finding, so the
 * refusal arrived as a composition failure: `n8n-nodes-base.code` named `Error: boom` returned
 * `TOOL_INVARIANT_FAILED` while the same node named `Clean Name` returned `COMPLETE`, and five
 * corpus rows — node names such as `Receive Exception Request`, `Error: Slack post failed` — had no
 * verdict at all. The contract's check is the output surface's protection and is untouched; the
 * engine sanitizes the label before publishing it, so the finding and its severity survive.
 *
 * The sanitizer is not one escape for everything (see `result-v2/display-label.ts`): credential
 * names are removed, credential values redacted, and only failure-shaped prose or a shape-only path
 * is escaped. A credential must never ship in recoverable form, escaped or otherwise.
 *
 * `node.name`, `edge.sourceNode.name`, `edge.targetNode.name` and `workflow.name` are display text:
 * no identity digest, fact id or finding id is computed from them, so rewriting a label cannot move
 * a finding, a grade or a score. `node.ordinal` and `node.identityDigest` still locate the node.
 */
type Workflow = Readonly<{ name?: string; nodes: readonly unknown[]; connections: Record<string, unknown> }>;

const scan = (workflow: Workflow) => scanWorkflowV2({
  bytes: new TextEncoder().encode(JSON.stringify(workflow)),
  profile: { id: 'beta-default', version: '2.0.0' },
});

const findings = (workflow: Workflow) => {
  const result = scan(workflow);
  if (!result.ok) throw new Error(`fixture must scan: ${result.code} ${result.message}`);
  return result.result;
};

const codeNode = (name: string): Readonly<Record<string, unknown>> => ({
  parameters: { jsCode: 'eval(input)' },
  name,
  type: 'n8n-nodes-base.code',
  typeVersion: 2,
  id: 'code',
  position: [0, 0],
});

const nodeWorkflow = (name: string): Workflow => ({ nodes: [codeNode(name)], connections: {} });

const nameOf = (label: string) => {
  const result = findings(nodeWorkflow(label));
  const subject = result.findings[0]!.subject;
  if (subject.kind !== 'NODE') throw new Error('expected a node subject');
  return subject.node.name;
};

describe('D-6: an unsafe-looking node name is sanitized, not refused', () => {
  it('grades a workflow whose finding-bearing node is named "Error: boom"', () => {
    // Before the repair this scan returned `TOOL_INVARIANT_FAILED | Scanner result composition
    // failed.` — the CLI could not produce a verdict for the workflow at all.
    const result = scan(nodeWorkflow('Error: boom'));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result.analysis.status).toBe('COMPLETE');
    expect(result.result.assessment?.grade).toBe('LOW');
    expect(result.result.analysis.diagnostics).toEqual([]);
  });

  it('publishes the escaped label and keeps the finding, its rule and its severity', () => {
    const clean = findings(nodeWorkflow('Clean Name'));
    const escaped = findings(nodeWorkflow('Error: boom'));
    const cleanFinding = clean.findings[0]!;
    const escapedFinding = escaped.findings[0]!;

    // Same evidence, same verdict: only the published label differs from the run with a clean name.
    expect(cleanFinding.ruleId).toBe('N8N_CODE_NODE');
    expect(escapedFinding.ruleId).toBe(cleanFinding.ruleId);
    expect(escapedFinding.severity).toBe(cleanFinding.severity);
    expect(escapedFinding.confidence).toBe(cleanFinding.confidence);
    expect(escaped.assessment?.score).toBe(clean.assessment?.score);
    expect(escaped.assessment?.grade).toBe(clean.assessment?.grade);
    expect(escaped.findings.map(({ ruleId, severity }) => ({ ruleId, severity })))
      .toEqual(clean.findings.map(({ ruleId, severity }) => ({ ruleId, severity })));
    expect([...escaped.facts.map(({ kind }) => kind)].sort()).toEqual([...clean.facts.map(({ kind }) => kind)].sort());
    // The label is escaped where it is published; the raw trigger never reaches the output.
    expect(nameOf('Error: boom')).toBe('E\\rror: boom');
    expect(nameOf('Clean Name')).toBe('Clean Name');
    expect(JSON.stringify(escaped)).not.toContain('"name":"Error: boom"');
    expect(validateScannerResultV2(escaped).ok).toBe(true);
    // Restoring the raw label is the *only* change the contract then refuses: the escape is exactly
    // the difference between the composed evidence and the published one.
    const raw = structuredClone(escaped) as { findings: { subject: { node: { name: string } } }[] };
    raw.findings[0]!.subject.node.name = 'Error: boom';
    expect(validateScannerResultV2(raw)).toMatchObject({ ok: false });
  });

  it('leaves a name the publication rule already accepts byte-identical', () => {
    // A colon is not unsafe on its own, and only the trigger vocabulary is escaped, so labels the
    // contract accepted before the repair still publish exactly as authored.
    expect(nameOf('HTTP: fetch orders')).toBe('HTTP: fetch orders');
    expect(nameOf('Error handling')).toBe('Error handling');
    expect(nameOf('Recepción: pedidos')).toBe('Recepción: pedidos');
    expect(nameOf('Exemption log')).toBe('Exemption log');
  });

  it('grades the five corpus label shapes that were refused', () => {
    // The node names behind the five `TOOL_INVARIANT_FAILED` corpus rows (measured on the corpus,
    // one per row): `049a7e2f`, `0f1de820`, `2d2bd220`, `63bc2491`, `b0151b97`.
    const labels = [
      'Receive Exception Request',
      'Prepare Exception Record',
      'Exception Escalation Agent Tool',
      'Error: Slack post failed',
      'Create Exception Record',
    ];
    for (const label of labels) {
      const result = scan(nodeWorkflow(label));
      expect({ label, code: result.ok ? 'OK' : result.code }).toEqual({ label, code: 'OK' });
      if (!result.ok) continue;
      expect(result.result.analysis.status).toBe('COMPLETE');
      expect(result.result.assessment).not.toBeNull();
      expect(result.result.findings).toHaveLength(1);
      expect(validateScannerResultV2(result.result).ok).toBe(true);
    }
  });

  it('grades a workflow whose own name trips the same rule', () => {
    const workflow = { name: 'Track legal case deadlines and exceptions with Anthropic', nodes: [codeNode('Clean Name')], connections: {} };
    const result = scan(workflow);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result.workflow.name).toBe('Track legal case deadlines and e\\xceptions with Anthropic');
    expect(result.result.analysis.status).toBe('COMPLETE');
    expect(validateScannerResultV2(result.result).ok).toBe(true);
  });

  it('keeps a genuinely unsafe label out of the result rather than escaping it in', () => {
    // The engine's own content rule still refuses a label that is a URL, a path, a secret or prose
    // before the contract sees it: the workflow degrades and no label is published. Escaping is for
    // labels the engine already admitted, so this path is unchanged (the same stance as D-2).
    const result = scan(nodeWorkflow('Run https://example.invalid/hook'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result.analysis.status).toBe('INDETERMINATE');
    expect(result.result.assessment).toBeNull();
    expect(result.result.analysis.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'REQUIRED_CAPABILITY_FAILED', capabilityId: 'structural-policies' }),
    ]));
    expect(JSON.stringify(result.result)).not.toContain('example.invalid');
  });

  it('publishes no credential material from a finding-bearing node name', () => {
    // The ticket's case, kept permanently: `n8n-nodes-base.code` named `Token: sk-live-…`. The
    // engine's own content rule refuses a credential-shaped node name before composition, so the
    // workflow withholds its verdict — fail-closed, and no label is published at all.
    const result = scan(nodeWorkflow('Token: sk-live_abc123def456'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result.analysis.status).toBe('INDETERMINATE');
    expect(result.result.assessment).toBeNull();
    expect(JSON.stringify(result.result)).not.toContain('sk-live');
  });

  it('redacts a credential value in the label the composition seam does reach', () => {
    // A workflow *name* passes the engine's own rule for a bare token shape (`safeName` nulls only a
    // name+separator), so this is the label D-6's escape used to ship as `s\k-live_…`: pattern
    // broken, payload recoverable by `replaceAll('\\', '')`. The sanitizer redacts the value.
    const result = findings({ name: 'sk-live_abc123def456', nodes: [codeNode('Clean Name')], connections: {} });

    expect(result.workflow.name).toBe('[REDACTED]');
    expect(result.workflow.name ?? '').not.toContain('sk-live');
    expect(result.workflow.name!.replaceAll('\\', '')).not.toContain('sk-live');
    expect(JSON.stringify(result)).not.toContain('sk-live');
    expect(validateScannerResultV2(result).ok).toBe(true);
  });

  it('publishes no credential when name removal would destroy the value boundary', () => {
    // Reviewer F1, end-to-end: these workflow names reach the composition seam (`safeName` does not
    // cover `credential:`, `authorization:` or `cookie:`), the contract refuses them, and the old
    // single-pass sanitizer published `db_sk-live_…` — token intact, `\b` gone, validation fooled.
    const labels = [
      'db_credential:sk-live_abc123def456',
      'my_credential:sk-live_abc123def456',
      'prod_authorization:sk-live_abc123def456',
      'prod_authorization:AKIAABCDEFGHIJKLMNOP',
      'xcredential:AKIAABCDEFGHIJKLMNOP',
      'xcredential:eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0',
      'xcookie:eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0',
      'xbearer:sk-live_abc123def456',
      // A splice manufactured *by* the removal (`credential:` gone → `sk-live_…`): the case the
      // value-first ordering exists for, so the fix cannot pass by handling a single order.
      'scredential:k-live_abc123def456',
    ];
    const tokens = ['sk-live_abc123def456', 'AKIAABCDEFGHIJKLMNOP', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0'];
    for (const label of labels) {
      const result = findings({ name: label, nodes: [codeNode('Clean Name')], connections: {} });
      const published = result.workflow.name ?? '';
      const serialized = JSON.stringify(result);
      for (const token of tokens) {
        // The token is absent from the published string itself, escaped or not — the assertion is
        // about what ships, not about which pass ran.
        expect({ label, token, inName: published.includes(token), inSerialized: serialized.includes(token), recoverable: published.replaceAll('\\', '').includes(token) })
          .toEqual({ label, token, inName: false, inSerialized: false, recoverable: false });
      }
      expect(validateScannerResultV2(result).ok).toBe(true);
    }
  });

  it('publishes a visible placeholder when removal would leave the label empty', () => {
    // The empty-label case: `Token:` / `secret:` sanitize to nothing. The contract's `text()` accepts
    // the empty string (the raw verdict was recorded in the report before this placeholder), but an
    // empty node name is a reader-visible non-answer and this codebase's other text validators
    // reject empty text (`advisory-admission.ts:63`, `catalogue-resolver.ts:23`), so the label
    // publishes as the same visible marker as a redacted value.
    for (const label of ['Token:', 'secret:']) {
      const result = findings(nodeWorkflow(label));
      const subject = result.findings[0]!.subject;
      if (subject.kind !== 'NODE') throw new Error('expected a node subject');
      expect({ label, name: subject.node.name }).toEqual({ label, name: '[REDACTED]' });
      expect(result.analysis.status).toBe('COMPLETE');
      expect(validateScannerResultV2(result).ok).toBe(true);
    }
    // Workflow names: `Token:` and `secret:` are nulled upstream by `safeName` and never reach the
    // seam; `Authorization:` does reach it and used to publish as the empty string.
    const authorization = findings({ name: 'Authorization:', nodes: [codeNode('Clean Name')], connections: {} });
    expect(authorization.workflow.name).toBe('[REDACTED]');
    expect(validateScannerResultV2(authorization).ok).toBe(true);
    const token = findings({ name: 'Token:', nodes: [codeNode('Clean Name')], connections: {} });
    expect(token.workflow.name).toBeNull();
  });

  it('locates a finding by ordinal and identityDigest, never by the published label', () => {
    const result = findings(nodeWorkflow('Error: boom'));
    const subject = result.findings[0]!.subject;
    if (subject.kind !== 'NODE') throw new Error('expected a node subject');
    const node = subject.node;
    // The digest is a function of the node's source member, not its name: recomputing it from the
    // published ref reproduces it, so a rewritten or redacted label cannot move it.
    expect(createNodeIdentityDigest(node.ordinal, node.source)).toBe(node.identityDigest);
    // A consumer joins a finding to its facts on (ordinal, identityDigest) without reading `name`.
    const joined = result.facts.filter((fact) => fact.subject.kind === 'NODE' && fact.subject.node.ordinal === node.ordinal && fact.subject.node.identityDigest === node.identityDigest);
    expect(joined.length).toBeGreaterThan(0);
  });

  it('shows the contract refusing the raw label, which is the surface the escape protects', () => {
    // Direct evidence that the check stayed where it was: the untouched contract refuses a raw
    // trigger in a subject name, and accepts the escaped label the engine publishes instead.
    const clean = findings(nodeWorkflow('Clean Name'));
    const raw = structuredClone(clean) as { findings: { subject: { node: { name: string } } }[] };
    raw.findings[0]!.subject.node.name = 'Error: boom';
    expect(validateScannerResultV2(raw)).toMatchObject({ ok: false });

    const escaped = structuredClone(clean) as { findings: { subject: { node: { name: string } } }[] };
    escaped.findings[0]!.subject.node.name = 'E\\rror: boom';
    expect(validateScannerResultV2(escaped).ok).toBe(true);
  });
});
