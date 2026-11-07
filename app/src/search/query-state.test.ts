// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createDefaultQueryState, onQueryStateChange, readQueryState, subscribeQueryState, writeQueryState } from './query-state';

beforeEach(() => { window.history.replaceState({}, '', '/library/'); });

describe('query state URL sync', () => {
  it('provides an independent default state for the hydration render', () => {
    window.history.replaceState({}, '', '/library/?q=slack&integration=slack');

    const first = createDefaultQueryState();
    const second = createDefaultQueryState();

    expect(first).toEqual({ q: '', integration: [], tag: [], trigger: [], capability: [], complexity: '', grade: '', rights: '', sort: 'relevance', page: 1 });
    expect(first.integration).not.toBe(second.integration);
  });

  it('round-trips scalar and repeatable parameters', () => {
    writeQueryState({ q: 'slack alerts', integration: ['slack', 'gmail'], tag: ['notify', 'daily'], trigger: ['Webhook', 'SCHEDULE'], capability: ['code', 'ai'], complexity: 'medium', grade: 'low', rights: 'link-only', sort: 'quality', page: 3 }, 'replace');
    expect(readQueryState()).toEqual({ q: 'slack alerts', integration: ['slack', 'gmail'], tag: ['notify', 'daily'], trigger: ['webhook', 'schedule'], capability: ['code', 'ai'], complexity: 'medium', grade: 'LOW', rights: 'link_only', sort: 'quality', page: 1 });
  });

  it('uses replaceState while typing and pushState for facets', () => {
    const replace = vi.spyOn(window.history, 'replaceState');
    const push = vi.spyOn(window.history, 'pushState');
    writeQueryState({ q: 'slack' }, 'replace');
    writeQueryState({ q: 'slack', integration: ['slack'] }, 'push');
    expect(replace).toHaveBeenCalledOnce();
    expect(push).toHaveBeenCalledOnce();
    expect(window.location.search).toContain('integration=slack');
  });
  it('notifies external-store subscribers after History API writes', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeQueryState(listener);

    writeQueryState({ q: 'slack' }, 'replace');

    expect(listener).toHaveBeenCalledOnce();
    expect(readQueryState().q).toBe('slack');
    unsubscribe();
  });
  it('keeps active facets while replacing typed query text', () => {
    writeQueryState({ q: 'first', integration: ['slack'], tag: ['alerts'] }, 'replace');
    writeQueryState({ q: 'second' }, 'replace');
    expect(readQueryState().integration).toEqual(['slack']);
    expect(readQueryState().tag).toEqual(['alerts']);
  });

  it('resets pagination when query text or filters change', () => {
    writeQueryState({ q: 'first', tag: ['alerts'], page: 4 }, 'replace');
    writeQueryState({ q: 'second' }, 'replace');
    expect(readQueryState().page).toBe(1);
    writeQueryState({ tag: ['alerts', 'daily'], page: 3 }, 'push');
    expect(readQueryState().page).toBe(1);
  });

  it('restores subscribed state on popstate', async () => {
    const listener = vi.fn();
    const unsubscribe = onQueryStateChange(listener);
    writeQueryState({ q: 'first' }, 'push');
    writeQueryState({ q: 'second', tag: ['ai'] }, 'push');
    await new Promise<void>((resolve) => {
      window.addEventListener('popstate', () => resolve(), { once: true });
      window.history.back();
    });
    expect(listener).toHaveBeenCalled();
    expect(listener.mock.lastCall?.[0].q).toBe('first');
    unsubscribe();
  });

  it('preserves unsupported filters instead of collapsing them into the intentional unknown bucket', () => {
    expect(readQueryState('/library/?trigger=Kafka+Event&trigger=unknown').trigger).toEqual([
      'kafka-event',
      'unknown',
    ]);
  });

  it('drops empty repeated values while preserving unknown tag and integration values', () => {
    expect(readQueryState('/library/?tag=&tag=Custom+Label&integration=&integration=Internal+CRM')).toMatchObject({
      tag: ['custom-label'],
      integration: ['internal-crm'],
    });
  });

  it('round-trips Unicode query text unmangled', () => {
    window.history.replaceState({}, '', '/library/');
    writeQueryState({ q: '日本語 café' }, 'replace');
    expect(readQueryState().q).toBe('日本語 café');
  });

  it('preserves the deployment base path instead of resetting to the site root', () => {
    window.history.replaceState({}, '', '/n8n-community/library/?tag=alerts');
    writeQueryState({ q: 'x' }, 'replace');
    expect(window.location.pathname).toBe('/n8n-community/library/');
    expect(readQueryState().tag).toEqual(['alerts']);
  });

  it('falls back a negative or non-integer page to 1 rather than guessing a nearby valid page', () => {
    expect(readQueryState('/library/?page=-3').page).toBe(1);
    expect(readQueryState('/library/?page=2.5').page).toBe(1);
    expect(readQueryState('/library/?page=abc').page).toBe(1);
  });
});
