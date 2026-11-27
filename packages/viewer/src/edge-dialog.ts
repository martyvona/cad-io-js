// Mesh edge detection... (Rendering): edges detected again from the meshes' triangles (edges.ts), in a panel that
// floats over the page without blocking it (the 3D view, the tree and the selection still work), dragged by its title,
// closed by its x or Escape. The angle past which an edge is kept and the weld tolerance (both remembered in the
// browser and used by every later load's own detection: ui.ts), Selection only (the selection's parts, else every
// part with triangles), Detect, and Defaults; what a run did said below. One at a time: asked for again while open,
// it's brought forward as it is. Values set and runs made elsewhere (a replay: ui.ts) show in it too, while it's open.

import { draggable } from './dialog.ts';
import { DEFAULT_DETECTION, detectionProblem, type EdgeDetection } from './edges.ts';

/** What the panel works with. */
export interface EdgeDetectionBinding {
  /** The values to start from (the remembered ones). */
  values(): EdgeDetection;
  /** Valid values the user has set (Defaults too): remembered, for later loads. */
  remember(d: EdgeDetection): void;
  /** A run (shown here through edgeRunShown); resolves with what it did, or why it didn't (`error`). */
  run(d: EdgeDetection, selectionOnly: boolean): Promise<EdgeRun>;
}

/** What a run did, in words, or why it didn't (`error`). */
export interface EdgeRun { text: string; error?: boolean }

let panel: { focus(): void; close(): void; values(d: EdgeDetection): void;
  run(d: EdgeDetection, selectionOnly: boolean, done: Promise<EdgeRun>): void } | undefined;

/** Shows the panel (brought forward, as it is, if it's open). */
export function showEdgeDetection(b: EdgeDetectionBinding): void {
  (panel ??= makePanel(b)).focus();
}

export function closeEdgeDetection(): void {
  panel?.close();
}

/** Values set (remembered), shown in the panel if it's open and shows others. */
export function edgeValuesShown(d: EdgeDetection): void {
  panel?.values(d);
}

/** A run under way, shown in the panel if it's open: its values, Selection only, then what it did. */
export function edgeRunShown(d: EdgeDetection, selectionOnly: boolean, done: Promise<EdgeRun>): void {
  panel?.run(d, selectionOnly, done);
}

/** Whether the panel is open. */
export function edgeDetectionOpen(): boolean {
  return !!panel;
}

function makePanel(b: EdgeDetectionBinding): NonNullable<typeof panel> {
  const dialog = document.createElement('dialog');
  dialog.className = 'cv-dialog floating edge-detection';
  dialog.tabIndex = -1;
  const title = document.createElement('h2');
  title.className = 'drag';
  const text = Object.assign(document.createElement('span'), { textContent: 'Mesh Edge Detection' });
  const close = Object.assign(document.createElement('button'), { type: 'button', textContent: '×',
    className: 'close' });
  close.setAttribute('aria-label', 'Close');
  const end = () => {
    dialog.close();
    dialog.remove();
    panel = undefined;
  };
  close.addEventListener('click', end);
  title.append(text, close);
  draggable(dialog, title);
  const field = (label: string, attrs: Record<string, string>) => {
    const l = document.createElement('label');
    l.textContent = label;
    const input = Object.assign(document.createElement('input'), { type: 'number', ...attrs });
    l.append(input);
    return { l, input };
  };
  const angle = field('Angle threshold (degrees)', { min: '0', max: '180', step: '1', name: 'angle' });
  const grid = field('Weld tolerance (mm)', { min: '0', step: 'any', name: 'grid' });
  const intro = Object.assign(document.createElement('p'), { className: 'note', textContent: 'An edge is drawn '
    + 'where the triangles on either side meet at more than the angle, or where it has one triangle; positions '
    + 'within the weld tolerance are one vertex. Edges detected go to each part\'s "detected mesh edges", beside its '
    + 'B-rep edges; later loads detect with these values too.' });
  const only = document.createElement('label');
  only.className = 'check';
  const selection = Object.assign(document.createElement('input'), { type: 'checkbox', name: 'selection' });
  only.append(selection, document.createTextNode('Selection only (its parts)'));
  const said = Object.assign(document.createElement('p'), { className: 'note result', hidden: true });
  const buttons = document.createElement('div');
  buttons.className = 'buttons';
  const button = (label: string, primary = false) => {
    const x = Object.assign(document.createElement('button'), { type: 'button', textContent: label });
    if (primary) x.className = 'primary';
    buttons.append(x);
    return x;
  };
  const detect = button('Detect', true);
  const defaults = button('Defaults');
  dialog.append(title, intro, angle.l, grid.l, only, buttons, said);
  document.body.append(dialog);

  const show = (d: EdgeDetection) => {
    angle.input.value = String(d.angle);
    grid.input.value = String(d.grid);
  };
  const read = (): EdgeDetection => ({ angle: Number(angle.input.value), grid: Number(grid.input.value) });
  const say = (t: string, error = false) => {
    said.textContent = t;
    said.hidden = !t;
    said.classList.toggle('failed', error);
  };
  // A change: remembered where valid, said where not.
  const changed = () => {
    const d = read(), p = angle.input.value.trim() && grid.input.value.trim() ? detectionProblem(d)
      : 'give the angle and the weld tolerance';
    say(p ? `Not remembered: ${p}.` : '', !!p);
    if (!p) b.remember(d);
  };
  angle.input.addEventListener('change', changed);
  grid.input.addEventListener('change', changed);
  defaults.addEventListener('click', () => {
    show(DEFAULT_DETECTION);
    b.remember({ ...DEFAULT_DETECTION });
    say('');
  });
  detect.addEventListener('click', async () => {
    const d = read(), p = detectionProblem(d);
    // (Remembered already: a field's change comes before the click, as the field loses the focus.)
    if (p) return say(`Not detected: ${p}.`, true);
    await b.run(d, selection.checked).catch(() => undefined);
  });
  // (Runs end in the order they began: a later one stops an earlier, so the last said is the last run's.)
  let runs = 0;
  const run = async (d: EdgeDetection, selectionOnly: boolean, done: Promise<EdgeRun>) => {
    const k = ++runs;
    show(d);
    selection.checked = selectionOnly;
    detect.disabled = true;
    say('Detecting...');
    try {
      const r = await done;
      if (k === runs) say(r.text, !!r.error);
    } catch (e) {
      if (k === runs) say((e as Error).message, true);
    } finally {
      if (k === runs) detect.disabled = false;
    }
  };
  dialog.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    end();
  });
  show(b.values());
  dialog.show();
  return {
    close: end,
    values: (d) => {
      const now = read();
      if (now.angle !== d.angle || now.grid !== d.grid) show(d);
    },
    run: (d, selectionOnly, done) => void run(d, selectionOnly, done),
    focus: () => {
      if (matchMedia('(pointer: coarse)').matches) dialog.focus({ preventScroll: true });
      else angle.input.focus();
    },
  };
}
