import type { Grade } from '@hub/contracts';

const LABEL: Record<Grade, string> = {
  LOW: 'Low risk',
  MEDIUM: 'Medium risk',
  HIGH: 'High risk',
  CRITICAL: 'Critical risk',
  UNKNOWN: 'Not graded',
};

/**
 * A glyph beside the word, because severity must never be carried by colour
 * alone — for colour-vision deficiency, for forced-colors mode, and for print.
 */
const GLYPH: Record<Grade, string> = {
  LOW: '·',
  MEDIUM: '!',
  HIGH: '▲',
  CRITICAL: '×',
  UNKNOWN: '?',
};

const TOKEN: Record<Grade, string> = {
  LOW: 'var(--color-sev-low)',
  MEDIUM: 'var(--color-sev-medium)',
  HIGH: 'var(--color-sev-high)',
  CRITICAL: 'var(--color-sev-critical)',
  UNKNOWN: 'var(--color-sev-unknown)',
};

export function toGrade(value: string | undefined): Grade {
  const upper = (value ?? '').toUpperCase();
  return upper in LABEL ? (upper as Grade) : 'UNKNOWN';
}

/**
 * The scanner grade, in both themes.
 *
 * This replaced hard-coded palette classes (`bg-emerald-950/40`,
 * `border-amber-800/40`, …) that were picked for the dark theme and rendered as
 * near-black plates against the light one. The tokens behind these values are
 * validated for chroma, CVD separation and contrast in *both* themes — see
 * `globals.css`. `color-mix` derives the plate from the same token, so a badge
 * can never drift from the ramp it belongs to.
 */
export function GradeBadge({ grade, compact = false }: { grade: Grade; compact?: boolean }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border font-mono tabular-nums ${
        compact ? 'px-1.5 py-0.5 text-[11px]' : 'px-2 py-0.5 text-2xs'
      }`}
      style={{
        color: TOKEN[grade],
        borderColor: TOKEN[grade],
        background: `color-mix(in srgb, ${TOKEN[grade]} 10%, transparent)`,
      }}
    >
      <span aria-hidden="true">{GLYPH[grade]}</span>
      {LABEL[grade]}
    </span>
  );
}
