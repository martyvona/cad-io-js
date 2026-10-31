// The viewer's entry point. See README.md, "The viewer", and CLAUDE.md, "The viewer".

import { buildAutomation } from './automation.ts';
import { buildUi } from './ui.ts';
import { Viewer } from './viewer.ts';

// ?deterministic: one pixel per CSS pixel whatever the screen, so screenshots compare across machines.
const deterministic = new URLSearchParams(location.search).has('deterministic');
const viewer = new Viewer(document.getElementById('view')!, deterministic ? { pixelRatio: 1 } : {});
const ui = buildUi(viewer, document.getElementById('status')!, document.getElementById('tree')!,
  document.getElementById('details')!);
// ?controls=0: the controls hidden (cad-viewer shot, which renders the view alone: nothing then covers it, so fits
// centre in the whole view rather than beside the controls).
if (new URLSearchParams(location.search).get('controls') === '0') ui.gui.hide();
// The automation interface (automation.ts); viewer and ui for the browser check and the console.
const cadViewer = buildAutomation(viewer, ui, location);
Object.assign(globalThis, { viewer, ui, cadViewer });
