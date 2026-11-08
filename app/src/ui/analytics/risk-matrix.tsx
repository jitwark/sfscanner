import type { Complexity, Grade, GradeComplexityCell } from '@hub/contracts';
import { COMPLEXITY_LABEL, GRADE_LABEL } from './severity';

export type RiskMatrixProps = {
  cells: GradeComplexityCell[];
  max: number;
};

const GRADES: Grade[] = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];
const COMPLEXITIES: Complexity[] = ['simple', 'medium', 'complex'];

/**
 * Sequential encoding: one hue, stepped by alpha. Only lightness varies, so it
 * survives every form of colour vision deficiency by construction — no rainbow,
 * no second hue, no hue at a midpoint.
 *
 * 0.6 is a computed ceiling, not a taste call. Dark theme is the binding case:
 * `--color-ink` (#ffffff) over the accent (#76b900) composited on the panel
 * (#1a1a1a) measures 5.36:1 at alpha 0.6 and **4.30:1 at 0.7**. Contrast only
 * improves as alpha falls, so every step clears the 4.5:1 floor. Raising this
 * number silently drops the darkest cells below it.
 *
 * It was 0.5 under violet and 0.4 under amber. Changing to the green accent palette
 * re-derived the ceiling to 0.6, which `risk-matrix.test.tsx` validates.
 */
export const MAX_CELL_ALPHA = 0.6;

const GRADE_INDICATOR: Partial<Record<Grade, string>> = {
  CRITICAL: 'var(--color-sev-critical)',
  HIGH: 'var(--color-sev-high)',
  MEDIUM: 'var(--color-sev-medium)',
  LOW: 'var(--color-sev-low)',
};

export function RiskMatrix({ cells, max }: RiskMatrixProps) {
  const at = (grade: Grade, complexity: Complexity) =>
    cells.find((cell) => cell.grade === grade && cell.complexity === complexity)?.count ?? 0;
  const denominator = Math.max(1, max);

  return (
    <section className="min-w-0 rounded-panel border border-hairline bg-panel p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h3 className="font-display text-base font-semibold text-ink">Grade × complexity</h3>
        <p className="font-mono text-2xs text-ink-faint">Unknown excluded</p>
      </div>

      <div className="mt-3 overflow-x-auto min-w-0">
        <table className="w-full min-w-0 border-collapse sm:min-w-[22rem]">
          <caption className="sr-only">Workflow count by security grade and complexity band</caption>
          <thead>
            <tr>
              <td className="p-0" />
              {COMPLEXITIES.map((complexity) => (
                <th
                  key={complexity}
                  scope="col"
                  className="px-2 pb-2 text-center font-mono text-2xs font-normal uppercase tracking-[0.14em] text-ink-faint"
                >
                  {COMPLEXITY_LABEL[complexity]}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {GRADES.map((grade) => (
              <tr key={grade}>
                <th
                  scope="row"
                  className="whitespace-nowrap py-1 pr-3 text-right font-mono text-2xs font-normal uppercase tracking-[0.14em] text-ink-faint"
                >
                  <span className="inline-flex items-center gap-1.5 justify-end">
                    <span
                      className="h-1.5 w-1.5 rounded-full"
                      style={{ background: GRADE_INDICATOR[grade] ?? 'transparent' }}
                      aria-hidden="true"
                    />
                    {GRADE_LABEL[grade]}
                  </span>
                </th>
                {COMPLEXITIES.map((complexity) => {
                  const count = at(grade, complexity);
                  const alpha = (count / denominator) * MAX_CELL_ALPHA;
                  const isHighRisk = (grade === 'CRITICAL' || grade === 'HIGH') && count > 0;

                  return (
                    <td key={complexity} className="p-0.5">
                      <div
                        className={`relative flex h-14 items-center justify-center rounded-[4px] border font-mono text-sm tabular-nums text-ink ${
                          isHighRisk ? 'border-hairline/80 font-semibold' : 'border-hairline'
                        }`}
                        style={{ background: `color-mix(in srgb, var(--color-accent) ${(alpha * 100).toFixed(1)}%, var(--color-panel))` }}
                      >
                        {count.toLocaleString('en-US')}
                        {isHighRisk && (
                          <span
                            className="absolute top-1 right-1 h-1.5 w-1.5 rounded-full"
                            style={{ background: GRADE_INDICATOR[grade] }}
                            aria-hidden="true"
                          />
                        )}
                      </div>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
