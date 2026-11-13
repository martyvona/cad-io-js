// Loading a model as a stream of events (docs/viewer.md), in the import worker (import-worker.ts, so the page
// never waits on parsing). Every format goes through the library's importers into the scene model (one path; three.js's
// loaders dropped): STEP (step-import), glTF and GLB (gltf-import), three.js JSON (threejs-import), 3MF (3mf-import).
// The scene comes first, without its parts' B-rep models and outlines (an outline is a function, which can't cross
// to another thread; only meshing, here, needs either), its mesh parts' levels with it; then each placed brep part's
// mesh as tessellation delivers it (the buffers transferable); then the end, with the tessellation's diagnostics and
// what meshed it.

import { chooseLod, meshDeflections, partInstances, tessellateScene, type Diagnostic, type LodWanted, type Measures,
  type Mesh, type Scene, type SceneBounds } from 'cad-scene';
import { import3mf } from '3mf-import';
import { importGltf, type GltfImportOptions } from 'gltf-import';
import { importStep, type ImportOptions, type ImportProgress } from 'step-import';
import { importThreejs } from 'threejs-import';
import type { Format } from './formats.ts';
import { EDGE_ANGLE, EDGE_GRID_MM, findEdges } from './edges.ts';
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

/**
 * The scene a file holds, by its format's importer (problems in it are the scene's diagnostics); `step` the STEP
 * importer's options (its progress).
 */
export async function importModel(input: ModelInput, gltf: GltfImportOptions = {},
  step: Pick<ImportOptions, 'onProgress'> = {}): Promise<Scene> {
  switch (input.format) {
    case 'step': return (await importStep(input.bytes, step)).scene;
    case 'glb': return (await importGltf(input.bytes, gltf)).scene;
    case 'gltf': return (await importGltf({ json: new TextDecoder().decode(input.bytes),
      ...(input.resources ? { resources: input.resources } : {}) }, gltf)).scene;
    case 'threejs': return importThreejs(input.bytes).scene;
    case '3mf': return import3mf(input.bytes).scene;
  }
}

/** A load's file, taken out (`input` cleared) as the import begins: only the import needs it. */
export interface ModelSource { input?: ModelInput }

/**
 * importModel on a source's input, taken out of the source. In a function of its own, which returns at once: a
 * suspended async frame (loadModelIn's, the worker's handler's) keeps its locals, even dead ones, so one that had seen
 * the bytes would keep them through the meshing that follows.
 */
function importTaken(source: ModelSource, gltf: GltfImportOptions, step: Pick<ImportOptions, 'onProgress'>):
  Promise<Scene> {
  const input = source.input;
  if (!input) throw new Error('loadModelIn: the source has no input (already taken)');
  source.input = undefined;
  return importModel(input, gltf, step);
}

export type ModelEvent =
  /** What the import is doing, before the scene (STEP's phases, step-import's ImportProgress). */
  | { type: 'importing'; progress: ImportProgress }
  /** The scene, and how many of its parts' edges are to be found (edges events follow, one each). */
  | { type: 'scene'; scene: Scene; edgeParts: number }
  /**
   * A part meshed, with its measures (Part.measures) where the backend gave them: the page's scene lacks them; and
   * edges found from its triangles where the backend gave none (edges.ts).
   */
  | { type: 'mesh'; part: number; mesh: Mesh | undefined; measures?: Measures; foundEdges?: Float32Array }
  /** Edges found from a part's level from the file, which has none of its own (edges.ts): segments. */
  | { type: 'edges'; part: number; positions: Float32Array }
  /** The end; `bounds` the model's sphere made again from the meshes (tessellateScene), where it changed. */
  | { type: 'done'; diagnostics: Diagnostic[]; meshing?: Meshing; bounds?: SceneBounds };

/** How often the import's progress is told, in milliseconds, within a phase. */
export const PROGRESS_MS = 200;

/**
 * The scene without its parts' B-rep models and outline functions (the import worker meshes; the page needs neither):
 * what can be posted to another thread.
 */
export function postable(scene: Scene): Scene {
  return { ...scene, parts: scene.parts.map((p) => (p.brep ? { ...p, brep: { format: p.brep.format,
    model: undefined as never } } : p)) };
}

/** A mesh with triangles and no edges of its own (as the scene graph draws them): its edges are to be found. */
export const needsEdges = (mesh: Mesh) => mesh.indices.length > 0 && !mesh.edges?.length;

/** A mesh's edges found on a grid of EDGE_GRID_MM (meshes and placements are millimetres, placements rigid). */
export const edgesOf = (mesh: Mesh) => findEdges(mesh.positions, mesh.indices, EDGE_ANGLE, 1 / EDGE_GRID_MM);

/** The parts placed somewhere in the tree. */
function placedParts(scene: Scene): Set<number> {
  const placed = new Set<number>();
  for (const pi of partInstances(scene)) placed.add(pi.part);
  return placed;
}

