// The viewer's entry point. See README.md, "The viewer", and CLAUDE.md, "The viewer".

import { buildUi } from './ui.ts';
import { Viewer } from './viewer.ts';

const viewer = new Viewer(document.getElementById('view')!);
buildUi(viewer, document.getElementById('status')!);
// For the browser check and the console.
(globalThis as { viewer?: Viewer }).viewer = viewer;
