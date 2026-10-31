// Exporting the model (the user, 2026-10-31: File's Export...), in the import worker, which holds the scene as it was
// imported and meshed (model-load.ts): its export view at the deflections it was meshed with, through the library's
// exporters, as stepconv writes them (packages/cli, its FORMATS), the same options and defaults. With `shown`, the
// viewer's hiding and opacity applied first (export-shown.ts, on the page). The files come back as their pieces, for
// the page to save (a Blob of them).

import { exportView, type Deflections, type Diagnostic, type Scene } from 'cad-scene';
import { threemf } from 'export-3mf';
import { glb, gltfJson } from 'export-gltf';
import { threejsChunks } from 'export-threejs';
import { EXPORT_FORMATS, type ExportRequest } from './export-formats.ts';

export interface Exported {
  /** The file's pieces; a .gltf not embedded has its buffer in `bin`. */
  chunks: (string | Uint8Array)[];
  bin?: Uint8Array;
  diagnostics: Diagnostic[];
}

/** A scene written as asked (`draco`: the Draco encoder's module settings, as a bundled worker needs). */
export async function exportModel(scene: Scene, deflections: Deflections, r: ExportRequest,
  draco: Record<string, unknown> = {}): Promise<Exported> {
  const s: Scene = r.shown ? { ...scene, materials: [...scene.materials, ...r.shown.materials],
    overrides: r.shown.overrides } : scene;
  const lines = EXPORT_FORMATS[r.format].lines;
  const view = exportView(s, { ...deflections, edges: lines && r.edges, curves: lines && r.curves });
  const gltf = { name: r.name, doubleSided: r.doubleSided, hidden: r.keepHidden ? 'extension' as const
    : 'omit' as const, unlitLines: r.unlitLines, extras: r.extras, compression: r.compression,
  dracoPositionBits: r.dracoBits, instancing: r.instancing, keepEmpty: r.keepEmpty, draco };
  switch (r.format) {
    case 'glb': {
      const o = await glb(s, view, gltf);
      return { chunks: [o.bytes], diagnostics: o.diagnostics };
    }
    case 'gltf': {
      const o = await gltfJson(s, view, r.embed ? undefined : r.bin ?? `${r.name}.bin`, gltf);
      return { chunks: [o.json], ...(r.embed ? {} : { bin: o.bin }), diagnostics: o.diagnostics };
    }
    case 'threejs':
      return { chunks: [...threejsChunks(s, view, { name: r.name, doubleSided: r.doubleSided, extras: r.extras,
        keepEmpty: r.keepEmpty })], diagnostics: [] };
    case '3mf': {
      const o = threemf(s, view, { name: r.name, colors: r.colorgroup ? 'colorgroup' : 'basematerials',
        build: r.assembly ? 'assembly' : 'parts', nonManifold: r.surfaces ? 'surface' : 'omit',
        hidden: r.keepHidden ? 'keep' : 'omit', extras: r.extras });
      return { chunks: [...o.chunks], diagnostics: o.diagnostics };
    }
  }
}
