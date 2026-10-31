// A context menu (the user, 2026-10-31: right-clicking a tree node for actions on it): a list of buttons at a point
// of the page, closed by choosing one, Escape, a press elsewhere, scrolling or the window losing focus. One at a time;
// styled in index.html (.cv-menu).

export interface MenuItem {
  label: string;
  action: () => void;
}

let open: { close(): void } | undefined;

/** Shows a menu at a point (client pixels), kept inside the window; closes any other first. */
export function showMenu(x: number, y: number, items: readonly MenuItem[]): void {
  open?.close();
  const menu = document.createElement('div');
  menu.className = 'cv-menu';
  menu.setAttribute('role', 'menu');
  const close = () => {
    menu.remove();
    removeEventListener('pointerdown', outside, true);
    removeEventListener('keydown', key, true);
    removeEventListener('blur', close);
    removeEventListener('wheel', close, true);
    removeEventListener('resize', close);
    if (open === handle) open = undefined;
  };
  const handle = { close };
  const outside = (e: Event) => { if (!menu.contains(e.target as Node)) close(); };
  const key = (e: KeyboardEvent) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    close();
  };
  for (const item of items) {
    const b = document.createElement('button');
    b.type = 'button';
    b.setAttribute('role', 'menuitem');
    b.textContent = item.label;
    b.addEventListener('click', () => {
      close();
      item.action();
    });
    menu.append(b);
  }
  document.body.append(menu);
  const r = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(0, Math.min(x, innerWidth - r.width))}px`;
  menu.style.top = `${Math.max(0, Math.min(y, innerHeight - r.height))}px`;
  addEventListener('pointerdown', outside, true);
  addEventListener('keydown', key, true);
  addEventListener('blur', close);
  addEventListener('wheel', close, true);
  addEventListener('resize', close);
  open = handle;
  menu.querySelector('button')?.focus();
}

/** Closes the menu shown, if any. */
export function closeMenu(): void {
  open?.close();
}
