import { readFile } from 'node:fs/promises';

// Keep owner-selected thresholds distinct from measured latency summaries.
export function preserveP95BudgetOverrides(report, previous) {
  if (report.environment.digest !== previous.environment.digest) return report;
  const previousCases = new Map(previous.cases.map((item) => [item.key, item]));
  return {
    ...report,
    cases: report.cases.map((item) => {
      const prior = previousCases.get(item.key);
      const override = prior?.budgetBaselineP95Ms;
      return prior?.inputSha256 === item.inputSha256 && Number.isFinite(override) && override > 0
        ? { ...item, budgetBaselineP95Ms: override }
        : item;
    }),
  };
}

export async function withPreservedP95BudgetOverrides(report, baselinePath, validateBaseline) {
  let previous;
  try { previous = JSON.parse(await readFile(baselinePath, 'utf8')); }
  catch (cause) { if (cause?.code !== 'ENOENT') throw cause; }
  if (previous === undefined) return report;
  const validation = validateBaseline(previous);
  if (!validation.ok) throw new Error(`existing baseline v2 is invalid: ${validation.errors.join('; ')}`);
  return preserveP95BudgetOverrides(report, previous);
}
