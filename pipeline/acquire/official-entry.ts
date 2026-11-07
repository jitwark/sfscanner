import type { Entry, EntryRights, EntrySource, EntryStructure, EntryWithChart, WorkflowChart } from '@hub/contracts';
import { deriveChart, deriveStructure } from '../derive/structure.js';
import * as entryIdModule from './entry-id.js';

const entryId = entryIdModule.entryId;

const slugify = typeof (entryIdModule as Record<string, unknown>).slugify === 'function'
  ? ((entryIdModule as Record<string, unknown>).slugify as (title: string, id: number | string) => string)
  : (title: string, id: number | string) => {
      const base = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 70) || 'workflow';
      return `${base}-${id}`;
    };

export type Analysis = { structure: EntryStructure; chart: WorkflowChart };

export function createOfficialRights(): EntryRights {
  return {
    status: 'link_only',
    licence: null,
    licenceUrl: null,
    reason: 'official n8n template - linked, not redistributed',
  };
}

export function responseTemplates(payload: unknown): Record<string, unknown>[] {
  if (!payload || typeof payload !== 'object') return [];
  const rec = payload as Record<string, unknown>;
  const list = Array.isArray(rec.workflows)
    ? rec.workflows
    : Array.isArray(rec.templates)
      ? rec.templates
      : Array.isArray(rec.data)
        ? rec.data
        : [];
  return list.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object'));
}

export function templateId(template: Record<string, unknown>): number {
  return typeof template.id === 'number' ? template.id : Number(template.id) || 0;
}

/** Search-listing fallback: node names only, no connections. Marked `partial`. */
export function metadataStructure(template: Record<string, unknown>): Analysis {
  const nodes = Array.isArray(template.nodes) ? template.nodes : [];
  const workflow = { nodes, connections: {} };
  return {
    structure: { ...deriveStructure(workflow), partial: true },
    chart: deriveChart(workflow),
  };
}

/**
 * Pull the workflow body out of a template detail response. The API has shipped
 * it at three different depths and once as a JSON string, so all four are read.
 * Throws rather than returning an empty workflow: "no nodes" and "we could not
 * look" are different answers.
 */
export function extractWorkflow(payload: unknown): Record<string, unknown> {
  if (!payload || typeof payload !== 'object') {
    throw new Error('invalid detail payload');
  }
  const root = payload as Record<string, unknown>;
  const outerWf = (root.workflow && typeof root.workflow === 'object'
    ? root.workflow
    : root.data && typeof root.data === 'object'
      ? root.data
      : root) as Record<string, unknown>;
  let candidate: Record<string, unknown> | undefined;

  if (outerWf) {
    if (outerWf.workflow && typeof outerWf.workflow === 'object' && Array.isArray((outerWf.workflow as Record<string, unknown>).nodes)) {
      candidate = outerWf.workflow as Record<string, unknown>;
    } else if (typeof outerWf.workflow === 'string') {
      try {
        const parsed = JSON.parse(outerWf.workflow);
        if (parsed && typeof parsed === 'object') candidate = parsed as Record<string, unknown>;
      } catch {
        // ignore
      }
    }
    if (!candidate && Array.isArray(outerWf.nodes)) {
      candidate = outerWf;
    }
  }

  if (!candidate || !Array.isArray(candidate.nodes)) {
    throw new Error('detail response did not contain nodes');
  }
  return candidate;
}

export function analyseWorkflow(workflow: Record<string, unknown>): Analysis {
  const struct = deriveStructure(workflow);
  delete struct.partial;
  return { structure: struct, chart: deriveChart(workflow) };
}

export function buildEntry(
  template: Record<string, unknown>,
  fetchedAt: string,
  analysis: Analysis,
): EntryWithChart {
  const id = templateId(template);
  const title = typeof template.name === 'string' && template.name ? template.name : `n8n workflow ${id}`;
  const description = typeof template.description === 'string' ? template.description : 'Official n8n workflow template.';
  const user = template.user && typeof template.user === 'object' ? (template.user as Record<string, unknown>) : undefined;
  const authorName = typeof user?.name === 'string' && user.name ? user.name : 'n8n';
  const userUsername = typeof user?.username === 'string' ? user.username : undefined;

  const source: EntrySource = {
    kind: 'n8n_official',
    templateId: id,
    permalink: `https://n8n.io/workflows/${id}`,
    fetchedAt,
    author: {
      name: authorName,
      ...(userUsername ? { username: userUsername } : {}),
    },
  };

  const entry: Entry = {
    id: entryId('n8n_official', 'n8n.io', String(id)),
    slug: slugify(title, id),
    title,
    summary: description.split(/[.!?]\s/u, 1)[0] || title,
    description,
    descriptionSource: typeof template.description === 'string' && template.description ? 'upstream' : 'fallback',
    source,
    rights: createOfficialRights(),
    structure: analysis.structure,
    // Placeholder only. `Entry` requires the field, and `build-corpus` replaces
    // it with a real scan now that the body is retained. An entry that reaches
    // packaging still carrying `scannerVersion: 'unscanned'` means the body
    // never arrived — that is a bug, not a grade.
    security: {
      grade: 'UNKNOWN',
      score: 0,
      counts: { critical: 0, high: 0, medium: 0, low: 0, info: 0 },
      findings: [],
      hardenedExtra: 0,
      scannerVersion: 'unscanned',
      profile: 'beta-default',
    },
    tags: analysis.structure.integrations,
    // Left empty on purpose: `build-corpus` computes both hashes from the
    // workflow body and `elect` decides `canonical`. Inventing values here is
    // what collapsed 11,490 templates into one entry on run rederive-62.
    dedup: {
      fingerprint: '',
      structuralHash: '',
      canonical: false,
      alsoFoundIn: [],
    },
  };

  delete entry.download;
  // The chart travels beside the entry; packaging writes it to a chart shard
  // and fills `entry.chartRef`. It is never inlined into the catalogue.
  return { entry, chart: analysis.chart };
}
