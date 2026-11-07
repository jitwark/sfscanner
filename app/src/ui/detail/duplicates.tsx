import type { Entry } from '@hub/contracts';
import { safeHttpUrl } from '../../seo/hostile-text';

type DuplicatesProps = { entry: Entry };

export function Duplicates({ entry }: DuplicatesProps) {
  const links = entry.dedup.alsoFoundIn
    .map((link) => safeHttpUrl(link, ''))
    .filter((link) => link !== '');
  if (links.length === 0) return null;
  return (
    <section aria-labelledby="duplicates-heading" className="space-y-3">
      <h2 id="duplicates-heading" className="font-display text-xl font-semibold text-ink">The same workflow also appears in</h2>
      <ul className="space-y-2 text-sm">
        {links.map((link) => <li key={link}><a href={link} className="break-all text-accent-text hover:underline">{link}</a></li>)}
      </ul>
    </section>
  );
}
