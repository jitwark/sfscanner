import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { CorpusAnalytics } from '@hub/contracts';
import { readReleaseSnapshotSync } from '../../src/catalogue/analytics-node';
import AnalyticsPage from './page';

const root = resolve(import.meta.dirname, '../../..');
const analyticsPath = resolve(root, 'data/analytics.json');
const manifestPath = resolve(root, 'data/manifest.json');
const publicAnalyticsPath = resolve(root, 'app/public/data/analytics.json');
const publicManifestPath = resolve(root, 'app/public/data/manifest.json');

const SNAPSHOT_DATE = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  timeZone: 'UTC',
});

afterEach(() => cleanup());

describe('AnalyticsPage promoted data binding', () => {
  it('renders the current promoted totals and the manifest snapshot it belongs to', () => {
    const analyticsBytes = readFileSync(analyticsPath);
    const manifestBytes = readFileSync(manifestPath);
    const analytics = JSON.parse(analyticsBytes.toString('utf8')) as CorpusAnalytics;
    const manifest = JSON.parse(manifestBytes.toString('utf8')) as {
      generatedAt: string;
      metadata: { corpusSha256: string };
    };

    expect(readFileSync(publicAnalyticsPath).equals(analyticsBytes)).toBe(true);
    expect(readFileSync(publicManifestPath).equals(manifestBytes)).toBe(true);
    expect(createHash('sha256').update(analyticsBytes).digest('hex'))
      .toBe('297bbd5eee4ca469ca16147bbc444bd0c2a06493e8e6fceb49872ab542d992f0');
    expect(createHash('sha256').update(manifestBytes).digest('hex'))
      .toBe('40177ed565aa1babb1004e5124c8a9b455f215ff8777bfb5f80b029401a74479');
    expect(readReleaseSnapshotSync()).toEqual({
      generatedAt: manifest.generatedAt,
      corpusSha256: manifest.metadata.corpusSha256,
    });

    render(<AnalyticsPage />);
    const copy = document.body.textContent!.replace(/\s+/g, ' ');

    expect(copy).toContain(`${analytics.total.toLocaleString('en-US')} workflows`);
    expect(copy).toContain(analytics.searchable.toLocaleString('en-US'));
    expect(copy).toContain(`snapshot ${SNAPSHOT_DATE.format(new Date(manifest.generatedAt))}`);
    expect(copy).toContain(analytics.findings.workflowsWithFindings.toLocaleString('en-US'));
    expect(copy).toContain(analytics.findings.totalOccurrences.toLocaleString('en-US'));
    expect(copy).not.toContain(manifest.generatedAt);
    expect(copy).not.toContain(manifest.metadata.corpusSha256);
    expect(copy).not.toContain(analytics.v2Evidence.profileId);
    expect(copy).not.toContain('Current v2 results');
    expect(screen.queryByRole('heading', { name: 'Node semantics coverage' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Scan coverage' })).toBeNull();
  });
});
