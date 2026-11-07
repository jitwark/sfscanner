import { describe, expect, it } from 'vitest';
import type { Entry } from '@hub/contracts';
import { PUBLIC_DATA_MODEL_SCHEMA_VERSION, type PublicReleaseMetadata } from '../../contracts/public-data-model.js';
import { makeEntry } from '../__fixtures__/make-entry.js';
import { SCAN_PROVENANCE_CASES, releaseForEntries } from '../__fixtures__/scan-provenance-cases.js';
import { sanitizeEntryForPublication } from '../sanitize/publication.js';
import { buildPublicProjection } from './public-projection.js';

const release: PublicReleaseMetadata = {
  releaseId: 'release-2026-08-30',
  schemaVersion: PUBLIC_DATA_MODEL_SCHEMA_VERSION,
  generatedAt: '2026-08-30T00:00:00.000Z',
  toolVersion: 'hub-pipeline@1.0.0',
  scannerVersion: 'scanner-v1',
  policyVersion: 'policy-v1',
  searchIndexVersion: 'search-v1',
  buildRevision: 'build-revision',
  manifestSha256: 'a'.repeat(64),
  corpusSha256: 'b'.repeat(64),
  counts: { workflows: 2, redistributable: 1, linkOnly: 1, excluded: 0, findings: 1 },
  facetCounts: { rights: { redistributable: 1, linkOnly: 1, excluded: 0 } },
};

const emptyReadiness = {
  credentials: [],
  replaceableValues: [],
  writeActions: [],
  aiModel: { present: false, model: null },
  extraPackages: [],
  versionNotes: [],
  pinnedData: { present: false, nodeCount: 0 },
  isSubWorkflow: false,
};

/** Two redistributable rows that differ only in how their readiness report was produced. */
const unscannedRows: Entry[] = (['derived', 'unscanned'] as const).map((analysis, index) => ({
  ...makeEntry({ id: analysis, download: { pack: 0, line: index, offset: index, length: 1 } }),
  readiness: { ...emptyReadiness, analysis, replaceableValues: [{ node: 'Webhook', field: 'parameters.url', kind: 'url' }] },
  // `makeEntry` has no `hostnames` override, so it attaches here.
  hostnames: { literal: ['api.example.test'], dynamic: [], undeterminable: 0 },
}));

const unscannedRowsBodyHashes = { derived: 'c'.repeat(64), unscanned: 'd'.repeat(64) };

const allRedistributable = {
  ...release,
  counts: { ...release.counts, workflows: 2, redistributable: 2, linkOnly: 0, findings: 0 },
  facetCounts: { rights: { redistributable: 2, linkOnly: 0, excluded: 0 } },
};

describe('buildPublicProjection privacy', () => {
  it('drops withheld endpoints from domains while keeping the neutral requirement row and public facts', () => {
    const entry = sanitizeEntryForPublication({
      ...makeEntry({
        id: 'privacy-mixed',
        description: 'Contact ops@acme-corp.com before importing.',
        rights: { status: 'link_only', licence: null, licenceUrl: null },
      }),
      hostnames: { literal: ['api.public.test', '10.0.0.5'], dynamic: [], undeterminable: 0 },
      readiness: {
        credentials: [],
        replaceableValues: [],
        writeActions: [],
        aiModel: { present: false, model: null },
        extraPackages: [],
        versionNotes: [],
        pinnedData: { present: false, nodeCount: 0 },
        isSubWorkflow: false,
      },
    });
    const privacyRelease: PublicReleaseMetadata = {
      ...release,
      counts: { workflows: 1, redistributable: 0, linkOnly: 1, excluded: 0, findings: 0 },
      facetCounts: { rights: { redistributable: 0, linkOnly: 1, excluded: 0 } },
    };

    const projection = buildPublicProjection([entry], { release: privacyRelease });

    expect(projection.workflows[0]?.description).toBe('Contact [email] before importing.');
    expect(projection.domains.map((row) => row.hostname)).toEqual(['api.public.test']);
    const domainRequirements = projection.requirements.filter((row) => row.kind === 'domain').map((row) => row.label);
    expect(domainRequirements).toContain('[private endpoint]');
    expect(domainRequirements).toContain('api.public.test');
    expect(domainRequirements).not.toContain('10.0.0.5');
  });
});

