import type { ChartRef, WorkflowChart } from '@hub/contracts';
import { parseWorkflowChart } from '@hub/contracts/workflow-chart';
import { loadManifest, type Manifest } from './manifest';
import { sitePath } from '../ui/site-url.mjs';

const MAX_CHART_BYTES = 512_000;

/**
 * Fetch a workflow chart out-of-line, by range request.
 *
 * A chart is one JSONL line — a few kilobytes — inside a shard that runs to
 * 16 MB. A `206` is the only acceptable answer, and the manifest is what makes
 * it verifiable: the shard's declared byte size decides whether the requested
 * range is inside the artifact at all, and its `sha256` names the release the
 * bytes came from.
 */
export async function fetchChart(chartRef: ChartRef, signal?: AbortSignal): Promise<WorkflowChart | null> {
  const result = await loadChart(chartRef, signal);
  return result.ok ? result.chart : null;
}

/** Why a chart is not on screen. `retryable` decides whether to offer a retry. */
export type ChartUnavailableReason =
  | 'no-chart'
  | 'range-unsupported'
  | 'range-mismatch'
  | 'short-body'
  | 'network'
  | 'empty'
  | 'malformed'
  | 'aborted';

/**
 * The release identity of the shard a failure came from. Present only after the
 * chart artifact resolved, because that is the only moment a digest exists —
 * `no-chart` and a manifest-load failure have no artifact to name.
 */
export type ChartRelease = { generatedAt: string; shardSha256: string };

export type ChartResult =
  | { ok: true; chart: WorkflowChart }
  | { ok: false; reason: ChartUnavailableReason; release?: ChartRelease };

/**
 * These finite outcomes used to collapse into a single `null`, so no caller
 * could tell "this workflow has no diagram" from "we could not fetch it" — and
 * `ChartLoader` rendered all of them as a pulse that never stopped (CV-1).
 */
export async function loadChart(
  chartRef: ChartRef | undefined,
  signal?: AbortSignal,
  manifestArg?: Manifest,
): Promise<ChartResult> {
  if (!chartRef) return { ok: false, reason: 'no-chart' };

  let manifest: Manifest;
  try {
    manifest = manifestArg ?? await loadManifest();
  } catch {
    // Resolved, never rejected: a rejecting loader is what produced the
    // unbounded spinner CV-1 fixed. No artifact means no release to report.
    return { ok: false, reason: 'network' };
  }

  const artifact = manifest.artifacts.find((candidate) => candidate.path === `charts/chart-${chartRef.shard}.jsonl`);
  if (!artifact) return { ok: false, reason: 'no-chart' };

  const release: ChartRelease = { generatedAt: manifest.generatedAt, shardSha256: artifact.sha256 };

  if (!Number.isSafeInteger(chartRef.shard) || chartRef.shard < 0 ||
    !Number.isSafeInteger(chartRef.offset) || chartRef.offset < 0 ||
    !Number.isSafeInteger(chartRef.length) || chartRef.length <= 0 || chartRef.length > MAX_CHART_BYTES ||
    chartRef.offset + chartRef.length > artifact.byteSize) {
    return { ok: false, reason: 'malformed', release };
  }

  const path = sitePath(`/data/charts/chart-${chartRef.shard}.jsonl`);
  const rangeHeader = `bytes=${chartRef.offset}-${chartRef.offset + chartRef.length - 1}`;

  try {
    const res = await fetch(path, { headers: { Range: rangeHeader }, signal });
    if (res.status === 200) {
      // The host ignored Range and is sending the whole shard: cancel, never read.
      await res.body?.cancel();
      return { ok: false, reason: 'range-unsupported', release };
    }
    if (res.status !== 206) return { ok: false, reason: 'network', release };

    const expected = `bytes ${chartRef.offset}-${chartRef.offset + chartRef.length - 1}/${artifact.byteSize}`;
    if (res.headers.get('content-range')?.trim() !== expected) {
      return { ok: false, reason: 'range-mismatch', release };
    }

    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.byteLength !== chartRef.length) return { ok: false, reason: 'short-body', release };
    // One JSONL line, terminated. Anything else is not the line we asked for.
    if (bytes.at(-1) !== 0x0a || bytes.indexOf(0x0a) !== bytes.length - 1) {
      return { ok: false, reason: 'malformed', release };
    }

    const line = new TextDecoder().decode(bytes).trim();
    if (!line) return { ok: false, reason: 'empty', release };
    try {
      const chart = parseWorkflowChart(JSON.parse(line));
      return chart ? { ok: true, chart } : { ok: false, reason: 'malformed', release };
    } catch {
      return { ok: false, reason: 'malformed', release };
    }
  } catch (cause) {
    const reason = cause instanceof DOMException && cause.name === 'AbortError' ? 'aborted' : 'network';
    return { ok: false, reason, release };
  }
}
