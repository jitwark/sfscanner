'use client';

import { useEffect, useState, useSyncExternalStore } from 'react';
import { THEME_TOGGLE_ATTRIBUTE } from './theme-script';

const themeStorageKey = 'n8n-secureflow-theme';
type Theme = 'dark' | 'light';

function getDocumentTheme(): Theme {
  return document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
}

function subscribeToThemeChange(onStoreChange: () => void) {
  window.addEventListener('secureflowthemechange', onStoreChange);
  return () => window.removeEventListener('secureflowthemechange', onStoreChange);
}

export function ThemeToggle() {
  const theme = useSyncExternalStore(subscribeToThemeChange, getDocumentTheme, () => 'dark');
  const [saveError, setSaveError] = useState(false);

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(themeStorageKey);
      if ((stored === 'light' || stored === 'dark') && stored !== document.documentElement.dataset.theme) {
        document.documentElement.dataset.theme = stored;
        window.dispatchEvent(new Event('secureflowthemechange'));
      }
    } catch {}
  }, []);

  const toggleTheme = () => {
    const nextTheme: Theme = theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = nextTheme;
    try {
      window.localStorage.setItem(themeStorageKey, nextTheme);
      setSaveError(false);
    } catch {
      setSaveError(true);
    }
    window.dispatchEvent(new Event('secureflowthemechange'));
  };

  const isDark = theme === 'dark';
  return <>
    <button
      type="button"
      {...{ [THEME_TOGGLE_ATTRIBUTE]: '' }}
      aria-pressed={isDark}
      aria-label={isDark ? 'Switch to light theme' : 'Switch to dark theme'}
      aria-describedby={saveError ? 'theme-save-status' : undefined}
      onClick={toggleTheme}
      className={`min-h-11 min-w-11 rounded-control border border-hairline px-3 text-sm transition-colors active:scale-[0.98] hover:border-structure focus-visible:outline-offset-2 ${isDark ? 'bg-accent text-accent-ink' : 'bg-raised text-ink'}`}
    >
      <span aria-hidden="true">{isDark ? 'Light' : 'Dark'}</span>
    </button>
    {saveError && <span id="theme-save-status" role="status" className="ml-2 text-xs text-sev-high">Theme preference could not be saved.</span>}
  </>;
}
