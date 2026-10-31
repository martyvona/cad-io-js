// The export formats and options the viewer offers (the user, 2026-10-31: File's Export...), as stepconv's
// (packages/cli, its FORMATS): no exporter imported here, so the page can use it (the exporters run in the import
// worker: export-model.ts).

import type { InstanceOverride, Material } from 'cad-scene';

/** glTF's geometry compression (export-gltf's Compression). */
export type Compression = 'draco' | 'meshopt' | 'none';

export type ExportFormat = 'glb' | 'gltf' | 'threejs' | '3mf';

/** What the export dialog asks for (export-dialog.ts), as stepconv's options. */
export interface ExportRequest {
  format: ExportFormat;
  /** The scene's and root node's name. */
  name: string;
  /** B-rep edges, and curves and points (not 3MF). */
  edges: boolean;
  curves: boolean;
  doubleSided: boolean;
  unlitLines: boolean;
  /** Hidden instances written hidden (glTF's KHR_node_visibility, three.js's visible, 3MF's kept), else left out. */
  keepHidden: boolean;
  extras: boolean;
  keepEmpty: boolean;
  compression: Compression;
  dracoBits: number;
  instancing: boolean;
  /** .gltf: the buffer in the JSON (a data URI), else a .bin beside it named `bin`. */
  embed: boolean;
  bin?: string;
  colorgroup: boolean;
  assembly: boolean;
  surfaces: boolean;
  /** The viewer's hiding and opacity (export-shown.ts): materials added, and the overrides in place of the scene's. */
  shown?: { materials: Material[]; overrides: InstanceOverride[] };
}

/** Each format's file extension, MIME type and words, and which options it takes. */
export const EXPORT_FORMATS: Record<ExportFormat, { ext: string; mime: string; label: string; lines: boolean;
  gltf: boolean; threemf: boolean }> = {
  glb: { ext: '.glb', mime: 'model/gltf-binary', label: 'glTF 2.0, binary (GLB)', lines: true, gltf: true,
    threemf: false },
  gltf: { ext: '.gltf', mime: 'model/gltf+json', label: 'glTF 2.0, JSON (.gltf)', lines: true, gltf: true,
    threemf: false },
  threejs: { ext: '.json', mime: 'application/json', label: 'three.js JSON', lines: true, gltf: false,
    threemf: false },
  '3mf': { ext: '.3mf', mime: 'model/3mf', label: '3MF', lines: false, gltf: false, threemf: true },
};

/** stepconv's defaults (its options all off; Draco at 14 bits; .gltf embedded here, as the dialog offers). */
export const DEFAULT_EXPORT: Omit<ExportRequest, 'name'> = {
  format: 'glb', edges: false, curves: false, doubleSided: false, unlitLines: false, keepHidden: false,
  extras: false, keepEmpty: false, compression: 'draco', dracoBits: 14, instancing: false, embed: true,
  colorgroup: false, assembly: false, surfaces: false,
};
