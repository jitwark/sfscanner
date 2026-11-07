import type { N8nCompatibility } from '@hub/contracts';

export type CompatibilityTarget = Pick<N8nCompatibility, 'targetVersion' | 'checkedAt' | 'source'>;
