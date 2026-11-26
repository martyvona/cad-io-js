// Loading a model as a stream of events (docs/viewer.md), in the model worker (model-worker.ts, so the page
// never waits on parsing). Every format goes through the library's importers into the scene model (one path; three.js's
// loaders dropped): STEP (step-import), glTF and GLB (gltf-import), three.js JSON (threejs-import), 3MF (3mf-import).
// The scene comes first, without its parts' B-rep models and outlines (an outline is a function, which can't cross
// to another thread), its mesh parts' levels with it; then, with Heal B-reps, the models healed (cad-heal) in the
// tessellation pool's workers, several at once, its progress as the import's healing phase; then each placed brep
// part's mesh as tessellation delivers it, with its B-rep model and analysis handed over to the page (the buffers
// transferred: handOver below); then the end, with healing's and the tessellation's diagnostics and what meshed it.

import { faceOutlines, openAnalysis, openBrep } from 'cad-brep';
import { chooseLod, partInstances, tessellateScene, type Diagnostic, type LodWanted,
  type Measures, type Mesh, type Scene, type SceneBounds } from 'cad-scene';
import { healScene, poolHealer } from 'cad-heal';
import type { PoolTessellator } from 'tess-workers/browser';
import { import3mf } from '3mf-import';
import { importGltf, type GltfImportOptions } from 'gltf-import';
import { importStep, type ImportOptions, type ImportProgress } from 'step-import';
import { importThreejs } from 'threejs-import';
import type { Format } from './formats.ts';
import { partModelBuffers, type PartModel } from './part-model.ts';
import { EDGE_ANGLE, EDGE_GRID_MM, findEdges } from './edges.ts';
import type { CacheStats } from 'tess-cache/browser';
import { deflectionsOf, healingOf, minAngleOf, wantedOf, type Tessellation, type TessellationSettings }
  from './tessellation.ts';

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
 * importer's options (its progress, its healing: loadModelIn heals afterwards, in the pool's workers).
 */
