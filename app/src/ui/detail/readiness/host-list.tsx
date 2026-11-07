import type { HostnameExtraction } from '@hub/contracts';
import { HistoricalDerivationNote, ReadinessList, ReadinessSection } from './readiness-section';

export function HostList({ hostnames, isUnscanned = false }: { hostnames?: HostnameExtraction; isUnscanned?: boolean }) {
  if (!hostnames) return null;
  const hasHosts = hostnames.literal.length > 0 || hostnames.dynamic.length > 0 || hostnames.undeterminable > 0;
  if (!hasHosts) return null;
  const hostCount = hostnames.literal.length + hostnames.dynamic.length + hostnames.undeterminable;
  return (
    <ReadinessSection title="External hosts contacted" count={hostCount} icon="◎">
      {isUnscanned && <HistoricalDerivationNote about="the hosts in this list" />}
      <ReadinessList>
        {hostnames.literal.map((host, index) => <li key={`literal-${host}-${index}`}><span className="font-mono text-ink">{host}</span> <span>(literal)</span></li>)}
        {hostnames.dynamic.map((item, index) => <li key={`dynamic-${item.host}-${index}`}><span className="font-mono text-ink">{item.host}</span> <span>(dynamic)</span></li>)}
        {hostnames.undeterminable > 0 && <li><span className="font-semibold text-ink">{hostnames.undeterminable}</span> host URL{hostnames.undeterminable === 1 ? '' : 's'} could not be determined from the workflow.</li>}
      </ReadinessList>
    </ReadinessSection>
  );
}
