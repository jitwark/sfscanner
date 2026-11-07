import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { HostList } from './host-list';

describe('HostList', () => {
  // Two tests render the same hostname, so the document needs clearing between
  // them; `globals` is off, so RTL's own auto-cleanup never registers.
  afterEach(() => cleanup());

  it('labels literal, dynamic, and undeterminable hosts', () => {
    render(<HostList hostnames={{ literal: ['api.example.test'], dynamic: [{ host: 'api.dynamic.test' }, { host: 'api.dynamic.test' }], undeterminable: 2 }} />);
    expect(screen.getByText('api.example.test')).toBeTruthy();
    expect(screen.getAllByText('api.dynamic.test')).toHaveLength(2);
    expect(screen.getByText(/could not be determined/)).toBeTruthy();
    // A scanned row's hosts were extracted by the current engine.
    expect(screen.queryByText(/Historical derivation/)).toBeNull();
  });

  it('labels unscanned hostnames as a historical derivation without hiding them', () => {
    const { container } = render(<HostList isUnscanned hostnames={{ literal: ['api.example.test'], dynamic: [], undeterminable: 0 }} />);
    expect(container.textContent).toMatch(/Historical derivation/);
    // Labelled, not suppressed: the historical hosts are still published.
    expect(screen.getByText('api.example.test')).toBeTruthy();
  });

  it('omits an empty host card', () => {
    render(<HostList hostnames={{ literal: [], dynamic: [], undeterminable: 0 }} />);
    expect(screen.queryByRole('section')).toBeNull();
  });
});
