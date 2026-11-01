// Exporting the model (the user, 2026-10-31: File's Export...), in the import worker, which holds the scene as it was
// imported and meshed (model-load.ts): its export view at the deflections it was meshed with, through the library's
// exporters, as stepconv writes them (packages/cli, its FORMATS), the same options and defaults. With `shown`, the
// viewer's hiding and opacity applied first (export-shown.ts, on the page). The files come back as their pieces, for
// the page to save (a Blob of them).

import { drain, exportView, paced, type Deflections, type Diagnostic, type Scene } from 'cad-scene';
import { threemf, threemfAsync } from 'export-3mf';
import { glb, gltfJson } from 'export-gltf';
import { threejsChunks } from 'export-threejs';
import { EXPORT_FORMATS, type ExportRequest } from './export-formats.ts';

export interface Exported {
  /** The file's pieces; a .gltf not embedded has its buffer in `bin`. */
  chunks: (string | Uint8Array)[];
  bin?: Uint8Array;
  diagnostics: Diagnostic[];
}

/**
 * A scene written as asked (`draco`: the Draco encoder's module settings, as a bundled worker needs); with `pause`,
 * awaited now and then as it's made (the import worker's heartbeat goes out then: Viewer.exportModel), the exporters'
 * own work between pauses a part or a piece of the file at a time (Draco's and meshopt's encoding not paused).
 */
export async function exportModel(scene: Scene, deflections: Deflections, r: ExportRequest,
  draco: Record<string, unknown> = {}, pause?: () => Promise<void>): Promise<Exported> {
  const s: Scene = r.shown ? { ...scene, materials: [...scene.materials, ...r.shown.materials],
    overrides: r.shown.overrides } : scene;
  const lines = EXPORT_FORMATS[r.format].lines;
  const view = exportView(s, { ...deflections, edges: lines && r.edges, curves: lines && r.curves });
  const gltf = { name: r.name, doubleSided: r.doubleSided, hidden: r.keepHidden ? 'extension' as const
    : 'omit' as const, unlitLines: r.unlitLines, extras: r.extras, compression: r.compression,
  dracoPositionBits: r.dracoBits, instancing: r.instancing, keepEmpty: r.keepEmpty, draco,
  ...(pause ? { pause } : {}) };
  switch (r.format) {
    case 'glb': {
      const o = await glb(s, view, gltf);
      return { chunks: [o.bytes], diagnostics: o.diagnostics };
    }
    case 'gltf': {
      const o = await gltfJson(s, view, r.embed ? undefined : r.bin ?? `${r.name}.bin`, gltf);
      return { chunks: [o.json], ...(r.embed ? {} : { bin: o.bin }), diagnostics: o.diagnostics };
    }
    case 'threejs': {
      // (Its pieces as they're made, a step each.)
      const steps = collect(threejsChunks(s, view, { name: r.name, doubleSided: r.doubleSided, extras: r.extras,
        keepEmpty: r.keepEmpty }));
      return { chunks: pause ? await paced(steps, pause) : drain(steps), diagnostics: [] };
    }
    case '3mf': {
      const opts = { name: r.name, colors: r.colorgroup ? 'colorgroup' as const : 'basematerials' as const,
        build: r.assembly ? 'assembly' as const : 'parts' as const, nonManifold: r.surfaces ? 'surface' as const
          : 'omit' as const, hidden: r.keepHidden ? 'keep' as const : 'omit' as const, extras: r.extras };
      const o = pause ? await threemfAsync(s, view, pause, opts) : threemf(s, view, opts);
      return { chunks: [...o.chunks], diagnostics: o.diagnostics };
    }
  }
}

/** A generator's items gathered, a step each (for `paced`). */
function* collect<T>(items: Iterable<T>): Generator<void, T[]> {
  const out: T[] = [];
  for (const x of items) {
    out.push(x);
    yield;
  }
  return out;
}
