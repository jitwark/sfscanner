import type { ReactNode } from 'react';
import { isPending, type PendingOr } from './legal-contacts';

/**
 * Prose shell for `/terms/` and `/takedown/`.
 *
 * Deliberately does NOT render a `<main>` element. `app/app/layout.tsx` already
 * renders `<main id="main">`, and `app/app/privacy/page.tsx` renders a second
 * one inside it — two `main` landmarks and two elements sharing `id="main"`,
 * which breaks the skip link. Not repeating that here.
 */

type LegalPageProps = {
  title: string;
  intro: ReactNode;
  updated: string;
  children: ReactNode;
};

export function LegalPage({ title, intro, updated, children }: LegalPageProps) {
  return (
    <article className="mx-auto max-w-[72ch] pb-16">
      <header className="border-b border-hairline pb-6">
        <h1 className="font-display text-3xl font-semibold tracking-tight text-ink md:text-4xl">{title}</h1>
        <div className="mt-3 text-base leading-7 text-ink-muted">{intro}</div>
        <p className="mt-4 font-mono text-2xs uppercase tracking-[0.16em] text-ink-faint">
          Last updated {updated}
        </p>
      </header>
      <div className="mt-10 space-y-10">{children}</div>
    </article>
  );
}

type LegalSectionProps = {
  id: string;
  heading: string;
  children: ReactNode;
};

export function LegalSection({ id, heading, children }: LegalSectionProps) {
  return (
    <section id={id} aria-labelledby={`${id}-heading`} className="scroll-mt-24">
      <h2 id={`${id}-heading`} className="font-display text-xl font-semibold text-ink">{heading}</h2>
      <div className="mt-3 space-y-3 text-base leading-7 text-ink-muted">{children}</div>
    </section>
  );
}

/**
 * Renders a contact value, or an unmistakable notice when it has not been
 * filled in. A page that quietly omits a required detail reads as complete;
 * this one cannot.
 */
export function ContactValue({ label, value }: { label: string; value: PendingOr<string> }) {
  if (isPending(value)) {
    return (
      <span role="status" className="inline-flex rounded-control border border-sev-high px-2 py-0.5 font-mono text-2xs text-sev-high">
        {label} not yet published
      </span>
    );
  }
  return <span className="font-mono text-sm text-ink">{value}</span>;
}

/** A checklist of what a request must contain, so a reader can copy it. */
export function RequestChecklist({ items }: { items: string[] }) {
  return (
    <ol className="mt-3 space-y-2 text-base leading-7 text-ink-muted">
      {items.map((item, index) => (
        <li key={item} className="flex gap-3">
          <span aria-hidden="true" className="font-mono text-2xs text-ink-faint">{String(index + 1).padStart(2, '0')}</span>
          <span>{item}</span>
        </li>
      ))}
    </ol>
  );
}
