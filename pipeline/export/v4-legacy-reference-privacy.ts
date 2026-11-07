import crypto from 'node:crypto';
import type { PublicDataProjection } from '@hub/contracts/public-data-model';

const id = (domain: string, key: string) => domain + '-' + crypto.createHash('sha256').update(key).digest('hex');

/** Legacy display references retain their counts, never a free-form package/credential token or its hash. */
export function withholdLegacyReferenceTokens(projection: PublicDataProjection): Pick<PublicDataProjection, 'requirements' | 'credentials' | 'communityNodes'> {
  const ordinals = new Map<string, number>();
  const requirements = projection.requirements.map((row) => {
    if (row.kind !== 'credential' && row.kind !== 'community-node') return row;
    const key = `${row.workflowId}\0${row.kind}`;
    const ordinal = ordinals.get(key) ?? 0; ordinals.set(key, ordinal + 1);
    return { ...row, requirementId: id('requirement-' + row.kind, `${key}\0${ordinal}`),
      label: row.kind === 'credential' ? 'Credential reference' : 'Community package reference' };
  }).sort((a, b) => a.requirementId < b.requirementId ? -1 : a.requirementId > b.requirementId ? 1 : 0);
  const credentials = projection.credentials.map((_row, ordinal) => ({
    id: id('credential', String(ordinal)), label: `Credential reference ${ordinal + 1}`,
  })).sort((a, b) => a.label < b.label ? -1 : a.label > b.label ? 1 : 0);
  const communityNodes = projection.communityNodes.map((_row, ordinal) => ({
    id: id('community-node', String(ordinal)), packageName: `Community package reference ${ordinal + 1}`,
  })).sort((a, b) => a.packageName < b.packageName ? -1 : a.packageName > b.packageName ? 1 : 0);
  return { requirements, credentials, communityNodes };
}
