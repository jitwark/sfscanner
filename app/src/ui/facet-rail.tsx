'use client';

import { useState } from 'react';
import { normalizeDiscoverySlug, toNormalizedTag, type FacetCounts, type TagGroup } from '@hub/contracts';
import type { SearchFilters } from '../search/search-client';

type FacetRailProps = {
  counts?: FacetCounts;
  filters: SearchFilters;
  onFilterChange: (filters: SearchFilters) => void;
  className?: string;
};

const SINGLE_GROUPS = [
  ['Rights', 'rights', 'rights', ['redistributable', 'link_only']],
  ['Complexity', 'complexity', 'complexity', ['simple', 'medium', 'complex']],
  ['Security', 'grade', 'security', ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL', 'UNKNOWN']],
] as const;
const REPEATED_GROUPS = [
  ['Trigger', 'trigger', 'trigger', ['webhook', 'schedule', 'manual', 'chat', 'form', 'email', 'execute-workflow']],
  ['Capabilities', 'capability', 'capability', ['code', 'ai', 'webhook']],
] as const;

type SingleFacet = 'rights' | 'complexity' | 'grade';
type ManyFacet = 'trigger' | 'capability' | 'integration' | 'tag';

const FACET_BUTTON = 'flex min-h-11 w-full items-center justify-between rounded-control px-2 py-2 text-left text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-border focus-visible:ring-offset-2 focus-visible:ring-offset-page active:bg-raised';
const DISCOVERY_PAGE_SIZE = 40;

function facetButtonClass(selected: boolean, disabled: boolean): string {
  if (selected) return `${FACET_BUTTON} bg-ink text-page ring-1 ring-accent-border font-bold hover:bg-ink/90`;
  if (disabled) return `${FACET_BUTTON} cursor-not-allowed text-ink-faint opacity-40`;
  return `${FACET_BUTTON} text-ink hover:bg-raised`;
}

function countFor(counts: FacetCounts | undefined, facet: string, value: string): number {
  const key = facet === 'capability' ? 'capabilities' : facet;
  return counts?.[key as keyof FacetCounts]?.[value] ?? 0;
}

function label(group: TagGroup, value: string): string {
  return toNormalizedTag(group, value, 0).label;
}

export function FacetRail({ counts, filters, onFilterChange, className = '' }: FacetRailProps) {
  const [terms, setTerms] = useState({ integration: '', tag: '' });
  const [discoveryLimits, setDiscoveryLimits] = useState({ integration: DISCOVERY_PAGE_SIZE, tag: DISCOVERY_PAGE_SIZE });
  const updateSingle = (facet: SingleFacet, value: string) =>
    onFilterChange({ ...filters, [facet]: filters[facet] === value ? '' : value });
  const updateMany = (facet: ManyFacet, value: string) => {
    const current = filters[facet];
    const values = Array.isArray(current) ? current : current ? [current] : [];
    onFilterChange({ ...filters, [facet]: values.includes(value) ? values.filter((item) => item !== value) : [...values, value] });
  };
  const clear = () => onFilterChange({ trigger: [], capability: [], complexity: '', grade: '', rights: '', integration: [], tag: [] });
  const active = Boolean(
    filters.complexity || filters.grade || filters.rights || filters.trigger?.length ||
    filters.capability?.length || filters.integration?.length || filters.tag?.length,
  );
  const discoveryLists = [
    ['Integrations', 'integration', counts?.integrations ?? {}],
    ['Tags', 'tag', counts?.tags ?? {}],
  ] as const;

  return (
    <aside className={`w-60 shrink-0 space-y-5 text-sm ${className}`}>
      <div className="flex items-center justify-between border-b border-hairline pb-2">
        <h2 className="font-display text-base font-semibold">Filters</h2>
        {active && <button type="button" onClick={clear} className="min-h-11 rounded-control px-2 text-xs text-accent-text transition-colors hover:bg-raised hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-border active:bg-raised">Clear all</button>}
      </div>
      {SINGLE_GROUPS.slice(0, 1).map(([title, facet, group, options]) => (
        <fieldset key={facet} className="space-y-1">
          <legend className="mb-1 font-mono text-xs text-ink-faint">{title}</legend>
          {options.map((value) => {
            const count = countFor(counts, facet, value);
            const selected = filters[facet] === value;
            const disabled = count === 0 && !selected;
            return <button key={value} type="button" disabled={disabled} onClick={() => updateSingle(facet, value)} aria-label={`${label(group, value)} ${count}`} aria-pressed={selected} className={facetButtonClass(selected, disabled)}><span>{label(group, value)}</span><span className="font-mono tabular-nums">{count}</span></button>;
          })}
        </fieldset>
      ))}
      {REPEATED_GROUPS.slice(0, 1).map(([title, facet, group, options]) => {
        const selected = new Set(Array.isArray(filters[facet]) ? filters[facet] : []);
        return <fieldset key={facet} className="space-y-1"><legend className="mb-1 font-mono text-xs text-ink-faint">{title}</legend>{options.map((value) => {
          const count = countFor(counts, facet, value);
          const isSelected = selected.has(value);
          const disabled = count === 0 && !isSelected;
          return <button key={value} type="button" disabled={disabled} onClick={() => updateMany(facet, value)} aria-label={`${label(group, value)} ${count}`} aria-pressed={isSelected} className={facetButtonClass(isSelected, disabled)}><span>{label(group, value)}</span><span className="font-mono tabular-nums">{count}</span></button>;
        })}</fieldset>;
      })}
      {SINGLE_GROUPS.slice(1).map(([title, facet, group, options]) => <fieldset key={facet} className="space-y-1"><legend className="mb-1 font-mono text-xs text-ink-faint">{title}</legend>{options.map((value) => { const count = countFor(counts, facet, value); const selected = filters[facet] === value; const disabled = count === 0 && !selected; return <button key={value} type="button" disabled={disabled} onClick={() => updateSingle(facet, value)} aria-label={`${label(group, value)} ${count}`} aria-pressed={selected} className={facetButtonClass(selected, disabled)}><span>{label(group, value)}</span><span className="font-mono tabular-nums">{count}</span></button>; })}</fieldset>)}
      {REPEATED_GROUPS.slice(1).map(([title, facet, group, options]) => <fieldset key={facet} className="space-y-1"><legend className="mb-1 font-mono text-xs text-ink-faint">{title}</legend>{options.map((value) => { const count = countFor(counts, facet, value); const selected = (filters[facet] ?? []).includes(value); const disabled = count === 0 && !selected; return <button key={value} type="button" disabled={disabled} onClick={() => updateMany(facet, value)} aria-label={`${label(group, value)} ${count}`} aria-pressed={selected} className={facetButtonClass(selected, disabled)}><span>{label(group, value)}</span><span className="font-mono tabular-nums">{count}</span></button>; })}</fieldset>)}
      {discoveryLists.map(([title, facet, values]) => {
        const selected = new Set(filters[facet] ?? []);
        const available = new Map(Object.entries(values));
        for (const value of selected) if (!available.has(value)) available.set(value, 0);
        const term = terms[facet];
        const normalizedTerm = normalizeDiscoverySlug(term);
        const visible = [...available].filter(([value]) => selected.has(value) || value.includes(normalizedTerm) || label(facet === 'integration' ? 'integration' : 'intent', value).toLowerCase().includes(term.toLowerCase())).sort((a, b) => Number(selected.has(b[0])) - Number(selected.has(a[0])) || b[1] - a[1]);
        const selectedVisible = visible.filter(([value]) => selected.has(value));
        const unselectedVisible = visible.filter(([value]) => !selected.has(value));
        const limited = [...selectedVisible, ...unselectedVisible.slice(0, Math.max(0, discoveryLimits[facet] - selectedVisible.length))];
        const remaining = visible.length - limited.length;
        return <div key={facet} className="space-y-1">
          <label htmlFor={`facet-search-${facet}`} className="font-mono text-xs text-ink-faint">Filter {title.toLowerCase()}</label>
          <input id={`facet-search-${facet}`} value={term} onChange={(event) => setTerms((current) => ({ ...current, [facet]: event.target.value }))} placeholder={`Filter ${title.toLowerCase()}`} className="h-11 w-full rounded-control border border-hairline bg-panel px-2 text-sm text-ink transition-colors placeholder:text-ink-faint hover:border-ink-muted focus-visible:border-accent-border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-border" />
          <fieldset className="space-y-1"><legend className="sr-only">{title}</legend>{limited.length === 0 ? <p role="status" className="py-2 text-xs text-ink-faint">No matching {title.toLowerCase()}.</p> : limited.map(([value, count]) => {
          const isSelected = selected.has(value);
          const disabled = count === 0 && !isSelected;
          return <button key={value} type="button" disabled={disabled} onClick={() => updateMany(facet, value)} aria-label={`${label(facet === 'integration' ? 'integration' : 'intent', value)} ${count}`} aria-pressed={isSelected} className={facetButtonClass(isSelected, disabled)}><span className="min-w-0 break-words whitespace-normal pr-2">{label(facet === 'integration' ? 'integration' : 'intent', value)}</span><span className="font-mono tabular-nums">{count}</span></button>;
          })}</fieldset>
          {remaining > 0 && <button type="button" onClick={() => setDiscoveryLimits((current) => ({ ...current, [facet]: current[facet] + DISCOVERY_PAGE_SIZE }))} className="mt-1 min-h-11 w-full rounded-control px-2 text-left text-xs text-accent-text transition-colors hover:bg-raised hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-border focus-visible:ring-offset-2 focus-visible:ring-offset-page">Show {remaining} more {facet === 'tag' ? 'tags' : 'integrations'}</button>}
        </div>;
      })}
    </aside>
  );
}
