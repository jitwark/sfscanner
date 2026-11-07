import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { CorpusAnalytics } from '@hub/contracts';
import { NodeCoveragePanel } from './node-coverage';

afterEach(() => cleanup());

const base = {
  observedNodeTypes: 10,
  observedNodeInstances: 100,
  modelledTypes: 6,
  partlyModelledTypes: 2,
  unmodelledTypes: 2,
  versions: [
    { nodeType: 'n8n-nodes-base.slack', version: '2.0.0', workflows: 25, instances: 30, semantics: 'MODELLED' },
  ],
  unknownTypes: [
    { nodeType: 'n8n-nodes-base.unknownBig', workflows: 900, instances: 1200, versions: ['1', '2'] },
    { nodeType: 'n8n-nodes-base.unknownSmall', workflows: 12, instances: 14, versions: [] },
  ],
} satisfies CorpusAnalytics['nodeCoverage'];

describe('NodeCoveragePanel', () => {
  it('labels node coverage as catalogue coverage and states both denominators', () => {
    render(<NodeCoveragePanel nodeCoverage={base} readableInputs={11066} refused={18} />);

    expect(screen.getByText('catalogue coverage, not security accuracy')).toBeTruthy();
    expect(screen.getByText(/Counted over the 11,066 bound readable inputs, including the 18 engine refusals/)).toBeTruthy();
    expect(screen.getByText('Of observed types')).toBeTruthy();
  });

  it('lists unmodelled types with their observed versions', () => {
    render(<NodeCoveragePanel nodeCoverage={base} readableInputs={25} refused={1} />);

    const big = screen.getByText('n8n-nodes-base.unknownBig').closest('tr')!;
    expect(big.textContent).toContain('900');
    expect(big.textContent).toContain('1, 2');

    const unversioned = screen.getByText('n8n-nodes-base.unknownSmall').closest('tr')!;
    expect(unversioned.textContent).toContain('unversioned');
  });

  it('does not claim completeness when only partly-modelled types remain', () => {
    render(
      <NodeCoveragePanel
        nodeCoverage={{ ...base, unknownTypes: [], unmodelledTypes: 0, modelledTypes: 8, partlyModelledTypes: 2 }}
        readableInputs={25}
        refused={1}
      />,
    );

    expect(screen.queryByText('Every observed node type is modelled.')).toBeNull();
    expect(screen.getByText(/No fully unmodelled types; 2 observed types are partly modelled/)).toBeTruthy();
  });

  it('claims completeness only when every observed type is modelled', () => {
    render(
      <NodeCoveragePanel
        nodeCoverage={{ ...base, unknownTypes: [], unmodelledTypes: 0, partlyModelledTypes: 0, modelledTypes: 10 }}
        readableInputs={25}
        refused={1}
      />,
    );

    expect(screen.getByText('Every observed node type is modelled.')).toBeTruthy();
  });

  it('states the top-N cut for modelled versions instead of silently truncating', () => {
    const versions = Array.from({ length: 14 }, (_, index) => ({
      nodeType: `n8n-nodes-base.thing${index}`,
      version: '1.0.0',
      workflows: 100 - index,
      instances: 100 - index,
      semantics: 'MODELLED' as const,
    }));
    render(<NodeCoveragePanel nodeCoverage={{ ...base, versions }} readableInputs={25} refused={1} />);

    expect(screen.getByText(/The 12 most widely used of 14 modelled \(type, version\) pairs/)).toBeTruthy();
  });
});
