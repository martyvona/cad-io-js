// The About dialog (File's About...; the user, 2026-10-27): who made the viewer, its license, where its source is.

/// <reference types="vite/client" />

import { showDialog } from './dialog.ts';
import { VERSION } from './version.ts';

export const REPOSITORY = 'https://github.com/martyvona/cad-io-js';

/** Shows it; resolves when it's closed. */
export async function showAbout(): Promise<void> {
  await showDialog({
    title: 'cad-io-js CAD viewer',
    body: [
      'Views STEP, glTF and three.js models in the browser: part of cad-io-js, for reading CAD files into memory ' +
        'and converting them, in TypeScript. Nothing you open is uploaded.',
      ...(VERSION ? [`Version ${VERSION}.`] : []),
      'By Claude (Anthropic) and Marsette Vona.',
      [{ text: 'Licensed under Apache-2.0, except the OCCT tessellation backend, LGPL-2.1 with the Open CASCADE ' +
        'exception; the demo models are CC BY-SA 4.0.' },
      // A build has licenses.md beside the page (vite.config.ts); the dev server doesn't.
      ...(import.meta.env.PROD ? [{ text: ' What the viewer bundles, and under which licenses: ' },
        { text: 'licenses.md', href: new URL('licenses.md', document.baseURI).href }, { text: '.' }] : [])],
      [{ text: 'Source: ' }, { text: REPOSITORY.replace('https://', ''), href: REPOSITORY }],
    ],
    buttons: [{ label: 'Close', value: 'close', primary: true }],
  });
}
