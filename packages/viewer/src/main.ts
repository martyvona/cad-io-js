// The viewer's entry point. See README.md, "The viewer", and CLAUDE.md, "The viewer".

import { buildUi } from './ui.ts';
import { Viewer } from './viewer.ts';

const viewer = new Viewer(document.getElementById('view')!);
const ui = buildUi(viewer, document.getElementById('status')!, document.getElementById('tree')!,
  document.getElementById('details')!);
// For the browser check and the console.
Object.assign(globalThis, { viewer, ui });
