import type { Grade } from '@hub/contracts';

export type GradePillProps = {
  grade: Grade;
  className?: string;
};

export function GradePill({ grade, className = '' }: GradePillProps) {
  const styles: Record<Grade, { text: string; bg: string; border: string; label: string }> = {
    LOW: {
      text: 'text-sev-low',
      bg: 'bg-sev-low/10',
      border: 'border-sev-low',
      label: 'LOW',
    },
    MEDIUM: {
      text: 'text-sev-medium',
      bg: 'bg-sev-medium/10',
      border: 'border-sev-medium',
      label: 'MEDIUM',
    },
    HIGH: {
      text: 'text-sev-high',
      bg: 'bg-sev-high/10',
      border: 'border-sev-high',
      label: 'HIGH',
    },
    CRITICAL: {
      text: 'text-sev-critical',
      bg: 'bg-sev-critical/10',
      border: 'border-sev-critical',
      label: 'CRITICAL',
    },
    UNKNOWN: {
      text: 'text-ink-muted',
      bg: 'bg-raised/50',
      border: 'border-hairline',
      label: 'UNKNOWN',
    },
  };

  const style = styles[grade] || styles.UNKNOWN;

  return (
    <span
      className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-control text-xs font-mono font-bold border ${style.text} ${style.bg} ${style.border} ${className}`}
    >
      <GradeIcon grade={grade} />
      <span>{style.label}</span>
    </span>
  );
}

function GradeIcon({ grade }: { grade: Grade }) {
  if (grade === 'LOW') {
    return (
      <svg className="w-3 h-3 stroke-current" fill="none" viewBox="0 0 24 24" strokeWidth="2">
        <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
      </svg>
    );
  }
  if (grade === 'MEDIUM' || grade === 'HIGH') {
    return (
      <svg className="w-3 h-3 stroke-current" fill="none" viewBox="0 0 24 24" strokeWidth="2">
        <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
      </svg>
    );
  }
  if (grade === 'CRITICAL') {
    return (
      <svg className="w-3 h-3 stroke-current" fill="none" viewBox="0 0 24 24" strokeWidth="2">
        <path strokeLinecap="round" strokeLinejoin="round" d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
      </svg>
    );
  }
  return (
    <svg className="w-3 h-3 stroke-current" fill="none" viewBox="0 0 24 24" strokeWidth="2">
      <path strokeLinecap="round" strokeLinejoin="round" d="M8.228 9c.549-1.165 2.03-2 3.772-2 2.21 0 4 1.343 4 3 0 1.4-1.278 2.575-3.006 2.907-.542.104-.994.54-.994 1.093m0 3h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
    </svg>
  );
}
