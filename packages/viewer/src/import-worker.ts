// The import worker: models imported and meshed off the page's thread (the user, 2026-10-24; CLAUDE.md, "The
// viewer"), by loadModelIn (model-load.ts), its tessellation pool's workers nested in this one. Draco's decoder (for
// glTF) is given its WebAssembly by URL, as Vite bundles it. One load at a time;
// a newer one (or a cancel) stops the last's meshing (and the next load starts a new pool, as after clearing the
// cache from the page). Messages in: load, cancel, export (the last load's scene, as it was meshed: export-model.ts);
// out: the load's events and errors, each with the load's number, and each export's files or error by its number.

import dracoWasm from 'draco3dgltf/draco_decoder_gltf.wasm?url';
import dracoEncoderWasm from 'draco3dgltf/draco_encoder.wasm?url';
import { chooseLod, meshDeflections, type Mesh, type Scene } from 'cad-scene';
import type { ExportRequest } from './export-formats.ts';
import { exportModel, type Exported } from './export-model.ts';
import { loadModelIn, meshBuffers, type ModelEvent, type ModelInput } from './model-load.ts';
import { deflectionsOf, Tessellation, type TessellationSettings } from './tessellation.ts';

export type ToImportWorker =
  | { type: 'load'; load: number; input: ModelInput; settings: TessellationSettings; workers: number }
  | { type: 'cancel' }
  /** The page's meshes lent, by part (Viewer.exportModel): the worker's own were handed to the page. */
  | { type: 'export'; id: number; request: ExportRequest; meshes: [number, Mesh][] };

/** Each export's answer, with the lent meshes handed back. */
export type FromImportWorker = ((ModelEvent | { type: 'error'; message: string }) & { load: number })
  | { type: 'exported'; id: number; result: Exported; meshes: [number, Mesh][] }
  | { type: 'export-error'; id: number; message: string; meshes: [number, Mesh][] };

const scope = globalThis as unknown as {
  postMessage(msg: FromImportWorker, transfer?: Transferable[]): void;
  onmessage: ((e: MessageEvent<ToImportWorker>) => void) | null;
};

const tessellation = new Tessellation();
let current = 0;
/** The last load's scene, its levels filled as it's meshed, and the settings it's meshed with. */
let last: { scene: Scene; settings: TessellationSettings } | undefined;

scope.onmessage = async (e) => {
  const msg = e.data;
  if (msg.type === 'cancel') {
    current++;
    tessellation.dispose();
    return;
  }
  if (msg.type === 'export') {
    // The lent meshes' buffers, to hand back whatever happens.
    const lent = [...new Set(msg.meshes.flatMap(([, m]) => meshBuffers(m)))];
    try {
      if (!last) throw new Error('no model to export');
      // Each part's level the page shows (chooseLod, as the page chose it), with the page's mesh; parts without one
      // (failed) none.
      const wanted = meshDeflections(deflectionsOf(last.settings));
      const meshes = new Map(msg.meshes);
      const scene: Scene = { ...last.scene, parts: last.scene.parts.map((p, i) => {
        const mesh = meshes.get(i);
        const lod = mesh ? chooseLod(p, wanted) : undefined;
        return { ...p, lods: mesh ? [{ ...(lod ?? { from: 'source' as const }), mesh }] : [] };
      }) };
      const result = await exportModel(scene, wanted, msg.request, { locateFile: () => dracoEncoderWasm });
      const buffers = [...result.chunks, ...(result.bin ? [result.bin] : [])].flatMap((c) =>
        typeof c === 'string' ? [] : [c.buffer as ArrayBuffer]);
      scope.postMessage({ type: 'exported', id: msg.id, result, meshes: msg.meshes },
        [...new Set([...buffers, ...lent])]);
    } catch (err) {
      scope.postMessage({ type: 'export-error', id: msg.id, message: (err as Error).message ?? String(err),
        meshes: msg.meshes }, lent);
    }
    return;
  }
  const load = msg.load;
  current = load;
  last = undefined;
  try {
    await loadModelIn(msg.input, msg.settings, msg.workers, tessellation, (ev, transfer) => {
      if (load === current) scope.postMessage({ ...ev, load }, transfer ?? []);
    }, () => load !== current, { draco: { locateFile: () => dracoWasm } }, (scene) => {
      if (load === current) last = { scene, settings: msg.settings };
    });
  } catch (err) {
    if (load === current) scope.postMessage({ type: 'error', message: (err as Error).message ?? String(err), load });
  }
};
