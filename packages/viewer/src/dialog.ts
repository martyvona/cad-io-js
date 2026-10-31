// Modal dialogs (the user, 2026-10-25; CLAUDE.md, "The viewer"): the native <dialog> shown with showModal(), so the
// page behind is inert and Escape closes it, one at a time, removed when closed. A message with buttons, and a URL to
// type or paste, and About (about.ts), or controls of the caller's own. Dragged by the title
// (the user, 2026-10-31: to see what's under it), kept with its title in the window. Styled in index.html
// (.cv-dialog).

export interface DialogButton {
  label: string;
  /** What the dialog resolves to when it's pressed. */
  value: string;
  /** The default (Enter), drawn as such. */
  primary?: boolean;
  /** Done when it's pressed, the dialog left open (Copy IDs: problems.ts). */
  action?: (button: HTMLButtonElement) => void;
  disabled?: boolean;
}

export interface DialogOptions {
  title: string;
  /**
   * Paragraphs: text, [label, value] rows shown as a table (file names, sizes, hashes: monospace), or text with links
   * (`{ text, href }` pieces, opened in a new tab).
   */
  body: (string | [string, string][] | { text: string; href?: string }[])[];
  buttons: DialogButton[];
  /** Drawn as an error. */
  error?: boolean;
  /** Controls of the caller's own, after the body. */
  content?: HTMLElement;
  /** A text field (its value is what `showDialog` resolves to with, as `input`), for `askUrl`. */
  input?: { label: string; value?: string; placeholder?: string;
    /** Several lines (a textarea: pasted lines kept; ctrl/cmd-Enter presses the primary button), for Select by ID. */
    lines?: number };
}

export interface DialogResult {
  /** The button pressed, or undefined when closed otherwise (Escape). */
  button?: string;
  input?: string;
}

/** Shows a modal dialog; resolves when it closes. */
export function showDialog(o: DialogOptions): Promise<DialogResult> {
  const dialog = document.createElement('dialog');
  dialog.className = `cv-dialog${o.error ? ' error' : ''}`;
  const form = document.createElement('form');
  form.method = 'dialog';
  const title = document.createElement('h2');
  title.textContent = o.title;
  title.className = 'drag';
  form.append(title);
  draggable(dialog, title);
  for (const part of o.body) {
    if (typeof part === 'string') {
      const p = document.createElement('p');
      p.textContent = part;
      form.append(p);
      continue;
    }
    if (part.length && !Array.isArray(part[0])) {
      const p = document.createElement('p');
      for (const piece of part as { text: string; href?: string }[]) {
        if (!piece.href) {
          p.append(piece.text);
          continue;
        }
        const a = document.createElement('a');
        a.href = piece.href;
        a.textContent = piece.text;
        a.target = '_blank';
        a.rel = 'noopener';
        p.append(a);
      }
      form.append(p);
      continue;
    }
    // (In a box that scrolls, for long lists: problems.ts.)
    const box = document.createElement('div');
    box.className = 'table';
    const table = document.createElement('table');
    for (const [label, value] of part as [string, string][]) {
      const row = table.insertRow();
      row.insertCell().textContent = label;
      row.insertCell().textContent = value;
    }
    box.append(table);
    form.append(box);
  }
  if (o.content) form.append(o.content);
  let field: HTMLInputElement | HTMLTextAreaElement | undefined;
  if (o.input) {
    const label = document.createElement('label');
    label.textContent = o.input.label;
    if (o.input.lines) {
      const area = document.createElement('textarea');
      area.rows = o.input.lines;
      area.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
          e.preventDefault();
          form.requestSubmit(buttons.querySelector<HTMLButtonElement>('button.primary'));
        }
      });
      field = area;
    } else {
      const input = document.createElement('input');
      input.type = 'text';
      field = input;
    }
    field.value = o.input.value ?? '';
    field.placeholder = o.input.placeholder ?? '';
    field.spellcheck = false;
    field.autocomplete = 'off';
    label.append(field);
    form.append(label);
  }
  const buttons = document.createElement('div');
  buttons.className = 'buttons';
  // The primary button first in the markup, so Enter in the field presses it; drawn last (row-reverse).
  for (const b of [...o.buttons].sort((x, y) => Number(!!y.primary) - Number(!!x.primary))) {
    const button = document.createElement('button');
    button.value = b.value;
    button.textContent = b.label;
    button.disabled = !!b.disabled;
    if (b.action) {
      const action = b.action;
      button.type = 'button';
      button.addEventListener('click', () => action(button));
    }
    if (b.primary) button.className = 'primary';
    buttons.append(button);
  }
  form.append(buttons);
  dialog.append(form);
  document.body.append(dialog);
  return new Promise((resolve) => {
    dialog.addEventListener('close', () => {
      dialog.remove();
      resolve({ ...(dialog.returnValue ? { button: dialog.returnValue } : {}),
        ...(field ? { input: field.value.trim() } : {}) });
    });
    dialog.showModal();
    (field ?? o.content?.querySelector<HTMLElement>('select, input') ??
      buttons.querySelector<HTMLButtonElement>('button.primary'))?.focus();
  });
}

