// File's Link to this view... (docs/viewer.md): a modal with Include device defaults, the link in a box that can be
// selected and scrolls sideways (links run long: one line, not wrapped), and Copy (to the clipboard where the page may
// write it, else shown in a prompt to copy: problems.ts's copyText), which leaves the dialog open.

import { showDialog } from './dialog.ts';
import { copyText } from './problems.ts';

export interface LinkDialogOptions {
  /** The view's address, as it is now (with or without the device's defaults, as `defaults` says). */
  link(): string;
  /** Whether the link spells out the device's defaults (the profile, the edge style). */
  defaults: boolean;
  /** The option changed (kept, remembered): the link is made again after. */
  setDefaults(on: boolean): void;
}

/** Shows the link to this view; resolves when it's closed. */
export async function showLink(o: LinkDialogOptions): Promise<void> {
  const content = document.createElement('div');
  const box = Object.assign(document.createElement('input'), { type: 'checkbox', checked: o.defaults });
  const option = document.createElement('label');
  option.className = 'check';
  option.title = 'The settings whose defaults depend on the device (the meshing profile, the edge style) spelled out, '
    + 'so the link shows the same on a phone as on a desktop';
  option.append(box, 'Include device defaults');
  const text = document.createElement('textarea');
  text.className = 'link';
  text.readOnly = true;
  text.rows = 1;
  text.wrap = 'off';
  text.spellcheck = false;
  text.setAttribute('aria-label', 'The link');
  text.value = o.link();
  // (All of it at once, to copy by hand.)
  text.addEventListener('focus', () => text.select());
  box.addEventListener('change', () => {
    o.setDefaults(box.checked);
    text.value = o.link();
  });
  content.append(option, text);
  await showDialog({ title: 'Link to this view', body: [], content,
    buttons: [{ label: 'Close', value: 'close' }, { label: 'Copy', value: 'copy', primary: true,
      action: (b) => void copyText(text.value, 'The link to this view:').then((copied) => {
        if (!copied) return;
        b.textContent = 'Copied';
        setTimeout(() => { b.textContent = 'Copy'; }, 2000);
      }) }] });
}
