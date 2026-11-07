const themeStorageKey = 'n8n-secureflow-theme';

/** The hook both the React control and the no-framework handler agree on. */
export const THEME_TOGGLE_ATTRIBUTE = 'data-theme-toggle';

export function getThemeBootstrapScript(): string {
  return `(function(){try{var key='${themeStorageKey}';var stored=localStorage.getItem(key);var theme=stored==='light'||stored==='dark'?stored:(window.matchMedia('(prefers-color-scheme: dark)').matches?'dark':'dark');document.documentElement.dataset.theme=theme;}catch(_){document.documentElement.dataset.theme='dark';}})();`;
}

/**
 * The theme toggle, for pages that never hydrate.
 *
 * The statically rendered detail pages carry the site header, and the header
 * carries this control — so without a handler it is a visibly dead button on
 * 12,971 pages. `ThemeToggle` is a client component and cannot run there.
 *
 * It reproduces what `theme-toggle.tsx` does, including the event it dispatches,
 * so a page with both loaded behaves the same either way. Delegated from the
 * document, so it does not care when the button appears; the class swap mirrors
 * the two variants the React component renders.
 */
export function getThemeToggleScript(): string {
  // Installed once, however many times the script arrives: two delegated
  // listeners would flip the theme twice per click and read as a dead control.
  return `(function(){if(document.documentElement.dataset.themeToggleBound)return;`
    + `document.documentElement.dataset.themeToggleBound='1';`
    + `document.addEventListener('click',function(e){`
    + `var b=e.target&&e.target.closest&&e.target.closest('[${THEME_TOGGLE_ATTRIBUTE}]');if(!b)return;`
    + `var next=document.documentElement.dataset.theme==='dark'?'light':'dark';`
    + `document.documentElement.dataset.theme=next;`
    + `try{localStorage.setItem('${themeStorageKey}',next);}catch(_){}`
    + `var dark=next==='dark';`
    + `b.setAttribute('aria-pressed',String(dark));`
    + `b.setAttribute('aria-label','Switch to '+(dark?'light':'dark')+' theme');`
    + `b.textContent=dark?'Light':'Dark';`
    + `b.className=b.className.replace(dark?'bg-raised text-ink':'bg-accent text-accent-ink',dark?'bg-accent text-accent-ink':'bg-raised text-ink');`
    + `window.dispatchEvent(new Event('secureflowthemechange'));});})();`;
}
