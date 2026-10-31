// Override Appearance... (the user, 2026-10-31; the tree's context menu, tree-panel.ts): one node's appearance
// override, in a panel that floats over the page without blocking it (the 3D view and the tree still work), dragged by
// its title, closed by its x or Escape. Visibility (Inherit, Hide, Show), Opacity (Inherit, Transparent, Default: the
// file's own) with a slider and a box for the alpha, and Triangle edges (Inherit, On, Off; Rendering's Triangle edges
// deciding where nothing sets them). The alpha takes input only while Opacity is Transparent; otherwise it shows the
// alpha the node draws with (inherited, or the file's), and switching to Transparent starts from that. Every change
// takes effect at once (the slider as it moves), recorded once it's made (the slider let go): no OK or Cancel. One at
// a time: asked for another node while it's open, it shows that one instead.

import { draggable } from './dialog.ts';
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
  /** Rendering's Triangle edges, what the node's edges follow where nothing sets them. */
  rendering: string;
  /** Edges, curves and points: no opacity (they aren't made transparent) nor triangle edges. */
  lines?: boolean;
}

type Visibility = 'inherit' | 'hide' | 'show';
type Opacity = 'inherit' | 'transparent' | 'default';
type Edges = 'inherit' | 'on' | 'off';

/** The override chosen, from the panel's controls (absent fields inherited). */
export function overrideOf(visibility: Visibility, opacity: Opacity, alpha: number, edges: Edges = 'inherit'):
  AppearanceOverride {
  return { ...(visibility === 'inherit' ? {} : { hidden: visibility === 'hide' }),
    ...(opacity === 'inherit' ? {} : opacity === 'default' ? { transparent: false }
      : { transparent: true, alpha: Math.min(1, Math.max(0, alpha)) }),
    ...(edges === 'inherit' ? {} : { triangleEdges: edges === 'on' }) };
}

const round = (x: number) => Math.round(x * 100) / 100;

/** The panel's node: what it describes, and how a change is set (`final`: made, so recorded; else as it moves). */
export interface AppearanceBinding {
  describe(): AppearanceChoice;
  set(o: AppearanceOverride, final: boolean): void;
}

let panel: { bind(b: AppearanceBinding): void; refresh(): void; close(): void } | undefined;

/** Shows the panel for a node, or, if it's open, shows that node in it instead. */
export function showAppearance(b: AppearanceBinding): void {
  (panel ??= makePanel()).bind(b);
}

/** Shows the node's override again, if the panel is open (changed elsewhere: Hide selected, a state). */
export function refreshAppearance(): void {
  panel?.refresh();
}

export function closeAppearance(): void {
  panel?.close();
}

/** Whether the panel is open. */
export function appearanceOpen(): boolean {
  return !!panel;
}

function makePanel(): NonNullable<typeof panel> {
  const dialog = document.createElement('dialog');
  dialog.className = 'cv-dialog floating';
  const title = document.createElement('h2');
  title.className = 'drag';
  const text = document.createElement('span');
  const close = Object.assign(document.createElement('button'), { type: 'button', textContent: '\u00D7',
    className: 'close' });
  close.setAttribute('aria-label', 'Close');
  // (Gone at once, not at the dialog's close event a task later.)
  const end = () => {
    dialog.close();
    dialog.remove();
    panel = undefined;
  };
  close.addEventListener('click', end);
  title.append(text, close);
  draggable(dialog, title);
  const box = document.createElement('div');
  const select = (label: string) => {
    const l = document.createElement('label');
    l.textContent = label;
    const s = document.createElement('select');
    l.append(s);
    box.append(l);
    return s;
  };
  const options = (s: HTMLSelectElement, list: [string, string][]) => {
    s.replaceChildren(...list.map(([v, t]) => new Option(t, v)));
  };
  const visibility = select('Visibility');
  const opacity = select('Opacity');
  const row = document.createElement('div');
  row.className = 'alpha';
  const slider = Object.assign(document.createElement('input'), { type: 'range', min: '0', max: '1', step: '0.01' });
  const number = Object.assign(document.createElement('input'), { type: 'number', min: '0', max: '1',
    step: '0.01' });
  slider.setAttribute('aria-label', 'Alpha');
  number.setAttribute('aria-label', 'Alpha');
  row.append(slider, number);
  box.append(row);
  const edges = select('Triangle edges');
  const note = document.createElement('p');
  note.className = 'note';
  box.append(note);
  dialog.append(title, box);
  document.body.append(dialog);

  let binding: AppearanceBinding | undefined;
  let c: AppearanceChoice | undefined;
  let alpha = 1;
  const show = (a: number) => {
    slider.value = String(a);
    number.value = String(round(a));
  };
  // What the node would draw with, while the alpha isn't its own.
  const effective = () => opacity.value === 'inherit' ? c!.inherited.alpha ?? c!.file.alpha : c!.file.alpha;
  const sync = () => {
    const live = opacity.value === 'transparent' && !c!.lines;
    slider.disabled = number.disabled = !live;
    if (!live) alpha = effective();
    show(alpha);
  };
  const set = (final: boolean) => binding?.set(overrideOf(visibility.value as Visibility, opacity.value as Opacity,
    alpha, edges.value as Edges), final);
  // The controls from the node: its override, what it inherits.
  const read = () => {
    c = binding!.describe();
    text.textContent = `Override Appearance: ${c.name}`;
    const shown = (a: number | undefined) => a === undefined ? "the file's" : String(round(a));
    options(visibility, [['inherit', `Inherit (${c.inherited.hidden ? 'hidden' : 'shown'})`], ['hide', 'Hide'],
      ['show', 'Show']]);
    options(opacity, [['inherit', `Inherit (${shown(c.inherited.alpha)})`], ['transparent', 'Transparent'],
      ['default', "Default (the file's)"]]);
    options(edges, [['inherit', `Inherit (${c.inherited.triangleEdges === undefined ? `Rendering's: ${c.rendering}`
      : c.inherited.triangleEdges ? 'on' : 'off'})`], ['on', 'On'], ['off', 'Off']]);
    const o = c.own;
    visibility.value = o?.hidden === undefined ? 'inherit' : o.hidden ? 'hide' : 'show';
    opacity.value = o?.transparent === undefined ? 'inherit' : o.transparent ? 'transparent' : 'default';
    edges.value = o?.triangleEdges === undefined ? 'inherit' : o.triangleEdges ? 'on' : 'off';
    opacity.disabled = edges.disabled = !!c.lines;
    if (o?.transparent) alpha = o.alpha ?? 1;
    note.textContent = c.lines ? 'Edges, curves and points keep their own opacity and have no triangles.'
      : c.file.varies ? "The file's opacity varies below this node: the first part's is shown." : '';
    note.hidden = !note.textContent;
    sync();
  };
  visibility.addEventListener('change', () => set(true));
  edges.addEventListener('change', () => set(true));
  opacity.addEventListener('change', () => {
    sync();
    set(true);
  });
  slider.addEventListener('input', () => {
    alpha = Number(slider.value);
    number.value = String(round(alpha));
    set(false);
  });
  slider.addEventListener('change', () => set(true));
  number.addEventListener('input', () => {
    const v = Number(number.value);
    if (number.value.trim() === '' || !Number.isFinite(v)) return;
    alpha = Math.min(1, Math.max(0, v));
    slider.value = String(alpha);
    set(false);
  });
  number.addEventListener('change', () => set(true));
  dialog.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    end();
  });
  dialog.show();
  return {
    close: end,
    bind: (b) => {
      binding = b;
      read();
      visibility.focus();
    },
    refresh: () => { if (binding) read(); },
  };
}
