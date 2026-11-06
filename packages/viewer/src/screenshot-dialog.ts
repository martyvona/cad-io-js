// Screenshot...: a modal with the image's format, what it shows (the model alone, or the whole window with its
// controls, redrawn or by the browser's tab capture where there is one) and its width in CSS pixels, starting at what
// it shows on screen (the height follows, in proportion), and for the model alone as PNG a transparent background.
// The choices but the width are remembered in this browser (`cad-viewer.screenshot`): the width depends on the window.

import { showDialog } from './dialog.ts';
import { heightFor, type ImageFormat } from './screenshot.ts';

export type ScreenshotWhat = 'model' | 'window';
export type ScreenshotHow = 'redraw' | 'tab';

export interface ScreenshotChoice {
  format: ImageFormat;
  what: ScreenshotWhat;
  /** How the whole window is taken. */
  how: ScreenshotHow;
  /** The image's width in pixels. */
  width: number;
  /** The model alone, as PNG: a transparent background. */
  transparent: boolean;
}

/** What can be taken: each kind's size on screen (CSS pixels; the model's absent when none of it shows). */
export interface ScreenshotSizes {
  model?: { width: number; height: number };
  window: { width: number; height: number };
  /** Whether the browser can capture its tab. */
  tab: boolean;
}

const STORE = 'cad-viewer.screenshot';
/** The largest width offered (browsers' canvases are limited to about 16k pixels a side). */
export const MAX_WIDTH = 16384;

function remembered(): Omit<ScreenshotChoice, 'width'> {
  const base: Omit<ScreenshotChoice, 'width'> = { format: 'png', what: 'model', how: 'redraw', transparent: false };
  try {
    const kept = JSON.parse(localStorage.getItem(STORE) ?? '{}') as Partial<ScreenshotChoice>;
    if (kept.format === 'png' || kept.format === 'jpeg') base.format = kept.format;
    if (kept.what === 'model' || kept.what === 'window') base.what = kept.what;
    if (kept.how === 'redraw' || kept.how === 'tab') base.how = kept.how;
    if (typeof kept.transparent === 'boolean') base.transparent = kept.transparent;
  } catch {
    // (Storage unavailable or unreadable: the defaults.)
  }
  return base;
}

const labelled = (text: string, control: HTMLElement) => {
  const l = document.createElement('label');
  l.textContent = text;
  l.append(control);
  return l;
};
const select = (options: [string, string][], value: string) => {
  const s = document.createElement('select');
  for (const [v, t] of options) s.add(new Option(t, v));
  s.value = value;
  return s;
};

/** Asks what to take; undefined if cancelled. */
export async function askScreenshot(sizes: ScreenshotSizes): Promise<ScreenshotChoice | undefined> {
  const kept = remembered();
  if (!sizes.model) kept.what = 'window';
  if (!sizes.tab) kept.how = 'redraw';
  const box = document.createElement('div');
  const format = select([['png', 'PNG'], ['jpeg', 'JPEG']], kept.format);
  const what = select([['model', 'The model only'], ['window', 'The whole window, with its controls']], kept.what);
  what.options[0]!.disabled = !sizes.model;
  const how = select([['redraw', 'Redrawn from the page'], ['tab', "The browser's tab capture (it asks first)"]],
    kept.how);
  const howRow = labelled('Taken as', how);
  // (Only PNG has transparency, and only the model alone has a background of its own to leave out.)
  const transparent = Object.assign(document.createElement('input'), { type: 'checkbox', checked: kept.transparent });
  const transparentRow = document.createElement('label');
  transparentRow.className = 'check';
  transparentRow.append(transparent, 'Transparent background');
  const width = Object.assign(document.createElement('input'), { type: 'number', min: '1', max: String(MAX_WIDTH),
    step: '1' });
  const height = document.createElement('p');
  height.className = 'note';
  box.append(labelled('Format', format), labelled('Shows', what), howRow, transparentRow,
    labelled('Width (pixels)', width), height);
  if (!sizes.model) {
    const note = document.createElement('p');
    note.className = 'note';
    note.textContent = 'The model is out of view, so only the whole window can be taken.';
    box.append(note);
  }
  // The width starts at what's shown on screen, and follows a change of what's shown until it's typed in.
  let edited = false;
  const size = () => what.value === 'model' ? sizes.model! : sizes.window;
  const value = () => {
    const v = Math.round(Number(width.value));
    return Number.isFinite(v) && v >= 1 ? Math.min(MAX_WIDTH, v) : size().width;
  };
  const show = () => {
    howRow.hidden = what.value !== 'window' || !sizes.tab;
    transparentRow.hidden = what.value !== 'model' || format.value !== 'png';
    if (!edited) width.value = String(Math.round(size().width));
    height.textContent = `Height: ${heightFor(value(), size())} pixels (in proportion; ${Math.round(size().width)} x `
      + `${Math.round(size().height)} on screen)`;
  };
  what.addEventListener('change', show);
  format.addEventListener('change', show);
  width.addEventListener('input', () => {
    edited = true;
    show();
  });
  width.addEventListener('change', () => {
    width.value = String(value());
    show();
  });
  show();
  const r = await showDialog({ title: 'Screenshot', body: [], content: box,
    buttons: [{ label: 'Save...', value: 'save', primary: true }, { label: 'Cancel', value: 'cancel' }] });
  if (r.button !== 'save') return undefined;
  const choice: ScreenshotChoice = { format: format.value as ImageFormat, what: what.value as ScreenshotWhat,
    how: how.value as ScreenshotHow, width: value(), transparent: transparent.checked };
  try {
    localStorage.setItem(STORE, JSON.stringify({ format: choice.format, what: choice.what, how: choice.how,
      transparent: choice.transparent }));
  } catch {
    // (Not remembered.)
  }
  return choice;
}
