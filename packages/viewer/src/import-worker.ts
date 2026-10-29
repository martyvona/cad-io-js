// The import worker: models imported and meshed off the page's thread (the user, 2026-10-24; CLAUDE.md, "The
// viewer"), by loadModelIn (model-load.ts), its tessellation pool's workers nested in this one. Draco's decoder (for
// glTF) is given its WebAssembly by URL, as Vite bundles it. One load at a time;
// a newer one (or a cancel) stops the last's meshing (and the next load starts a new pool, as after clearing the
// cache from the page). Messages in: load, cancel; out: the load's events and errors, each with the load's number.

import dracoWasm from 'draco3dgltf/draco_decoder_gltf.wasm?url';
import { loadModelIn, type ModelEvent, type ModelInput } from './model-load.ts';
import { Tessellation, type TessellationSettings } from './tessellation.ts';

export type ToImportWorker =
  | { type: 'load'; load: number; input: ModelInput; settings: TessellationSettings; workers: number }
  | { type: 'cancel' };

export type FromImportWorker = (ModelEvent | { type: 'error'; message: string }) & { load: number };

const scope = globalThis as unknown as {
  postMessage(msg: FromImportWorker, transfer?: Transferable[]): void;
  onmessage: ((e: MessageEvent<ToImportWorker>) => void) | null;
};

const tessellation = new Tessellation();
let current = 0;

scope.onmessage = async (e) => {
  const msg = e.data;
  if (msg.type === 'cancel') {
    current++;
    tessellation.dispose();
    return;
  }
  const load = msg.load;
  current = load;
  try {
    await loadModelIn(msg.input, msg.settings, msg.workers, tessellation, (ev, transfer) => {
      if (load === current) scope.postMessage({ ...ev, load }, transfer ?? []);
    }, () => load !== current, { draco: { locateFile: () => dracoWasm } });
  } catch (err) {
    if (load === current) scope.postMessage({ type: 'error', message: (err as Error).message ?? String(err), load });
  }
};
