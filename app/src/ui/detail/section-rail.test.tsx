import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { SectionRail } from './section-rail';

describe('SectionRail', () => {
  it('renders stable section anchors in a contained responsive rail', () => {
    render(<SectionRail sections={[
      { id: 'security', label: 'Security', count: 3 },
      { id: 'before-you-run', label: 'Before you run' },
      { id: 'workflow-canvas', label: 'Canvas' },
    ]} />);

    const navigation = screen.getByRole('navigation', { name: 'Workflow sections' });
    expect(navigation.className).toContain('min-w-0');
    expect(navigation.className).toContain('[contain:paint]');
    expect(navigation.className).toContain('lg:top-24');
    expect(navigation.className).not.toContain('lg:top-6');
    expect(navigation.querySelector('[data-rail-scroll]')?.className).toContain('overflow-x-auto');
    expect(navigation.querySelector('ol')?.className).toContain('lg:flex-col');
    expect(screen.getByRole('link', { name: /Security/ }).getAttribute('href')).toBe('#security');
    expect(screen.getByRole('link', { name: 'Security, 3 reported' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Before you run' }).getAttribute('href')).toBe('#before-you-run');
    expect(screen.getByRole('link', { name: 'Canvas' }).getAttribute('href')).toBe('#workflow-canvas');
  });

  it('lets long section labels shrink and wrap inside the desktop rail', () => {
    render(<SectionRail sections={[{
      id: 'before-you-run',
      label: 'Compatibility and environment configuration before you run',
    }]} />);

    const label = screen.getByRole('link', { name: 'Compatibility and environment configuration before you run' })
      .querySelector('span');
    expect(label?.className).toContain('min-w-0');
    expect(label?.className).toContain('break-words');
  });
});
