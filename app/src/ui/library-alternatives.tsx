'use client';
import { useEffect, useState } from 'react';

type LibraryAlternativesProps = { query: string; onSelect: (value: string) => void };

export function LibraryAlternatives({ query, onSelect }: LibraryAlternativesProps) {
  const [alternatives, setAlternatives] = useState<string[]>([]);
  useEffect(() => {
    let active = true;
    void import('../search/aliases').then(({ expandQueryDetails }) => {
      if (active) setAlternatives(Object.values(expandQueryDetails(query).expandedTerms).flat().slice(0, 3));
    }).catch(() => undefined);
    return () => { active = false; };
  }, [query]);
  if (alternatives.length === 0) return null;
  return <div className="mt-3 flex flex-wrap items-center gap-2"><span>Try</span>{alternatives.map((alternative) => <button key={alternative} type="button" onClick={() => onSelect(alternative)} className="min-h-11 rounded-control px-2 text-accent-text transition-colors hover:bg-raised hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-border active:bg-raised">{alternative}</button>)}</div>;
}
