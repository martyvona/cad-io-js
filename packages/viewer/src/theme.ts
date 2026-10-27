// The viewer's theme (the user, 2026-10-27): View's Theme, Auto (the default: the system's, as it changes), Light or
// Dark. The page's colours are CSS variables (index.html) chosen by the root's data-theme, set before the first paint
// by index.html's inline script from what this browser remembers (the same rule as resolveTheme); the 3D view's
// background is the Viewer's.

export type Theme = 'dark' | 'light';
export type ThemeChoice = 'auto' | Theme;

const KEY = 'cad-viewer.theme';
const SYSTEM_LIGHT = '(prefers-color-scheme: light)';

/** The 3D view's background (index.html's --view-bg, which shows before the first frame). */
export const VIEW_BACKGROUNDS: Readonly<Record<Theme, number>> = { dark: 0x404040, light: 0xd9d9d9 };
/** The browser's toolbar colour (the panels'). */
const BARS: Readonly<Record<Theme, string>> = { dark: '#1f1f1f', light: '#f4f4f4' };

/** The theme for a choice: auto is the system's, dark unless the system prefers light. */
export function resolveTheme(choice: ThemeChoice, systemLight: boolean): Theme {
  return choice === 'auto' ? (systemLight ? 'light' : 'dark') : choice;
}

/** What this browser remembers (auto if nothing, or no storage). */
export function themeChoice(): ThemeChoice {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'light' || v === 'dark' ? v : 'auto';
  } catch {
    return 'auto';
  }
}

/** Sets the page's theme for a choice, remembers the choice (auto: forgets it), and says which theme that is. */
export function applyTheme(choice: ThemeChoice): Theme {
  const theme = resolveTheme(choice, matchMedia(SYSTEM_LIGHT).matches);
  const root = document.documentElement;
  if (theme === 'light') root.dataset.theme = 'light';
  else delete root.dataset.theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', BARS[theme]);
  try {
    if (choice === 'auto') localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, choice);
  } catch { /* not remembered */ }
  return theme;
}

/** Calls back when the system's preference changes (for auto). */
export function onSystemTheme(f: () => void): void {
  matchMedia(SYSTEM_LIGHT).addEventListener('change', f);
}
