// Override Appearance... (the user, 2026-10-31; the tree's context menu, tree-panel.ts): one node's appearance
// override set exactly, in a modal: Visibility (Inherit, Hide, Show) and Opacity (Inherit, Transparent, Default: the
// file's own), with a slider and a box for the alpha. They take input only while Opacity is Transparent; otherwise
// they show the alpha the node would draw with (inherited, or the file's), and switching to Transparent starts from
// that. Every change is shown in the view at once (the user, 2026-10-31), Cancel putting back what was there.

import { showDialog } from './dialog.ts';
import type { AppearanceOverride, Look } from './model.ts';

export interface AppearanceChoice {
  /** The node's name, for the title. */
  name: string;
  /** Its own override, if any. */
  own?: AppearanceOverride;
  /** What it would inherit (its parent's look). */
  inherited: Look;
  /** The file's own opacity of what it draws, and whether that varies below it (the first part's then). */
  file: { alpha: number; varies: boolean };
  /** Edges, curves and points: no opacity (they aren't made transparent). */
  lines?: boolean;
  /** Shows a choice in the view as it's made (the caller puts back `own` if the dialog is cancelled). */
  preview?: (o: AppearanceOverride) => void;
}

type Visibility = 'inherit' | 'hide' | 'show';
type Opacity = 'inherit' | 'transparent' | 'default';

/** The override chosen, from the dialog's controls (absent fields inherited). */
export function overrideOf(visibility: Visibility, opacity: Opacity, alpha: number): AppearanceOverride {
  return { ...(visibility === 'inherit' ? {} : { hidden: visibility === 'hide' }),
    ...(opacity === 'inherit' ? {} : opacity === 'default' ? { transparent: false }
      : { transparent: true, alpha: Math.min(1, Math.max(0, alpha)) }) };
}

const round = (x: number) => Math.round(x * 100) / 100;

/** Asks for a node's override; undefined if cancelled. */
export async function askAppearance(c: AppearanceChoice): Promise<AppearanceOverride | undefined> {
  const box = document.createElement('div');
  const select = (label: string, options: [string, string][], value: string) => {
    const l = document.createElement('label');
    l.textContent = label;
    const s = document.createElement('select');
    for (const [v, text] of options) s.add(new Option(text, v));
    s.value = value;
    l.append(s);
    box.append(l);
    return s;
  };
  const shown = (alpha: number | undefined) => alpha === undefined ? "the file's" : String(round(alpha));
  const visibility = select('Visibility', [['inherit', `Inherit (${c.inherited.hidden ? 'hidden' : 'shown'})`],
    ['hide', 'Hide'], ['show', 'Show']], c.own?.hidden === undefined ? 'inherit' : c.own.hidden ? 'hide' : 'show');
  const opacity = select('Opacity', [['inherit', `Inherit (${shown(c.inherited.alpha)})`],
    ['transparent', 'Transparent'], ['default', "Default (the file's)"]],
  c.own?.transparent === undefined ? 'inherit' : c.own.transparent ? 'transparent' : 'default');
  const row = document.createElement('div');
  row.className = 'alpha';
  const slider = Object.assign(document.createElement('input'), { type: 'range', min: '0', max: '1', step: '0.01' });
  const number = Object.assign(document.createElement('input'), { type: 'number', min: '0', max: '1',
    step: '0.01' });
  slider.setAttribute('aria-label', 'Alpha');
  number.setAttribute('aria-label', 'Alpha');
  row.append(slider, number);
  box.append(row);
  if (c.file.varies || c.lines) {
    const note = document.createElement('p');
    note.className = 'note';
    note.textContent = c.lines ? "Edges, curves and points keep their own opacity." :
      "The file's opacity varies below this node: the first part's is shown.";
    box.append(note);
  }
  let alpha = c.own?.transparent ? c.own.alpha ?? 1 : c.inherited.alpha ?? c.file.alpha;
  const show = (a: number) => {
    slider.value = String(a);
    number.value = String(round(a));
  };
  // What the node would draw with, while the alpha isn't its own.
  const effective = () => opacity.value === 'inherit' ? c.inherited.alpha ?? c.file.alpha : c.file.alpha;
  const sync = () => {
    const live = opacity.value === 'transparent';
    slider.disabled = number.disabled = !live;
    if (!live) alpha = effective();
    show(alpha);
  };
  const preview = () => c.preview?.(overrideOf(visibility.value as Visibility, opacity.value as Opacity, alpha));
  opacity.addEventListener('change', () => {
    sync();
    preview();
  });
  visibility.addEventListener('change', preview);
  slider.addEventListener('input', () => {
    alpha = Number(slider.value);
    number.value = String(round(alpha));
    preview();
  });
  number.addEventListener('input', () => {
    const v = Number(number.value);
    if (number.value.trim() === '' || !Number.isFinite(v)) return;
    alpha = Math.min(1, Math.max(0, v));
    slider.value = String(alpha);
    preview();
  });
  if (c.lines) opacity.disabled = true;
  sync();
  const r = await showDialog({ title: `Override Appearance: ${c.name}`, body: [], content: box,
    buttons: [{ label: 'OK', value: 'ok', primary: true }, { label: 'Cancel', value: 'cancel' }] });
  if (r.button !== 'ok') return undefined;
  return overrideOf(visibility.value as Visibility, opacity.value as Opacity, alpha);
}