/** The file levels to find edges on: each placed part's level shown (`wanted`) without a B-rep or edges of its own. */
export function edgeJobs(scene: Scene, wanted: LodWanted): { part: number; mesh: Mesh }[] {
  const placed = placedParts(scene);
  return scene.parts.flatMap((p, part) => {
    const mesh = p.brep ? undefined : chooseLod(p, wanted)?.mesh;
    return mesh && needsEdges(mesh) && placed.has(part) ? [{ part, mesh }] : [];
  });
}

/** The brep parts to mesh: those placed somewhere in the tree (others would never be drawn). */
export function meshable(scene: Scene): number[] {
  const placed = placedParts(scene);
  return scene.parts.flatMap((p, i) => (p.brep && placed.has(i) ? [i] : []));
}

/**
 * The buffers of the scene's levels' meshes (the file's own: ours come later, and replace them where a part has a
 * B-rep too), once each, to transfer.
 */
export function levelBuffers(scene: Scene): ArrayBuffer[] {
  return [...new Set(scene.parts.flatMap((p) => p.lods.flatMap((l) => meshBuffers(l.mesh))))];
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
 * Imports a model (taking `source`'s input) and meshes its placed brep parts, telling `emit` as it goes; stops early,
 * quietly, once `cancelled` says so (the caller stops the tessellation too). `keep` is given the scene as soon as it's
 * imported.
 */
export async function loadModelIn(source: ModelSource, settings: TessellationSettings, workers: number,
  tessellation: Pick<Tessellation, 'get' | 'describe'>, emit: (e: ModelEvent, transfer?: ArrayBuffer[]) => void,
  cancelled: () => boolean, gltf: GltfImportOptions = {}, keep?: (scene: Scene) => void): Promise<void> {
  // The import's phases as they begin, and its progress through them at most every PROGRESS_MS.
  let told = -Infinity, phase = '';
  const onProgress = (progress: ImportProgress) => {
    const now = performance.now();
    if (cancelled() || progress.phase === phase && now - told < PROGRESS_MS) return;
    [told, phase] = [now, progress.phase];
    emit({ type: 'importing', progress });
  };
  const scene = await importTaken(source, gltf, { onProgress });
  if (cancelled()) return;
  // (Kept by the caller, to export later: the meshes go into its parts' levels as they're made.)
  keep?.(scene);
  // The levels shown that have no edges of their own get edges found from their triangles, part by part, after the
  // scene goes (edges.ts: off the page's thread, and not holding up meshing); those levels' buffers are copied to the
  // page rather than transferred, as they're needed here meanwhile.
  const jobs = edgeJobs(scene, meshDeflections(deflectionsOf(settings)));
  const kept = new Set(jobs.flatMap((j) => meshBuffers(j.mesh)));
  // (The file's other levels transferred: only B-rep models are used here from now on.)
  emit({ type: 'scene', scene: postable(scene), edgeParts: jobs.length },
    levelBuffers(scene).filter((b) => !kept.has(b)));
  const edges = (async () => {
    for (const { part, mesh } of jobs) {
      await new Promise((r) => setTimeout(r, 0));
      if (cancelled()) return;
      const positions = edgesOf(mesh);
      emit({ type: 'edges', part, positions }, [positions.buffer as ArrayBuffer]);
    }
  })();
  await meshModelIn(scene, settings, workers, tessellation, emit, cancelled, edges);
}

/**
 * Meshes a scene's placed brep parts (a load's, or the last load's again: Mesh again), telling `emit` each part's mesh
 * as it comes, then the end; stops early, quietly, once `cancelled` says so. `before` is waited for before the end
 * (the load's edges found for its file levels).
 */
export async function meshModelIn(scene: Scene, settings: TessellationSettings, workers: number,
  tessellation: Pick<Tessellation, 'get' | 'describe'>, emit: (e: ModelEvent, transfer?: ArrayBuffer[]) => void,
  cancelled: () => boolean, before: Promise<unknown> = Promise.resolve()): Promise<void> {
  const brep = meshable(scene);
  if (!brep.length) {
    await before;
    if (!cancelled()) emit({ type: 'done', diagnostics: [] });
    return;
  }
  const { tess, workers: n } = await tessellation.get(settings, workers);
  if (cancelled()) return;
  // Faces that fail to mesh, and parts that do (errors, timeouts), outlined from the file (cad-scene's `outlines`).
  const { diagnostics } = await tessellateScene(scene, tess, { ...deflectionsOf(settings), edges: true, outlines: true,
    concurrency: n, parts: brep,
    onPart: (part, mesh) => {
      if (cancelled()) return;
      const measures = scene.parts[part]!.measures;
      // (A backend that gives no edges, truck: found here, with the mesh.)
      const found = mesh && needsEdges(mesh) ? edgesOf(mesh) : undefined;
      emit({ type: 'mesh', part, mesh, ...(measures ? { measures } : {}), ...(found ? { foundEdges: found } : {}) },
        [...meshBuffers(mesh), ...(found ? [found.buffer as ArrayBuffer] : [])]);
    } });
  await before;
  if (cancelled()) return;
  const d = tessellation.describe();
  emit({ type: 'done', diagnostics, ...(d ? { meshing: { ...d, workers: n } } : {}),
    ...(scene.bounds ? { bounds: scene.bounds } : {}) });
}
