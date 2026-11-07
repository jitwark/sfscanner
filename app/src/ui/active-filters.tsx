'use client';

import { toNormalizedTag, type TagGroup } from '@hub/contracts';
import type { SearchFilters } from '../search/search-client';

type ActiveFiltersProps = {
  filters: SearchFilters;
  onFilterChange: (filters: SearchFilters) => void;
};
const EMPTY: SearchFilters = { trigger: [], capability: [], complexity: '', grade: '', rights: '', integration: [], tag: [] };
const GROUPS: Array<[keyof SearchFilters, TagGroup]> = [
  ['rights', 'rights'], ['grade', 'security'], ['trigger', 'trigger'], ['complexity', 'complexity'], ['capability', 'capability'], ['integration', 'integration'], ['tag', 'intent'],
];

type ActiveFilter = { key: keyof SearchFilters; value: string; label: string };

function activeFilters(filters: SearchFilters): ActiveFilter[] {
  return GROUPS.flatMap(([key, group]) => {
    const value = filters[key];
    const values = Array.isArray(value) ? value : value ? [String(value)] : [];
    return values.map((item) => ({ key, value: item, label: toNormalizedTag(group, item, 0).label }));
  });
}

export function activeFilterLabels(filters: SearchFilters): string[] {
  return activeFilters(filters).map((filter) => filter.label);
}

export function ActiveFilters({ filters, onFilterChange }: ActiveFiltersProps) {
  const active = activeFilters(filters);
  if (active.length === 0) return null;

  const remove = ({ key, value }: ActiveFilter) => {
    const current = filters[key];
    onFilterChange({
      ...filters,
      [key]: Array.isArray(current) ? current.filter((item) => item !== value) : '',
    });
  };

  return (
    <div aria-label="Active filters" className="flex flex-wrap items-center gap-2">
      <span className="font-mono text-2xs uppercase tracking-wider text-ink-muted font-bold">Active filters:</span>
      {active.map((filter) => (
        <button
          key={`${filter.key}:${filter.value}`}
          type="button"
          aria-label={`Remove ${filter.label}`}
          onClick={() => remove(filter)}
          className="inline-flex min-h-11 items-center gap-1.5 rounded-control border border-hairline bg-raised px-3 py-1 font-mono text-xs font-bold text-ink transition-colors hover:border-hairline-strong hover:bg-panel focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-border active:bg-panel"
        >
          <span>{filter.label}</span>
          <span className="text-ink-muted">×</span>
        </button>
      ))}
      <button
        type="button"
        onClick={() => onFilterChange(EMPTY)}
        className="min-h-11 rounded-control px-2 font-mono text-xs font-bold text-accent-text transition-colors hover:bg-raised hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-border active:bg-raised"
      >
        Clear filters
      </button>
    </div>
  );
}
