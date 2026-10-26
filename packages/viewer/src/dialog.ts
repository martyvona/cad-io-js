// Modal dialogs (the user, 2026-10-25; CLAUDE.md, "The viewer"): the native <dialog> shown with showModal(), so the
// page behind is inert and Escape closes it, one at a time, removed when closed. A message with buttons, and a URL to
// type or paste. Styled in index.html (.cv-dialog).

export interface DialogButton {
  label: string;
  /** What the dialog resolves to when it's pressed. */
  value: string;
  /** The default (Enter), drawn as such. */
  primary?: boolean;
}

export interface DialogOptions {
  title: string;
  /** Paragraphs: text, or [label, value] rows shown as a table (file names, sizes, hashes: monospace). */
  body: (string | [string, string][])[];
  buttons: DialogButton[];
  /** Drawn as an error. */
  error?: boolean;
  /** A text field (its value is what `showDialog` resolves to with, as `input`), for `askUrl`. */
  input?: { label: string; value?: string; placeholder?: string };
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
  form.append(title);
  for (const part of o.body) {
    if (typeof part === 'string') {
      const p = document.createElement('p');
      p.textContent = part;
      form.append(p);
      continue;
    }
    const table = document.createElement('table');
    for (const [label, value] of part) {
      const row = table.insertRow();
      row.insertCell().textContent = label;
      row.insertCell().textContent = value;
    }
    form.append(table);
  }
  let field: HTMLInputElement | undefined;
  if (o.input) {
    const label = document.createElement('label');
    label.textContent = o.input.label;
    field = document.createElement('input');
    field.type = 'text';
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
    (field ?? buttons.querySelector<HTMLButtonElement>('button.primary'))?.focus();
  });
}

/** Asks for a URL to load (typed or pasted); undefined if cancelled or left empty. */
export async function askUrl(o: { title?: string; body?: DialogOptions['body']; value?: string } = {}):
  Promise<string | undefined> {
  const r = await showDialog({ title: o.title ?? 'Load URL', body: o.body ?? [],
    input: { label: 'URL', value: o.value, placeholder: 'https://... or /content/...' },
    buttons: [{ label: 'Load', value: 'load', primary: true }, { label: 'Cancel', value: 'cancel' }] });
  return r.button === 'load' && r.input ? r.input : undefined;
}
