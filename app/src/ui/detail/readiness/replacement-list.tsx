import type { EntryReadiness } from '@hub/contracts';
import { HistoricalDerivationNote, ReadinessList, ReadinessSection } from './readiness-section';
import { ReplaceableValues } from './replaceable-values';

type ReplacementListProps = {
  values: EntryReadiness['replaceableValues'];
  isUnscanned?: boolean;
};

export function ReplacementList({ values, isUnscanned = false }: ReplacementListProps) {
  if (values.length === 0) return null;
  return <ReplaceableValues values={values} isUnscanned={isUnscanned} />;
}

export function CredentialList({ credentials, isUnscanned = false }: { credentials: string[]; isUnscanned?: boolean }) {
  if (credentials.length === 0) return null;
  return (
    <ReadinessSection title="Required credentials" count={credentials.length} icon="▣">
      {isUnscanned && <HistoricalDerivationNote about="the credential names in this card" />}
      <p className="text-xs text-ink-muted">Credential names only are shown. No credential values are stored here.</p>
      <ReadinessList>
        {credentials.map((credential, index) => <li key={`${credential}-${index}`}>{credential}</li>)}
      </ReadinessList>
    </ReadinessSection>
  );
}

export function WriteActionList({ actions, isUnscanned = false }: { actions: string[]; isUnscanned?: boolean }) {
  if (actions.length === 0) return null;
  return (
    <ReadinessSection title="Write / mutating actions" count={actions.length} icon="✎">
      {isUnscanned && <HistoricalDerivationNote about="the actions in this list" />}
      <ReadinessList>{actions.map((action, index) => <li key={`${action}-${index}`}>{action}</li>)}</ReadinessList>
    </ReadinessSection>
  );
}
