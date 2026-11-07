import type { Grade, Severity } from '@hub/contracts';

/**
 * Severity is a **status** scale, not a categorical one: the steps are reserved,
 * ordered, and never reused to mean "series 4". The hex values behind these
 * tokens are validated for chroma, CVD separation, normal-vision separation and
 * 3:1 contrast in both themes — see `globals.css`. Do not substitute one by eye;
 * green -> amber -> orange -> red crowds badly and most candidates fail.
 *
 * Status colour always ships with its label, never alone.
 */
export const SEVERITY_ORDER: Severity[] = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO'];

export const SEVERITY_TOKEN: Record<Severity, string> = {
  CRITICAL: 'var(--color-sev-critical)',
  HIGH: 'var(--color-sev-high)',
  MEDIUM: 'var(--color-sev-medium)',
  LOW: 'var(--color-sev-low)',
  INFO: 'var(--color-sev-unknown)',
};

export const SEVERITY_LABEL: Record<Severity, string> = {
  CRITICAL: 'Critical',
  HIGH: 'High',
  MEDIUM: 'Medium',
  LOW: 'Low',
  INFO: 'Info',
};

/** Worst finding in a workflow. UNKNOWN means "not gradeable", not "safe". */
export const GRADE_ORDER: Grade[] = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL', 'UNKNOWN'];

export const GRADE_TOKEN: Record<Grade, string> = {
  LOW: 'var(--color-sev-low)',
  MEDIUM: 'var(--color-sev-medium)',
  HIGH: 'var(--color-sev-high)',
  CRITICAL: 'var(--color-sev-critical)',
  UNKNOWN: 'var(--color-sev-unknown)',
};

export const GRADE_LABEL: Record<Grade, string> = {
  LOW: 'Low',
  MEDIUM: 'Medium',
  HIGH: 'High',
  CRITICAL: 'Critical',
  UNKNOWN: 'Unknown',
};

export const COMPLEXITY_LABEL = { simple: 'Simple', medium: 'Medium', complex: 'Complex' } as const;
