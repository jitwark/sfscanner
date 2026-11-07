import { SeverityPill } from '../report/report-blocks';

type Check = {
  name: string;
  fires: string;
  severities: string[];
  means: string;
  act: string;
};

/**
 * One row per policy in `beta-policies.ts`. Severities here are the ones the
 * policy can actually emit, not a guess: several policies grade themselves from
 * evidence strength, so the same check can appear as HIGH or as INFO.
 */
const CHECKS: Check[] = [
  {
    name: 'Shell command execution',
    fires: 'The workflow contains an Execute Command node.',
    severities: ['CRITICAL'],
    means:
      'This workflow can run shell commands on whatever machine runs n8n — not inside a sandbox. On n8n Cloud it is unavailable; self-hosted, it has the same reach as the n8n process itself.',
    act: 'Open the node and read the command before you import. If you did not write this workflow and cannot explain why it needs a shell, delete the node. There is almost always a dedicated node for the job.',
  },
  {
    name: 'Raw secret material',
    fires: 'A parameter value matches a known provider key format, or a parameter named like a secret holds a literal value.',
    severities: ['HIGH', 'MEDIUM', 'LOW'],
    means:
      'HIGH means the value looks like a real credential — a key shaped like the ones a provider issues. MEDIUM means a field named like a secret holds a pasted literal. LOW means only the field name suggests a secret.',
    act: 'Treat a HIGH finding as a leaked key: rotate it at the provider first, then move it into n8n Credentials so it lives outside the workflow file. Expressions and obvious placeholders are already ignored, so a finding here is not noise.',
  },
  {
    name: 'Authorization header',
    fires: 'A node sets an Authorization header directly.',
    severities: ['HIGH', 'INFO'],
    means:
      'HIGH means a token is pasted as a literal, so it travels with the file to anyone you share it with. INFO means the header is wired to an expression or credential, which is the recommended pattern and needs nothing from you.',
    act: 'For HIGH: rotate the token, then use a Header Auth credential instead. Exported workflows get pasted into forums and issue trackers, which is how header tokens leak.',
  },
  {
    name: 'Unauthenticated webhook',
    fires: 'A Webhook node has no authentication mode set.',
    severities: ['MEDIUM'],
    means:
      'Anyone who learns the URL may be able to trigger the workflow, depending on its validation and surrounding controls. Webhook URLs can leak through logs, browser history, and screenshots.',
    act: 'Set Header Auth or Basic Auth on the node, or put it behind a proxy. If it must stay open, make sure the workflow validates its input and cannot be replayed for profit.',
  },
  {
    name: 'Community node package',
    fires: 'A node type is outside the official n8n namespaces.',
    severities: ['LOW'],
    means:
      'The workflow may need a package installed from npm before it can run, and that code is maintained by a third party rather than n8n.',
    act: 'Check the package still exists and is maintained before you rely on it. This is the most common reason an imported workflow shows an unrecognised node.',
  },
  {
    name: 'Custom code node',
    fires: 'The workflow contains a Code or legacy Function node.',
    severities: ['LOW'],
    means:
      'Custom code is anatomy, not automatically a vulnerability. It is graded LOW deliberately. The hardened profile defines risky-code checks, but it is not admitted, so the shipped scan does not report them.',
    act: 'Read the code — it is short in most workflows. The shipped profile does not execute or parse it, so review it yourself until the hardened profile is admitted.',
  },
  {
    name: 'Unexpected outbound domain',
    fires: 'The workflow contacts a hostname you did not list as expected. Only runs when you supply a list.',
    severities: ['MEDIUM'],
    means:
      'A workflow that quietly posts to a host you were not expecting is the shape data exfiltration takes. With no list supplied, this check stays off, because everything would be unexpected.',
    act: 'Paste the hosts you expect into the expected-domains box, then rescan. Anything reported is a host you did not anticipate — confirm why it is there before importing.',
  },
];

export function ScannerChecks() {
  return (
    <section aria-labelledby="checks-heading" className="rounded-panel border border-hairline bg-panel p-4 sm:p-6">
      <h2 id="checks-heading" className="font-display text-lg font-semibold text-ink">
        What the scanner checks
      </h2>
      <p className="mt-1 max-w-2xl text-sm text-ink-muted">
        Seven structural checks are scored by default, all deterministic: the same workflow always
        produces the same report. The hardened profile defines advisory code, value-flow, and
        AI-agent checks, but it is not admitted and does not run in the shipped scanner. No model
        decides the security grade, and workflow content is not sent by the scanner worker.
      </p>

      <ul className="mt-5 flex flex-col gap-4">
        {CHECKS.map((check) => (
          <li key={check.name} className="border-t border-hairline pt-4 first:border-t-0 first:pt-0">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="font-display text-sm font-semibold text-ink">{check.name}</h3>
              {check.severities.map((severity) => (
                <SeverityPill key={severity} severity={severity} />
              ))}
            </div>
            <dl className="mt-2 grid gap-x-6 gap-y-2 sm:grid-cols-[7rem_1fr]">
              <dt className="font-mono text-2xs uppercase tracking-wide text-ink-faint">Fires when</dt>
              <dd className="text-sm text-ink-muted">{check.fires}</dd>
              <dt className="font-mono text-2xs uppercase tracking-wide text-ink-faint">Meaning</dt>
              <dd className="text-sm text-ink-muted">{check.means}</dd>
              <dt className="font-mono text-2xs uppercase tracking-wide text-ink-faint">What to do</dt>
              <dd className="text-sm text-ink">{check.act}</dd>
            </dl>
          </li>
        ))}
      </ul>
    </section>
  );
}