export async function importModel(input: ModelInput, gltf: GltfImportOptions = {},
  step: Pick<ImportOptions, 'onProgress' | 'heal'> = {}): Promise<Scene> {
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
function importTaken(source: ModelSource, gltf: GltfImportOptions, step: Pick<ImportOptions, 'onProgress' | 'heal'>):
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
   * A part meshed, with its measures (Part.measures) where the backend gave them: the page's scene lacks them; edges
   * found from its triangles where the backend gave none (edges.ts); and its B-rep model's buffer and its analysis's
   * where it has one, handed over to the page (handOver), meshed or failed.
   */
  | ({ type: 'mesh'; part: number; mesh: Mesh | undefined; measures?: Measures; foundEdges?: Float32Array }
    & PartModel)
  /** Edges found from a part's level from the file, which has none of its own (edges.ts): segments. */
  | { type: 'edges'; part: number; positions: Float32Array }
  /** The end; `bounds` the model's sphere made again from the meshes (tessellateScene), where it changed. */
  | { type: 'done'; diagnostics: Diagnostic[]; meshing?: Meshing; bounds?: SceneBounds };

/** How often the import's progress is told, in milliseconds, within a phase. */
export const PROGRESS_MS = 200;

/**
 * The scene without its parts' B-rep models and outline functions (the model worker meshes; the page needs neither):
 * what can be posted to another thread.
 */
export function postable(scene: Scene): Scene {
  return { ...scene, parts: scene.parts.map((p) => (p.brep ? { ...p, brep: { format: p.brep.format,
    model: undefined as never } } : p)) };
}

// Who holds each part's B-rep model and its analysis (healing's: cad-heal heals again from the source's values it
// keeps), which move together. The page owns them at rest: each goes to it with its part's mesh event (handOver),
// meshed or failed, once meshing is done with it; the worker borrows them back (takeBack) for what needs them, Mesh
// again (healing first) and export. One copy, moved, never copied: while the page holds a model, the worker's part has
// stand-ins for it and its analysis that throw on any use (lentModel), so nothing here reads what it doesn't hold.
// Models of parts never meshed (not placed) stay here.

/** The stand-ins of models and analyses with the page. */
const lentModels = new WeakSet<object>();

/** A stand-in for a part's model (or its analysis) while the page holds it: any use throws. */
function lentModel<T>(part: number, what = 'B-rep model'): T {
  const m = new Proxy({}, { get(_t, key) {
    throw new Error(`part ${part}'s ${what} is with the page (reading ${String(key)}): borrow it back first`);
  } });
  lentModels.add(m);
  return m as T;
}

/** Whether a part's model is with the page. */
export const isLent = (scene: Scene, part: number) => {
  const m = scene.parts[part]?.brep?.model;
  return !!m && lentModels.has(m);
};

/**
 * A part's model and analysis handed to the page: their buffers, to transfer; the part left with stand-ins
 * (lentModel).
 */
export function handOver(scene: Scene, part: number): PartModel {
  const brep = scene.parts[part]!.brep!;
  if (lentModels.has(brep.model)) throw new Error(`part ${part}'s B-rep model is with the page already`);
  const out: PartModel = { model: brep.model.buffer };
  brep.model = lentModel(part);
  if (brep.analysis) {
    out.analysis = brep.analysis.buffer;
    brep.analysis = lentModel(part, 'B-rep analysis');
  }
  return out;
}

/**
 * Models and analyses back from the page, by part (their buffers, transferred): opened again, each part's outlines
 * made from its model (the closure the import made held the old views). Each must come back as it went: an analysis
 * with the model it went with, none without.
 */
export function takeBack(scene: Scene, models: readonly (readonly [number, PartModel])[]): void {
  for (const [part, m] of models) {
    const p = scene.parts[part];
    if (!p?.brep || !lentModels.has(p.brep.model)) throw new Error(`part ${part}'s B-rep model wasn't lent`);
    const lentAnalysis = !!p.brep.analysis && lentModels.has(p.brep.analysis);
    if (lentAnalysis !== !!m.analysis) {
      throw new Error(`part ${part}'s B-rep analysis ${m.analysis ? 'wasn\'t lent' : 'didn\'t come back'}`);
    }
  }
  for (const [part, m] of models) {
    const p = scene.parts[part]!, brep = p.brep!;
    const model = openBrep(m.model), origin = p.origin;
    brep.model = model;
    brep.outline = ({ faces: only, ...o }) => faceOutlines(model, origin, o, only);
    if (m.analysis) brep.analysis = openAnalysis(m.analysis);
  }
}

/** Throws unless the worker holds the models of these parts (a caller that didn't take them back first). */
export function needModels(scene: Scene, parts: readonly number[]): void {
  const lent = parts.filter((i) => isLent(scene, i));
  if (lent.length) throw new Error(`${lent.length} parts' B-rep models are with the page (part ${lent[0]}...)`);
}

/**
 * Each part's model its own buffer (copied where parts share one), as each is transferred alone (a transfer detaches
 * the buffer for every view of it).
 */
export function ownBuffers(scene: Scene): void {
  const seen = new Set<ArrayBuffer>();
  for (const p of scene.parts) {
    if (!p.brep) continue;
    if (seen.has(p.brep.model.buffer)) {
      const model = openBrep(p.brep.model.buffer.slice(0)), origin = p.origin;
      p.brep.model = model;
      if (p.brep.outline) p.brep.outline = ({ faces: only, ...o }) => faceOutlines(model, origin, o, only);
    }
    seen.add(p.brep.model.buffer);
  }
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
  const scene = await importTaken(source, gltf, { onProgress, heal: { heal: false } });
  if (cancelled()) return;
  ownBuffers(scene);
  // (Kept by the caller, to export later: the meshes go into its parts' levels as they're made.)
  keep?.(scene);
  // The levels shown that have no edges of their own get edges found from their triangles, part by part, after the
  // scene goes (edges.ts: off the page's thread, and not holding up meshing); those levels' buffers are copied to the
  // page rather than transferred, as they're needed here meanwhile, and released here once their edges are found.
  const jobs = edgeJobs(scene, wantedOf(settings));
  const kept = new Set(jobs.flatMap((j) => meshBuffers(j.mesh)));
  // (The file's other levels transferred: only B-rep models are used here from now on.)
  emit({ type: 'scene', scene: postable(scene), edgeParts: jobs.length },
    levelBuffers(scene).filter((b) => !kept.has(b)));
  const edges = (async () => {
    try {
      for (const { part, mesh } of jobs) {
        await new Promise((r) => setTimeout(r, 0));
        if (cancelled()) return;
        const positions = edgesOf(mesh);
        emit({ type: 'edges', part, positions }, [positions.buffer as ArrayBuffer]);
      }
    } finally {
      // Those levels' buffers released here once their edges are found (or the load cancelled): the page has its
      // copies, and nothing here reads them again (an export takes the page's meshes; bounds use the meshes' boxes),
      // as the levels transferred to it were left here detached. After the last job, as levels may share a buffer.
      for (const b of kept) structuredClone(b, { transfer: [b] });
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
  needModels(scene, brep);
  if (!brep.length) {
    await before;
    if (!cancelled()) emit({ type: 'done', diagnostics: [] });
    return;
  }
  const { tess, workers: n, pool } = await tessellation.get(settings, workers);
  if (cancelled()) return;
  const healed = await healIn(scene, settings, pool, n, emit, cancelled);
  if (cancelled()) return;
  // Faces that fail to mesh, and parts that do (errors, timeouts), outlined from the file (cad-scene's `outlines`).
  const min = minAngleOf(settings);
  const { diagnostics } = await tessellateScene(scene, tess, { ...deflectionsOf(settings),
    ...(min !== undefined ? { minAngle: min } : {}), edges: true, outlines: true, concurrency: n, parts: brep,
    onPart: (part, mesh) => {
      if (cancelled()) return;
      const measures = scene.parts[part]!.measures;
      // (A backend that gives no edges, truck: found here, with the mesh.)
      const found = mesh && needsEdges(mesh) ? edgesOf(mesh) : undefined;
      // (Meshing's last use of the part's model and analysis is over: they go to the page with the mesh.)
      const held = handOver(scene, part);
      emit({ type: 'mesh', part, mesh, ...(measures ? { measures } : {}), ...(found ? { foundEdges: found } : {}),
        ...held }, [...meshBuffers(mesh), ...(found ? [found.buffer as ArrayBuffer] : []), ...partModelBuffers(held)]);
    } });
  await before;
  if (cancelled()) return;
  const d = tessellation.describe();
  emit({ type: 'done', diagnostics: [...healed, ...diagnostics], ...(d ? { meshing: { ...d, workers: n } } : {}),
    ...(scene.bounds ? { bounds: scene.bounds } : {}) });
}

/** cad-heal's module in the pool's workers: the key the viewer's tess-worker.ts gives it. */
export const HEAL_MODULE = 'cad-heal';

/**
 * What healIn did to a scene: the healing it was healed with (healingOf; PART_HEALED where a healing was cancelled
 * partway, its models part healed) and healing's diagnostics. The models as imported aren't kept (they'd cost as much
 * memory as the scene's own): other healing heals each part again from its source's values, which its analysis keeps
 * (cad-heal's healPart).
 */
interface Healing { key: string; diagnostics: Diagnostic[] }
const healings = new WeakMap<Scene, Healing>();
/** The healing of a scene still going, which the next waits for (a cancelled one ends as its pool's workers stop). */
const healingNow = new WeakMap<Scene, Promise<unknown>>();
/**
 * A healing key no settings make: the scene's models part healed, by a healing cancelled before it ended (healing it
 * again heals each part as asked, from whatever healing it had).
 */
const PART_HEALED = '\0part healed';

/**
 * The scene's models healed as the settings ask, in `pool`'s workers, `workers` at once (none asked: as imported),
 * with healing's diagnostics; the import's healing phase emitted as it goes. Healed already as asked (or as imported,
 * none asked): kept. Healed otherwise (or a healing of it cancelled partway): healed again in place, each part from
 * its source's values (its analysis's), or put back as its source with healing off; a pole strayPole moved stays
 * moved, said.
 */
export async function healIn(scene: Scene, settings: Partial<TessellationSettings>,
  pool: Pick<PoolTessellator, 'run'>, workers: number, emit: (e: ModelEvent) => void, cancelled: () => boolean):
  Promise<Diagnostic[]> {
  const prior = healingNow.get(scene);
  const now = (async () => {
    await prior?.catch(() => {});
    const key = healingOf(settings), was = healings.get(scene);
    if ((was?.key ?? '') === key) return was?.diagnostics ?? [];
    const before = scene.diagnostics.length;
    let told = -Infinity;
    // (Marked before the first part changes: a cancel or a throw leaves its models part healed.)
    healings.set(scene, { key: PART_HEALED, diagnostics: [] });
    await healScene(scene, { heal: !!key, fixes: settings.healFixes, ...(settings.healFit === undefined ? {}
      : { pcurveFitTolerance: settings.healFit }), concurrency: workers,
      healer: poolHealer(pool, HEAL_MODULE),
      onPart: (done, total) => {
        const t = performance.now();
        if (cancelled() || (done < total && t - told < PROGRESS_MS)) return;
        told = t;
        emit({ type: 'importing', progress: { phase: 'healing', done, total } });
      } });
    // (Kept apart from the scene's own, as healing's.)
    const diagnostics = scene.diagnostics.splice(before);
    if (cancelled()) return [];
    healings.set(scene, { key, diagnostics });
    return diagnostics;
  })();
  healingNow.set(scene, now);
  return now;
}
