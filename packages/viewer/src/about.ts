// The About dialog (File's About...): who made the viewer, its license, where its source is; and the model open, its
// file, objects and triangles.

/// <reference types="vite/client" />

import { showDialog } from './dialog.ts';
import { updateText, type UpdateCheck } from './update-check.ts';
import { VERSION } from './version.ts';

export const REPOSITORY = 'https://github.com/martyvona/cad-io-js';

/**
 * Shows it, with the model open (rows of a table), if any, and with `updates` Check for updates (only when pressed:
 * update-check.ts), saying whether the server has another version (`updates`' state, shared with the controls'
 * badge) with Reload; resolves when it's closed.
 */
export async function showAbout(model?: [string, string][], updates?: UpdateCheck): Promise<void> {
  const update = document.createElement('p');
  update.className = 'update';
  update.hidden = !updates;
  const text = document.createElement('span');
  const button = (label: string, f: () => void) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    b.addEventListener('click', f);
    return b;
  };
  // What the last check here found, when it wasn't another version (that's said by the state), or that it's checking.
  let said = '';
  let failed = false;
  let checking = false;
  const show = () => {
    const t = updates && updateText(updates.state);
    text.textContent = checking ? 'Checking...' : failed ? said : t ?? said;
    text.classList.toggle('available', !checking && !failed && !!t);
    text.classList.toggle('failed', !checking && failed);
    reload.hidden = checking || !t;
    reload.disabled = !updates?.state.ready;
  };
  const check = button('Check for updates', () => {
    checking = check.disabled = true;
    show();
    void updates?.check(true).then((r) => {
      // (An error is said even with another version seen, which stays when the server isn't reached: Reload with it.)
      failed = typeof r === 'object';
      said = typeof r === 'object' ? r.error : r === 'same' ? 'This is the latest version.' : '';
      checking = check.disabled = false;
      show();
    });
  });
  const reload = button('Reload', () => location.reload());
  // The button first and the result beside it (index.html), so the button never moves as the result changes.
  update.append(check, text, reload);
  show();
  // (Another version found ends Checking... before its check resolves, which waits for the worker to download it; a
  // change, by this check or the badge's, replaces an error said.)
  const changed = () => {
    checking = failed = false;
    show();
  };
  updates?.listeners.add(changed);
  try {
    await showDialog({
      title: 'cad-io-js CAD viewer',
      body: [
        'Views STEP, glTF and three.js models in the browser: part of cad-io-js, for reading CAD files into memory ' +
          'and converting them, in TypeScript. Nothing you open is uploaded.',
        ...(VERSION ? [`Version ${VERSION}.`] : []),
        update,
        'By Marsette Vona and Claude (Anthropic).',
        [{ text: 'Licensed under AGPL-3.0-only, except the OCCT tessellation backend, LGPL-2.1 with the Open ' +
          'CASCADE exception; the demo models are CC BY-SA 4.0.' },
        // A build has licenses.md beside the page (vite.config.ts); the dev server doesn't.
        ...(import.meta.env.PROD ? [{ text: ' What the viewer bundles, and under which licenses: ' },
          { text: 'licenses.md', href: new URL('licenses.md', document.baseURI).href }, { text: '.' }] : [])],
        [{ text: 'Source: ' }, { text: REPOSITORY.replace('https://', ''), href: REPOSITORY }],
        ...(model ? ['The model open:', model] : ['No model open.']),
      ],
      buttons: [{ label: 'Close', value: 'close', primary: true }],
    });
  } finally {
    updates?.listeners.delete(changed);
  }
}
