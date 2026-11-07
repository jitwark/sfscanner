import { GradePill, SeverityPill } from '../report/report-blocks';

const GRADES: Array<{ grade: string; band: string; means: string; act: string }> = [
  {
    grade: 'LOW',
    band: 'under 25',
    means: 'No high or critical risk was found under the current scoring rules. Review any low or informational findings before import.',
    act: 'Import it. Still connect your own credentials rather than reusing anything in the file.',
  },
  {
    grade: 'MEDIUM',
    band: '25 to 54',
    means: 'Something is worth a look — commonly an open webhook, a community node, or a field named like a secret.',
    act: 'Read the findings list. Usually one setting to change, not a reason to reject the workflow.',
  },
  {
    grade: 'HIGH',
    band: '55 to 79',
    means: 'A credential is probably sitting in the file, or a token is pasted into a header.',
    act: 'Rotate the exposed credential at the provider before anything else, then move it into n8n Credentials.',
  },
  {
    grade: 'CRITICAL',
    band: '80 or above',
    means: 'The total score is 80 or higher. A critical finding can contribute substantially, but the overall grade also includes other findings and workflow complexity.',
    act: 'Do not import until you have read the flagged nodes and can explain each one.',
  },
];

const SEVERITIES: Array<{ severity: string; weight: string; means: string }> = [
  { severity: 'CRITICAL', weight: '55', means: 'Can reach outside the workflow, into the host that runs n8n.' },
  { severity: 'HIGH', weight: '35', means: 'A credential is exposed in the file, or looks like one.' },
  { severity: 'MEDIUM', weight: '18', means: 'A door left open — reachable, but nothing is leaking yet.' },
  { severity: 'LOW', weight: '6', means: 'Worth knowing before you import. Not a defect.' },
  { severity: 'INFO', weight: '1', means: 'The workflow is doing the right thing. Recorded so you can see it was checked.' },
];

export function ScannerGrades() {
  return (
    <section aria-labelledby="grades-heading" className="rounded-panel border border-hairline bg-panel p-4 sm:p-6">
      <h2 id="grades-heading" className="font-display text-lg font-semibold text-ink">
        How to read your report
      </h2>
      <p className="mt-1 max-w-2xl text-sm text-ink-muted">
        The grade is a triage signal, not a verdict. Read it as how much attention this file needs
        before you trust it.
      </p>

      <div className="mt-5 overflow-x-auto">
        <table className="w-full min-w-[34rem] border-collapse text-left">
          <caption className="sr-only">Risk grades, their score bands, and what to do</caption>
          <thead>
            <tr className="border-b border-hairline">
              <th scope="col" className="pb-2 pr-4 font-mono text-2xs uppercase tracking-wide text-ink-faint">Grade</th>
              <th scope="col" className="pb-2 pr-4 font-mono text-2xs uppercase tracking-wide text-ink-faint">Score</th>
              <th scope="col" className="pb-2 pr-4 font-mono text-2xs uppercase tracking-wide text-ink-faint">What it means</th>
              <th scope="col" className="pb-2 font-mono text-2xs uppercase tracking-wide text-ink-faint">What to do</th>
            </tr>
          </thead>
          <tbody>
            {GRADES.map((row) => (
              <tr key={row.grade} className="border-b border-hairline last:border-b-0">
                <td className="py-3 pr-4 align-top"><GradePill grade={row.grade} /></td>
                <td className="py-3 pr-4 align-top font-mono text-xs text-ink-muted">{row.band}</td>
                <td className="py-3 pr-4 align-top text-sm text-ink-muted">{row.means}</td>
                <td className="py-3 align-top text-sm text-ink">{row.act}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h3 className="mt-8 font-display text-sm font-semibold text-ink">What each severity means</h3>
      <ul className="mt-3 flex flex-col gap-2">
        {SEVERITIES.map((row) => (
          <li key={row.severity} className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <SeverityPill severity={row.severity} />
            <span className="font-mono text-2xs text-ink-faint">{row.weight} pts</span>
            <span className="text-sm text-ink-muted">{row.means}</span>
          </li>
        ))}
      </ul>

      <h3 className="mt-8 font-display text-sm font-semibold text-ink">How the score is built</h3>
      <div className="mt-2 max-w-2xl space-y-3 text-sm text-ink-muted">
        <p>
          Each distinct check that fires contributes its severity weight. Repeat hits of the{' '}
          <em>same</em> check add only a quarter each and stop at twice the first hit, because ten
          Code nodes are one thing observed ten times, not ten problems. Workflow size adds up to 20
          points. The total is capped at 100.
        </p>
        <p>
          Repeat hits are deliberately discounted so one repeated pattern cannot drown out the rest
          of the report. Deep-scan code and value-flow findings add review context; they do not become
          an authoritative execution or safety verdict.
        </p>
        <p className="border-l-2 border-hairline-strong pl-3 text-ink-faint">
          Known limitation: workflow size is currently measured from raw node count, which includes
          sticky notes and placeholders. This can overstate the size contribution for some workflows;
          the correction remains tracked in the project plan.
        </p>
      </div>
    </section>
  );
}
