// Loading a STEP file as a stream of events (the user, 2026-10-24; CLAUDE.md, "The viewer"), in the import worker
// (import-worker.ts, so the page never waits on parsing; always there since 2026-10-25, the user).
// The scene comes first, without its parts' payloads (functions over the parsed file, which can't cross to another
// thread, and which only meshing needs); then each placed brep part's mesh as tessellation delivers it (the buffers
// transferable); then the end, with the tessellation's diagnostics and what meshed it.

import { partInstances, tessellateScene, type Diagnostic, type Mesh, type Scene } from 'cad-scene';
import { importStep } from 'step-import';
import type { CacheStats } from 'tess-cache/browser';
import type { Tessellation, TessellationSettings } from './tessellation.ts';

/**
 * What meshed a model: the backend's name and version, the workers, the cache's counts (if it was on), and how many
 * pools its tessellation has made (a cancel makes the next load start a new one).
 */
export interface Meshing { backend: string; workers: number; cache?: CacheStats; pools?: number }

export type StepEvent =
  | { type: 'scene'; scene: Scene }
  | { type: 'mesh'; part: number; mesh: Mesh | undefined }
  | { type: 'done'; diagnostics: Diagnostic[]; meshing?: Meshing };

/** The scene without its parts' payload functions: what can be posted to another thread. */
export function postable(scene: Scene): Scene {
  return { ...scene, parts: scene.parts.map((p) => (p.kind === 'brep' ? { ...p, payload: undefined as never } : p)) };
}

/** The brep parts to mesh: those placed somewhere in the tree (others would never be drawn). */
export function meshable(scene: Scene): number[] {
  const placed = new Set<number>();
  for (const pi of partInstances(scene)) placed.add(pi.part);
  return scene.parts.flatMap((p, i) => (p.kind === 'brep' && placed.has(i) ? [i] : []));
}

/** The buffers of a mesh's arrays, once each, to transfer rather than copy. */
export function meshBuffers(mesh: Mesh | undefined): ArrayBuffer[] {
  if (!mesh) return [];
  const out = new Set<ArrayBuffer>();
  for (const a of [mesh.positions, mesh.normals, mesh.indices, mesh.edgePositions, mesh.curvePositions, mesh.points]) {
    if (a && a.buffer instanceof ArrayBuffer) out.add(a.buffer);
  }
  return [...out];
}

/**
 * Imports a STEP file and meshes its placed brep parts, telling `emit` as it goes; stops early, quietly, once
 * `cancelled` says so (the caller stops the tessellation too).
 */
export async function loadStepIn(bytes: Uint8Array, settings: TessellationSettings, workers: number,
  tessellation: Pick<Tessellation, 'get' | 'describe'>, emit: (e: StepEvent, transfer?: ArrayBuffer[]) => void,
  cancelled: () => boolean): Promise<void> {
  const { scene } = await importStep(bytes);
  if (cancelled()) return;
  emit({ type: 'scene', scene: postable(scene) });
  const brep = meshable(scene);
  if (!brep.length) return emit({ type: 'done', diagnostics: [] });
  const { tess, workers: n } = await tessellation.get(settings, workers);
  if (cancelled()) return;
  const { diagnostics } = await tessellateScene(scene, tess, { linearDeflection: settings.linearDeflection,
    angularDeflection: settings.angularDeflection * Math.PI / 180, edges: true, concurrency: n, parts: brep,
    onPart: (part, mesh) => { if (!cancelled()) emit({ type: 'mesh', part, mesh }, meshBuffers(mesh)); } });
  if (cancelled()) return;
  const d = tessellation.describe();
  emit({ type: 'done', diagnostics, ...(d ? { meshing: { ...d, workers: n } } : {}) });
}
