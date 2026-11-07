import type { PreviewUnavailableReason } from '../../catalogue/preview-client';
import type { ChartUnavailableReason, ChartResult } from '../../catalogue/shard-client';

export type ChartFailureReason = ChartUnavailableReason | 'timeout';
export type ChartDisplayResult = ChartResult | { ok: false; reason: 'timeout' };

export const PREVIEW_RETRYABLE: ReadonlySet<PreviewUnavailableReason> = new Set([
  'range-unsupported', 'short-body', 'hash-mismatch', 'malformed', 'network',
]);
export const CHART_RETRYABLE: ReadonlySet<ChartFailureReason> = new Set([
  'network', 'range-unsupported', 'malformed', 'timeout',
]);

export const PREVIEW_MESSAGES: Record<PreviewUnavailableReason, string> = {
  'not-found': 'A static preview is not available for this workflow.',
  'range-unsupported': 'The static preview could not be loaded: this host does not serve partial downloads.',
  'short-body': 'The static preview could not be loaded: the connection was interrupted.',
  'hash-mismatch': 'The static preview failed its integrity check.',
  malformed: 'The static preview could not be read safely.',
  network: 'The static preview could not be loaded.',
  aborted: 'The static preview request was cancelled.',
};

export const CHART_MESSAGES: Record<ChartFailureReason, string> = {
  'no-chart': 'No interactive diagram is available for this workflow.',
  'range-unsupported': 'The diagram could not be loaded: this host does not serve partial downloads.',
  'range-mismatch': 'The diagram failed its integrity check: the host returned a different byte range.',
  'short-body': 'The diagram failed its integrity check: the response body was truncated.',
  network: 'The interactive diagram could not be loaded.',
  empty: 'The interactive diagram for this workflow is empty.',
  malformed: 'The interactive diagram could not be read safely.',
  aborted: 'The interactive diagram request was cancelled.',
  timeout: 'The interactive diagram timed out while loading.',
};
