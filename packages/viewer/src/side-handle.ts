// A handle on the tree panel's right edge that drags its width (the user, 2026-10-25): it sets the --side CSS
// variable, which the panel and the view both follow (each watches its own size); a double click goes back to the
// default. The width is remembered in this browser (a convenience: without storage it simply starts at the default).
// Narrow screens, where the panel lies over the view, have no handle (index.html).

const KEY = 'cad-viewer.side';
const MIN = 140;

/** The width the panel may have in a window this wide: at least MIN, leaving at least 200 pixels of view. */
export function clampWidth(width: number, windowWidth: number): number {
  return Math.round(Math.max(MIN, Math.min(width, windowWidth - 200)));
}

export function addSideHandle(side: HTMLElement): void {
  const root = document.documentElement;
  // The width set, as --side has it (the panel's box adds its border).
  let current: number | undefined;
  const set = (width: number | undefined) => {
    current = width === undefined ? undefined : clampWidth(width, window.innerWidth);
    if (current === undefined) root.style.removeProperty('--side');
    else root.style.setProperty('--side', `${current}px`);
  };
  const remember = (width: number | undefined) => {
    try {
      if (width === undefined) localStorage.removeItem(KEY);
      else localStorage.setItem(KEY, String(width));
    } catch { /* no storage: not remembered */ }
  };
  try {
    const saved = Number(localStorage.getItem(KEY));
    if (saved > 0) set(saved);
  } catch { /* no storage: the default */ }

  const handle = document.createElement('div');
  handle.id = 'side-handle';
  handle.title = 'Drag to resize the tree; double-click for the default width';
  side.append(handle);
  handle.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    handle.classList.add('dragging');
    // Moved by as much as the pointer, wherever on the handle it was grabbed.
    const start = parseFloat(getComputedStyle(root).getPropertyValue('--side'));
    const move = (m: PointerEvent) => set(start + m.clientX - e.clientX);
    const up = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      handle.removeEventListener('pointercancel', up);
      handle.classList.remove('dragging');
      if (current !== undefined) remember(current);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
    handle.addEventListener('pointercancel', up);
  });
  handle.addEventListener('dblclick', () => {
    set(undefined);
    remember(undefined);
  });
}
