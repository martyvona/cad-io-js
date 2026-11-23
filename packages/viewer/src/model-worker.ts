// The model worker: models imported, healed, meshed and exported off the page's thread (docs/viewer.md), by
// loadModelIn (model-load.ts), its tessellation pool's workers nested in this one. Draco's decoder (for glTF) is given
// its WebAssembly by URL, as Vite bundles it. One load at a time; a newer one (or a cancel) stops the last's meshing
// (and the next load starts a new pool, as after clearing the cache from the page). Messages in: load, remesh (the
// last load's scene meshed again with other settings, from its B-rep models: Mesh again), cancel, export (the last
// load's scene, as it was meshed: export-model.ts); out: the load's (or remesh's) events and errors, each with its
// number, and each export's files or error by its number. The page holds the B-rep models between operations
// (model-load.ts's handOver): a remesh and an export bring them back, and they go back to the page, each with its
// part's mesh, or with the export's answer.

import dracoWasm from 'draco3dgltf/draco_decoder_gltf.wasm?url';
import dracoEncoderWasm from 'draco3dgltf/draco_encoder.wasm?url';
import { chooseLod, type Mesh, type Scene } from 'cad-scene';
import type { ExportRequest } from './export-formats.ts';
import { exportModel, type Exported } from './export-model.ts';
import { handOver, isLent, loadModelIn, meshable, meshBuffers, meshModelIn, needModels, takeBack, type ModelEvent,
  type ModelInput } from './model-load.ts';
import { Tessellation, wantedOf, type TessellationSettings } from './tessellation.ts';

export type ToModelWorker =
  | { type: 'load'; load: number; input?: ModelInput; settings: TessellationSettings; workers: number }
  /**
   * The last load's scene meshed again (its mesh events and end under `load`); an error if there's none. `models`: the
   * B-rep models the page holds, by part, lent back (each returned with its part's mesh).
   */
  | { type: 'remesh'; load: number; settings: TessellationSettings; workers: number;
    models: [number, ArrayBuffer][] }
  /** Answered with `cancelled` (its id): after it, no model of the cancelled run comes (handOver asks first). */
  | { type: 'cancel'; id: number }
  /**
   * The page's meshes lent, by part (Viewer.exportModel): the worker's own were handed to the page; and the B-rep
   * models it holds.
   */
  | { type: 'export'; id: number; request: ExportRequest; meshes: [number, Mesh][]; models: [number, ArrayBuffer][] };

/** Each export's answer, with the lent meshes and models handed back. */
export type FromModelWorker = ((ModelEvent | { type: 'error'; message: string }) & { load: number })
  | { type: 'exported'; id: number; result: Exported; meshes: [number, Mesh][]; models: [number, ArrayBuffer][] }
  /** The export still going (Viewer.exportModel's watchdog: none for a while, the worker's lost). */
  | { type: 'beat'; id: number }
  /** A cancel taken: every model the cancelled run handed over was sent before this. */
  | { type: 'cancelled'; id: number }
  | { type: 'export-error'; id: number; message: string; meshes: [number, Mesh][];
    models: [number, ArrayBuffer][] };

const scope = globalThis as unknown as {
  postMessage(msg: FromModelWorker, transfer?: Transferable[]): void;
  onmessage: ((e: MessageEvent<ToModelWorker>) => void) | null;
};

/** How often an export says it's still going (ms). */
export const BEAT_MS = 1000;

const tessellation = new Tessellation();
let current = 0;
/** The last load's scene, its levels filled as it's meshed, and the settings it's meshed with. */
let last: { scene: Scene; settings: TessellationSettings } | undefined;

scope.onmessage = async (e) => {
  const msg = e.data;
  if (msg.type === 'cancel') {
    current++;
    tessellation.dispose();
    scope.postMessage({ type: 'cancelled', id: msg.id });
    return;
  }
  if (msg.type === 'export') {
    // The lent meshes' buffers, to hand back whatever happens; the models taken back, and handed back after.
    const lent = [...new Set(msg.meshes.flatMap(([, m]) => meshBuffers(m)))];
    // (Those it holds: all, unless taking them back failed.)
    const giveBack = (): [number, ArrayBuffer][] => (last ? msg.models.flatMap(([part]) => isLent(last!.scene, part)
      ? [] : [[part, handOver(last!.scene, part)] as [number, ArrayBuffer]]) : []);
    // A beat each second while it goes (between the exporters' steps: their encoders' work doesn't pause).
    scope.postMessage({ type: 'beat', id: msg.id });
    const beat = setInterval(() => scope.postMessage({ type: 'beat', id: msg.id }), BEAT_MS);
    try {
      if (!last) throw new Error('no model to export');
      takeBack(last.scene, msg.models);
      needModels(last.scene, meshable(last.scene));
      // Each part's level the page shows (chooseLod, as the page chose it), with the page's mesh; parts without one
      // (failed) none.
      const wanted = wantedOf(last.settings);
      const meshes = new Map(msg.meshes);
      const scene: Scene = { ...last.scene, parts: last.scene.parts.map((p, i) => {
        const mesh = meshes.get(i);
        const lod = mesh ? chooseLod(p, wanted) : undefined;
        return { ...p, lods: mesh ? [{ ...(lod ?? { from: 'source' as const }), mesh }] : [] };
      }) };
      // (A pause lets the beat's timer run between the exporters' steps.)
      const result = await exportModel(scene, wanted, msg.request, { locateFile: () => dracoEncoderWasm },
        () => new Promise((r) => setTimeout(r, 0)));
      const buffers = [...result.chunks, ...(result.bin ? [result.bin] : [])].flatMap((c) =>
        typeof c === 'string' ? [] : [c.buffer as ArrayBuffer]);
      const models = giveBack();
      scope.postMessage({ type: 'exported', id: msg.id, result, meshes: msg.meshes, models },
        [...new Set([...buffers, ...lent, ...models.map(([, b]) => b)])]);
    } catch (err) {
      const models = giveBack();
      scope.postMessage({ type: 'export-error', id: msg.id, message: (err as Error).message ?? String(err),
        meshes: msg.meshes, models }, [...lent, ...models.map(([, b]) => b)]);
    } finally {
      clearInterval(beat);
    }
    return;
  }
  const load = msg.load;
  current = load;
  if (msg.type === 'remesh') {
    try {
      if (!last) throw new Error('no model to mesh again');
      // (Whatever follows: a later cancel leaves them here, and the next remesh finds them.)
      takeBack(last.scene, msg.models);
      // (The settings it's now meshed with, for exports.)
      last.settings = msg.settings;
      await meshModelIn(last.scene, msg.settings, msg.workers, tessellation, (ev, transfer) => {
        if (load === current) scope.postMessage({ ...ev, load }, transfer ?? []);
      }, () => load !== current);
    } catch (err) {
      if (load === current) scope.postMessage({ type: 'error', message: (err as Error).message ?? String(err), load });
    }
    return;
  }
  last = undefined;
  try {
    // (The message as the source: its input taken by the import, so the file goes once imported.)
    await loadModelIn(msg, msg.settings, msg.workers, tessellation, (ev, transfer) => {
      if (load === current) scope.postMessage({ ...ev, load }, transfer ?? []);
    }, () => load !== current, { draco: { locateFile: () => dracoWasm } }, (scene) => {
      if (load === current) last = { scene, settings: msg.settings };
    });
  } catch (err) {
    if (load === current) scope.postMessage({ type: 'error', message: (err as Error).message ?? String(err), load });
  }
};
