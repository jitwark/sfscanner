import Link from 'next/link';

type FooterLink = {
  href: '/library/' | '/scanner/' | '/analytics/' | '/about/' | '/sources/' | '/privacy/' | '/terms/' | '/takedown/';
  label: string;
};

const EXPLORE: FooterLink[] = [
  { href: '/library/', label: 'Library' },
  { href: '/scanner/', label: 'Scanner' },
  { href: '/analytics/', label: 'Analytics' },
];

const PROJECT: FooterLink[] = [
  { href: '/about/', label: 'About' },
  { href: '/sources/', label: 'Sources' },
  { href: '/privacy/', label: 'Privacy' },
  { href: '/terms/', label: 'Terms' },
];

function Column({ title, links }: { title: string; links: FooterLink[] }) {
  return (
    <div>
      <h2 className="font-sans text-xs font-bold uppercase tracking-wider text-ink">
        {title}
      </h2>
      <ul className="mt-3 space-y-2">
        {links.map((link) => (
          <li key={link.href}>
            <Link
              href={link.href}
              prefetch={false}
              className="flex min-h-8 items-center text-sm text-ink-muted transition-colors hover:text-ink hover:underline focus-visible:outline-2 focus-visible:outline-accent-border"
            >
              {link.label}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function SiteFooter() {
  return (
    <footer className="mt-20 border-t border-hairline bg-panel text-ink">
      <div className="mx-auto grid w-full max-w-7xl grid-cols-1 min-w-0 gap-8 px-4 py-16 sm:grid-cols-2 sm:px-6 lg:grid-cols-4">
        <div className="lg:col-span-2">
          <div className="flex items-center gap-2">
            <span className="h-3 w-3 bg-accent" aria-hidden="true" />
            <p className="font-sans text-lg font-bold tracking-tight text-ink">
              n8n<span className="text-accent-text">-</span>secureflow
            </p>
          </div>
          <p className="mt-3 max-w-md text-sm leading-6 text-ink-muted">
            An engineering-grade, privacy-first community workflow catalogue and local scanner.
            All static. Zero tracking. Zero uploads.
          </p>
          <p className="mt-4 font-mono text-2xs uppercase tracking-wider text-ink-faint">
            Independent community project · Not affiliated with n8n.io
          </p>
        </div>

        <Column title="Explore" links={EXPLORE} />
        <Column title="Project" links={PROJECT} />
      </div>

      <div className="border-t border-hairline bg-raised py-4">
        <div className="mx-auto flex w-full max-w-7xl flex-wrap items-center justify-between gap-4 px-4 sm:px-6">
          <p className="font-mono text-2xs uppercase tracking-wider text-ink-muted">
            Zero telemetry · Client-side analysis · Open source
          </p>
          <p className="font-mono text-2xs uppercase tracking-wider text-ink-faint">
            © 2026 n8n-secureflow community
          </p>
        </div>
      </div>
    </footer>
  );
}
