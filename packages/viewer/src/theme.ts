// The viewer's theme (the user, 2026-10-27): View's Theme, Auto (the default: the system's, as it changes), Light or
// Dark. The page's colours are CSS variables (index.html) chosen by the root's data-theme, set before the first paint
// by index.html's inline script from what this browser remembers (the same rule as resolveTheme); the 3D view's
// background is the Viewer's: the theme's, or a colour of the user's own (View's Custom background, the user,
// 2026-10-27), remembered in this browser too.

export type Theme = 'dark' | 'light';
export type ThemeChoice = 'auto' | Theme;

const KEY = 'cad-viewer.theme';
const SYSTEM_LIGHT = '(prefers-color-scheme: light)';

/** The 3D view's background (index.html's --view-bg, which shows before the first frame). */
export const VIEW_BACKGROUNDS: Readonly<Record<Theme, number>> = { dark: 0x404040, light: 0xffffff };
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

const BACKGROUND_KEY = 'cad-viewer.background';
const HEX = /^#[0-9a-f]{6}$/i;

/** The view's own background: whether it's used (else the theme's), and its colour, `#rrggbb`. */
export interface CustomBackground { on: boolean; color: string }

/** What this browser remembers of the custom background (off, and `fallback`'s colour, if nothing or no storage). */
export function customBackground(fallback: string): CustomBackground {
  try {
    const b = JSON.parse(localStorage.getItem(BACKGROUND_KEY) ?? 'null') as Partial<CustomBackground> | null;
    if (b && typeof b.color === 'string' && HEX.test(b.color)) return { on: b.on === true, color: b.color };
  } catch { /* nothing remembered */ }
  return { on: false, color: fallback };
}

/**
 * Applies the custom background to the page (index.html's --view-bg, which shows before the first frame; the inline
 * script sets it so too) and remembers it.
 */
export function applyCustomBackground(b: CustomBackground): void {
  const style = document.documentElement.style;
  if (b.on && HEX.test(b.color)) style.setProperty('--view-bg', b.color);
  else style.removeProperty('--view-bg');
  try {
    localStorage.setItem(BACKGROUND_KEY, JSON.stringify(b));
  } catch { /* not remembered */ }
}

/** A colour as `#rrggbb`. */
export const hexColour = (c: number) => `#${c.toString(16).padStart(6, '0')}`;

/** Calls back when the system's preference changes (for auto). */
export function onSystemTheme(f: () => void): void {
  matchMedia(SYSTEM_LIGHT).addEventListener('change', f);
}
