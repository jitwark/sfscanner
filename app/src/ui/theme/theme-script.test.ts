import { beforeEach, describe, expect, it } from 'vitest';
import { getThemeBootstrapScript, getThemeToggleScript, THEME_TOGGLE_ATTRIBUTE } from './theme-script';

describe('getThemeBootstrapScript', () => {
  it('restores the persisted theme before paint and otherwise follows system preference', () => {
    const script = getThemeBootstrapScript();

    expect(script).toContain('n8n-secureflow-theme');
    expect(script).toContain('document.documentElement.dataset.theme');
    expect(script).toContain('prefers-color-scheme: dark');
  });
});

describe('getThemeToggleScript', () => {
  function mountToggle(theme: 'dark' | 'light') {
    document.documentElement.dataset.theme = theme;
    document.body.innerHTML = `<button type="button" ${THEME_TOGGLE_ATTRIBUTE}
      aria-pressed="${theme === 'dark'}"
      aria-label="Switch to ${theme === 'dark' ? 'light' : 'dark'} theme"
      class="min-h-11 ${theme === 'dark' ? 'bg-accent text-accent-ink' : 'bg-raised text-ink'}"
      ><span aria-hidden="true">${theme === 'dark' ? 'Light' : 'Dark'}</span></button>`;
    new Function(getThemeToggleScript())();
    return document.querySelector('button')!;
  }

  beforeEach(() => {
    window.localStorage.clear();
  });

  it('switches the theme on a page that never hydrates', () => {
    // The statically rendered detail pages carry the site header, which carries
    // this control. Without a handler it is a button that visibly does nothing
    // on 12,971 pages.
    const button = mountToggle('dark');

    button.click();

    expect(document.documentElement.dataset.theme).toBe('light');
    expect(window.localStorage.getItem('n8n-secureflow-theme')).toBe('light');
  });

  it('switches back', () => {
    const button = mountToggle('dark');

    button.click();
    button.click();

    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(window.localStorage.getItem('n8n-secureflow-theme')).toBe('dark');
  });

  it('keeps the control describing what it will do next', () => {
    const button = mountToggle('dark');

    button.click();

    expect(button.getAttribute('aria-pressed')).toBe('false');
    expect(button.getAttribute('aria-label')).toBe('Switch to dark theme');
    expect(button.textContent).toBe('Dark');
    expect(button.className).toContain('bg-raised');
    expect(button.className).not.toContain('bg-accent');
  });

  it('still switches the theme when localStorage refuses the write', () => {
    const button = mountToggle('dark');
    const setItem = window.localStorage.setItem;
    window.localStorage.setItem = () => { throw new Error('quota'); };

    try {
      expect(() => button.click()).not.toThrow();
      expect(document.documentElement.dataset.theme).toBe('light');
    } finally {
      window.localStorage.setItem = setItem;
    }
  });

  it('emits the event the hydrated toggle listens for, so both agree', () => {
    const button = mountToggle('dark');
    let heard = 0;
    window.addEventListener('secureflowthemechange', () => { heard += 1; });

    button.click();

    expect(heard).toBe(1);
  });
});
