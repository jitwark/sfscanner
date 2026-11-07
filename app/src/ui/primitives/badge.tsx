export type LicenceBadgeProps = {
  licence: string | null | undefined;
  className?: string;
};

export function LicenceBadge({ licence, className = '' }: LicenceBadgeProps) {
  const label = licence || 'Unlicensed';

  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded-badge text-2xs font-mono uppercase tracking-wider bg-raised text-ink border border-hairline ${className}`}
    >
      {label}
    </span>
  );
}