describe('buildPublicProjection', () => {
  it('builds a sorted, rights-aware allowlisted projection', () => {
    const official = makeEntry({
      id: 'official',
      source: { kind: 'n8n_official', repo: undefined, path: undefined, commit: undefined },
      rights: { status: 'link_only', licence: null, licenceUrl: null },
      structure: { partial: true, integrations: ['slack', 'webhook'], trigger: 'Webhook' },
      tags: ['z-tag', 'a-tag'],
    });
    const redistributable = makeEntry({
      id: 'alpha',
      title: '=Formula-like title',
      tags: ['a-tag'],
      structure: { integrations: ['webhook'], trigger: 'Manual' },
      download: { pack: 0, line: 4, offset: 20, length: 80 },
      security: { findings: [{ id: 'policy.secret', title: 'Secret', severity: 'HIGH', why: 'why', fix: 'fix' }] },
    });

    const projection = buildPublicProjection([official, redistributable], {
      release,
      bodySha256ByWorkflowId: { alpha: 'c'.repeat(64) },
    });

    expect(projection.workflows.map((row) => row.workflowId)).toEqual(['alpha', 'official']);
    expect(projection.workflows[0]?.body).toEqual({
      kind: 'path', path: 'packs/pack-0.jsonl', sha256: 'c'.repeat(64),
    });
    expect(projection.workflows[1]?.body).toBeNull();
    expect(projection.sources.every((row) => !('path' in row) && !('commit' in row))).toBe(true);
    expect(projection.findings[0]).toMatchObject({
      workflowId: 'alpha', policyId: 'policy.secret', confidence: 'unknown',
    });
    expect(projection.tags.map((row) => row.label)).toEqual(['a-tag', 'z-tag']);
    expect(projection.integrations.map((row) => row.label)).toEqual(['slack', 'webhook']);
    expect(projection.releases).toEqual([release]);
  });

  it('counts excluded entries without inventing exclusion or artifact rows', () => {
    const excludedRelease = {
      ...release,
      counts: { workflows: 0, redistributable: 0, linkOnly: 0, excluded: 1, findings: 0 },
      facetCounts: { rights: { redistributable: 0, linkOnly: 0, excluded: 1 } },
    };
    const entries = [makeEntry({ id: 'withheld', rights: { status: 'excluded' } })];
    const projection = buildPublicProjection(entries, { release: excludedRelease });
    expect(projection.workflows).toEqual([]);
    expect(projection.release.counts.excluded).toBe(1);
    expect(projection.exclusions).toEqual([]);
    expect(projection.artifacts).toEqual([]);
  });

  it('reports an unscanned readiness report as unknown, not known', () => {
    // A `readiness` object whose own content says the analysis never ran
    // (`analysis: 'unscanned'`) is the false clean plan 6.6 forbids when it
    // exports as `known`. The public model has no `unscanned` member and adding
    // one is a schema change, so the honest value from the existing vocabulary
    // is `unknown` — what a consumer already reads for a row with no report.
    const projection = buildPublicProjection(unscannedRows, {
      release: allRedistributable,
      bodySha256ByWorkflowId: unscannedRowsBodyHashes,
    });

    expect(projection.workflows.map((row) => [row.workflowId, row.readinessStatus]))
      .toEqual([['derived', 'known'], ['unscanned', 'unknown']]);
  });

  it('labels an unscanned row\'s historically derived requirements as unestablished', () => {
    // The domain and replaceable-value rows are the export's copy of the
    // hostname and replaceable-value data the detail UI shows. On a row with no
    // authorized body they were derived before that body went missing, so
    // publishing them as `required` claims a current requirement the data does
    // not establish. `status` is already explicit, so the label needs no new
    // field.
    const projection = buildPublicProjection(unscannedRows, {
      release: allRedistributable,
      bodySha256ByWorkflowId: unscannedRowsBodyHashes,
    });
    const statuses = (workflowId: string) => projection.requirements
      .filter((row) => row.workflowId === workflowId)
      .map((row) => `${row.kind}:${row.status}`)
      .sort();

    expect(statuses('unscanned')).toEqual(['domain:unknown', 'replaceable-value:unknown']);
    expect(statuses('derived')).toEqual(['domain:required', 'replaceable-value:required']);
    // Labelled, not suppressed: the historical values are still published.
    expect(projection.domains.map((row) => row.hostname)).toEqual(['api.example.test']);
  });

  it('treats a row with no readiness report at all the same as an unscanned one', () => {
    // An absent report means the same thing as one that says the analysis never
    // ran: nothing establishes the requirement. `readinessStatus` already reads
    // it that way, and the per-row requirement label must not disagree with it —
    // otherwise a row with no report would publish its derived domain and
    // replaceable-value rows as `required` while its own status said `unknown`.
    const noReport = {
      ...makeEntry({ id: 'no-report', download: { pack: 0, line: 0, offset: 0, length: 1 } }),
      readiness: undefined,
      hostnames: { literal: ['api.example.test'], dynamic: [], undeterminable: 0 },
    };
    const projection = buildPublicProjection([noReport], {
      release: {
        ...allRedistributable,
        counts: { workflows: 1, redistributable: 1, linkOnly: 0, excluded: 0, findings: 0 },
        facetCounts: { rights: { redistributable: 1, linkOnly: 0, excluded: 0 } },
      },
      bodySha256ByWorkflowId: { 'no-report': 'c'.repeat(64) },
    });
    const rows = projection.requirements.filter((row) => row.workflowId === 'no-report');
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => row.status === 'unknown')).toBe(true);
    expect(projection.workflows.find((row) => row.workflowId === 'no-report')?.readinessStatus).toBe('unknown');
  });

  it('drops excluded ids before any public relation is emitted', () => {
    const included = makeEntry({ id: 'included', rights: { status: 'link_only', licence: null, licenceUrl: null } });
    const excluded = makeEntry({ id: 'excluded', rights: { status: 'excluded', licence: null, licenceUrl: null } });
    const metadata = { ...release, counts: { ...release.counts, workflows: 1, redistributable: 0, linkOnly: 1, findings: 0 }, facetCounts: { rights: { redistributable: 0, linkOnly: 1, excluded: 0 } } };
    const projection = buildPublicProjection([excluded, included], { release: metadata, excludedIds: ['excluded'] });
    expect(projection.workflows.map((row) => row.workflowId)).toEqual(['included']);
    expect(projection.sources).toHaveLength(1);
    expect(projection.findings.some((row) => row.workflowId === 'excluded')).toBe(false);
  });

  it('accepts a corrected 288-count release and preserves rights/body semantics', () => {
    const redistributable = Array.from({ length: 288 }, (_, index) => makeEntry({
      id: `redistributable-${String(index).padStart(3, '0')}`,
      download: { pack: 0, line: index, offset: index, length: 1 },
    }));
    const linkOnly = makeEntry({
      id: 'link-only',
      rights: { status: 'link_only', licence: null, licenceUrl: null },
    });
    const corrected = {
      ...release,
      counts: { ...release.counts, workflows: 289, redistributable: 288, linkOnly: 1, findings: 0 },
      facetCounts: { rights: { redistributable: 288, linkOnly: 1, excluded: 0 } },
    };

    const projection = buildPublicProjection([...redistributable, linkOnly], {
      release: corrected,
      bodySha256ByWorkflowId: Object.fromEntries(redistributable.map((entry) => [entry.id, 'c'.repeat(64)])),
    });

    expect(projection.release.counts.redistributable).toBe(288);
    expect(projection.release.facetCounts.rights.redistributable).toBe(288);
    expect(projection.workflows).toHaveLength(289);
    expect(projection.workflows.find((row) => row.workflowId === 'redistributable-000')?.body).toEqual({
      kind: 'path', path: 'packs/pack-0.jsonl', sha256: 'c'.repeat(64),
    });
    expect(projection.workflows.find((row) => row.workflowId === 'link-only')?.body).toBeNull();
  });

  it('fails closed on the historical 288-vs-287 mismatch regression', () => {
    const mismatched = {
      ...release,
      counts: { ...release.counts, redistributable: 288 },
      facetCounts: { rights: { ...release.facetCounts.rights, redistributable: 287 } },
    };
    expect(() => buildPublicProjection([], { release: mismatched })).toThrow(/rights counts disagree.*redistributable 288 vs facet 287/i);
  });

  it('does not make source licence facts depend on entry order', () => {
    const licensed = makeEntry({ id: 'licensed', rights: { status: 'redistributable', licence: 'MIT', licenceUrl: 'https://spdx.org/licenses/MIT.html' } });
    const unlicensed = makeEntry({ id: 'unlicensed', rights: { status: 'link_only', licence: null, licenceUrl: null } });
    const metadata = { ...release, counts: { ...release.counts, workflows: 2, redistributable: 1, linkOnly: 1, findings: 0 }, facetCounts: { rights: { redistributable: 1, linkOnly: 1, excluded: 0 } } };
    const first = buildPublicProjection([licensed, unlicensed], { release: metadata, bodySha256ByWorkflowId: { licensed: 'c'.repeat(64) } });
    const second = buildPublicProjection([unlicensed, licensed], { release: metadata, bodySha256ByWorkflowId: { licensed: 'c'.repeat(64) } });
    expect(first.sources).toEqual(second.sources);
    expect(first.sources[0]).toMatchObject({ licence: null, licenceUrl: null });
  });

  it('gives distinct findingIds when the same policy fires more than once on one entry', () => {
    // Regression: the real corpus fires N8N_CODE_NODE once per Code node, so
    // one workflow commonly carries several findings sharing a policyId.
    // findingId must not collide just because policyId repeats.
    const repeated = makeEntry({
      id: 'repeated-policy',
      rights: { status: 'link_only', licence: null, licenceUrl: null },
      security: {
        findings: [
          { id: 'N8N_CODE_NODE', title: 'Custom code', severity: 'LOW', node: 'Code', why: 'why', fix: 'fix' },
          { id: 'N8N_CODE_NODE', title: 'Custom code', severity: 'LOW', node: 'Code1', why: 'why', fix: 'fix' },
        ],
      },
    });
    const metadata = { ...release, counts: { ...release.counts, workflows: 1, redistributable: 0, linkOnly: 1, findings: 2 }, facetCounts: { rights: { redistributable: 0, linkOnly: 1, excluded: 0 } } };
    const projection = buildPublicProjection([repeated], { release: metadata });
    expect(projection.findings).toHaveLength(2);
    expect(new Set(projection.findings.map((row) => row.findingId)).size).toBe(2);
  });
});

/**
 * The defect the audit's R09/R06 records: a mixed-engine catalogue exported rows whose grade came
 * from a retired scanner as if it were current, because the row carried no state of its own. Each
 * case is one real row shape; the assertion is that row's whole public provenance.
 */
describe('per-row scan provenance is fail-closed', () => {
  it.each([...SCAN_PROVENANCE_CASES])('$name', ({ entry, admittedIdentity, bodySha256ByWorkflowId, scanReceiptsByWorkflowId, expected }) => {
    const [row] = buildPublicProjection([entry], {
      release: releaseForEntries([entry]),
      admittedIdentity,
      bodySha256ByWorkflowId,
      scanReceiptsByWorkflowId,
    }).workflows;
    expect({
      grade: row?.grade,
      score: row?.score,
      scanEvidence: row?.scanEvidence,
      bodySha256: row?.body?.sha256 ?? null,
    }).toEqual(expected);
  });
});