/**
 * Lets a dialog be moved by dragging its handle (a mouse, a pen or a finger), by a translation from where the browser
 * centres it, the handle kept in the window.
 */
export function draggable(dialog: HTMLElement, handle: HTMLElement): void {
  let at = { x: 0, y: 0 };
  let drag: { id: number; x: number; y: number; from: { x: number; y: number } } | undefined;
  const place = (x: number, y: number) => {
    at = { x, y };
    dialog.style.translate = `${x}px ${y}px`;
  };
  handle.addEventListener('pointerdown', (e) => {
    // (Not by a button in it: a close button.)
    if (e.button > 0 || (e.target as HTMLElement).closest('button')) return;
    drag = { id: e.pointerId, x: e.clientX, y: e.clientY, from: at };
    try {
      handle.setPointerCapture(e.pointerId);
    } catch {
      // (A pointer the browser doesn't know as active: dragged while it stays over the handle.)
    }
    e.preventDefault();
  });
  handle.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const x = drag.from.x + e.clientX - drag.x, y = drag.from.y + e.clientY - drag.y;
    place(x, y);
    // (The handle kept in the window: at least 40 pixels of it across, all of it down.)
    const r = handle.getBoundingClientRect();
    const dx = Math.min(0, innerWidth - 40 - r.left) + Math.max(0, 40 - r.right);
    const dy = Math.min(0, innerHeight - r.bottom) + Math.max(0, -r.top);
    if (dx || dy) place(x + dx, y + dy);
  });
  const end = (e: PointerEvent) => { if (drag?.id === e.pointerId) drag = undefined; };
  handle.addEventListener('pointerup', end);
  handle.addEventListener('pointercancel', end);
}

/**
 * A modal that blocks the page until it's closed by the caller (Escape doesn't): a title and a line, as while
 * exporting (the page's meshes lent to the import worker meanwhile: viewer.ts). Returns its close.
 */
export function showBusy(title: string, text: string): () => void {
  const dialog = document.createElement('dialog');
  dialog.className = 'cv-dialog';
  const h = document.createElement('h2');
  h.textContent = title;
  const p = document.createElement('p');
  p.textContent = text;
  dialog.append(h, p);
  dialog.addEventListener('cancel', (e) => e.preventDefault());
  document.body.append(dialog);
  dialog.showModal();
  return () => {
    dialog.close();
    dialog.remove();
  };
}

/** Asks for a URL to load (typed or pasted); undefined if cancelled or left empty. */
export async function askUrl(o: { title?: string; body?: DialogOptions['body']; value?: string } = {}):
  Promise<string | undefined> {
  const r = await showDialog({ title: o.title ?? 'Load URL', body: o.body ?? [],
    input: { label: 'URL', value: o.value, placeholder: 'https://..., or a path within the content root' },
    buttons: [{ label: 'Load', value: 'load', primary: true }, { label: 'Cancel', value: 'cancel' }] });
  return r.button === 'load' && r.input ? r.input : undefined;
}
