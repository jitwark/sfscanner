import type { ReactNode } from 'react';

export type ChipProps = {
  children: ReactNode;
  active?: boolean;
  onClick?: () => void;
  href?: string;
  className?: string;
};

export function Chip({
  children,
  active = false,
  onClick,
  href,
  className = '',
}: ChipProps) {
  const baseClasses =
    'inline-flex items-center gap-1.5 px-3 py-1 rounded-control text-xs font-mono border transition-colors duration-120 focus-visible:outline-2 focus-visible:outline-accent-border';

  const activeClasses = active
    ? 'bg-ink text-page border-ink font-bold'
    : 'bg-raised/60 text-ink border-hairline hover:border-hairline-strong hover:bg-raised';

  const combined = `${baseClasses} ${activeClasses} ${className}`;

  if (href) {
    return (
      <a href={href} className={combined}>
        {children}
      </a>
    );
  }

  if (onClick) {
    return (
      <button type="button" onClick={onClick} className={combined}>
        {children}
      </button>
    );
  }

  return <span className={combined}>{children}</span>;
}
