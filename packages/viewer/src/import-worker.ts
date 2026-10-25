// The import worker: STEP files parsed and meshed off the page's thread (the user, 2026-10-24; CLAUDE.md, "The
// viewer"), by loadStepIn (step-load.ts), its tessellation pool's workers nested in this one. One load at a time;
// a newer one (or a cancel) stops the last's meshing (and the next load starts a new pool, as after clearing the
// cache from the page). Messages in: load, cancel; out: the load's events and errors, each with the load's number.

import { loadStepIn, type StepEvent } from './step-load.ts';
import { Tessellation, type TessellationSettings } from './tessellation.ts';

export type ToImportWorker =
  | { type: 'load'; load: number; bytes: Uint8Array; settings: TessellationSettings; workers: number }
  | { type: 'cancel' };

export type FromImportWorker = (StepEvent | { type: 'error'; message: string }) & { load: number };

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
    await loadStepIn(msg.bytes, msg.settings, msg.workers, tessellation, (ev, transfer) => {
      if (load === current) scope.postMessage({ ...ev, load }, transfer ?? []);
    }, () => load !== current);
  } catch (err) {
    if (load === current) scope.postMessage({ type: 'error', message: (err as Error).message ?? String(err), load });
  }
};
