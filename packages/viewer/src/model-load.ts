// Loading a model as a stream of events (the user, 2026-10-24; CLAUDE.md, "The viewer"), in the import worker
// (import-worker.ts, so the page never waits on parsing; always there since 2026-10-25, the user). Every format goes
// through the library's importers into the scene model (the user, 2026-10-29: one path; three.js's loaders dropped):
// STEP (step-import), glTF and GLB (gltf-import), three.js JSON (threejs-import).
// The scene comes first, without its parts' payloads (functions over the parsed file, which can't cross to another
// thread, and which only meshing needs), its mesh parts' levels with it; then each placed brep part's mesh as
// tessellation delivers it (the buffers transferable); then the end, with the tessellation's diagnostics and what
// meshed it.

import { partInstances, tessellateScene, type Diagnostic, type Mesh, type Scene } from 'cad-scene';
import { importGltf, type GltfImportOptions } from 'gltf-import';
import { importStep } from 'step-import';
import { importThreejs } from 'threejs-import';
import type { Format } from './formats.ts';
import type { CacheStats } from 'tess-cache/browser';
import { deflectionsOf, type Tessellation, type TessellationSettings } from './tessellation.ts';

/**
 * What meshed a model: the backend's name and version, the workers, the cache's counts (if it was on), and how many
 * pools its tessellation has made (a cancel makes the next load start a new one).
 */
export interface Meshing { backend: string; workers: number; cache?: CacheStats; pools?: number }

/** A model's file: its format, its bytes, and the files a .gltf names (its .bin), by the names it uses. */
export interface ModelInput {
  format: Format;
  bytes: Uint8Array;
  resources?: Record<string, Uint8Array>;
}

/** The scene a file holds, by its format's importer (problems in it are the scene's diagnostics). */
export async function importModel(input: ModelInput, gltf: GltfImportOptions = {}): Promise<Scene> {
  switch (input.format) {
    case 'step': return (await importStep(input.bytes)).scene;
    case 'glb': return (await importGltf(input.bytes, gltf)).scene;
    case 'gltf': return (await importGltf({ json: new TextDecoder().decode(input.bytes),
      ...(input.resources ? { resources: input.resources } : {}) }, gltf)).scene;
    case 'threejs': return importThreejs(input.bytes).scene;
  }
}

export type ModelEvent =
  | { type: 'scene'; scene: Scene }
  | { type: 'mesh'; part: number; mesh: Mesh | undefined }
  | { type: 'done'; diagnostics: Diagnostic[]; meshing?: Meshing };

/** The scene without its parts' payload functions: what can be posted to another thread. */
export function postable(scene: Scene): Scene {
  return { ...scene, parts: scene.parts.map((p) => (p.brep ? { ...p, brep: { format: p.brep.format,
    ...(p.brep.rootId === undefined ? {} : { rootId: p.brep.rootId }), payload: undefined as never } } : p)) };
}

/** The brep parts to mesh: those placed somewhere in the tree (others would never be drawn). */
export function meshable(scene: Scene): number[] {
  const placed = new Set<number>();
  for (const pi of partInstances(scene)) placed.add(pi.part);
  return scene.parts.flatMap((p, i) => (p.brep && placed.has(i) ? [i] : []));
}

/** The buffers of the scene's levels' meshes (its mesh parts': ours come later), once each, to transfer. */
export function levelBuffers(scene: Scene): ArrayBuffer[] {
  return [...new Set(scene.parts.flatMap((p) => p.brep ? [] : p.lods.flatMap((l) => meshBuffers(l.mesh))))];
}

/** The buffers of a mesh's arrays, once each, to transfer rather than copy. */
export function meshBuffers(mesh: Mesh | undefined): ArrayBuffer[] {
  if (!mesh) return [];
  const out = new Set<ArrayBuffer>();
  for (const a of [mesh.positions, mesh.normals, mesh.indices, mesh.edgePositions, mesh.curvePositions, mesh.points,
    mesh.faceOutlinePositions]) {
    if (a && a.buffer instanceof ArrayBuffer) out.add(a.buffer);
  }
  return [...out];
}

/**
 * Imports a model and meshes its placed brep parts, telling `emit` as it goes; stops early, quietly, once
 * `cancelled` says so (the caller stops the tessellation too).
 */
export async function loadModelIn(input: ModelInput, settings: TessellationSettings, workers: number,
  tessellation: Pick<Tessellation, 'get' | 'describe'>, emit: (e: ModelEvent, transfer?: ArrayBuffer[]) => void,
  cancelled: () => boolean, gltf: GltfImportOptions = {}): Promise<void> {
  const scene = await importModel(input, gltf);
  if (cancelled()) return;
  // (Mesh parts' arrays transferred: only brep parts are used here from now on.)
  emit({ type: 'scene', scene: postable(scene) }, levelBuffers(scene));
  const brep = meshable(scene);
  if (!brep.length) return emit({ type: 'done', diagnostics: [] });
  const { tess, workers: n } = await tessellation.get(settings, workers);
  if (cancelled()) return;
  // Faces that fail to mesh, and parts that do (errors, timeouts), outlined from the file (cad-scene's `outlines`).
  const { diagnostics } = await tessellateScene(scene, tess, { ...deflectionsOf(settings), edges: true, outlines: true,
    concurrency: n, parts: brep,
    onPart: (part, mesh) => { if (!cancelled()) emit({ type: 'mesh', part, mesh }, meshBuffers(mesh)); } });
  if (cancelled()) return;
  const d = tessellation.describe();
  emit({ type: 'done', diagnostics, ...(d ? { meshing: { ...d, workers: n } } : {}) });
}
