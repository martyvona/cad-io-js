// A model's three.js graph, from its scene whatever the file's format (the user, 2026-10-24; one path for every
// format since 2026-10-29; CLAUDE.md, "The viewer"): the assembly tree from the scene at once, mesh parts' levels
// with it, then each B-rep part's mesh attached to every placement of the part as tessellation delivers it, so the
// model appears part by part.
//
//   root -> a Group per component instance (its occurrence's transform) -> ... -> a Group per placed part (the part
//     reference's transform: the part's own unit to millimetres) -> a Mesh at the mesh's origin, with its B-rep
//     edges, wireframe curves and points as children (LineSegments, LineSegments, Points)
//
// A part's geometry is shared by its placements: one set of attributes, and one geometry (its groups) per distinct
// colouring of the faces. Edges are the B-rep's where the backend gave them (shared and free ones, as the exporters
// write them, and our glTF and three.js files hold); a part with triangles and no edges (a foreign file's) gets edges
// found from its triangles instead.
//
// For the node model (model.ts): component groups have `userData.cad` 'assembly', placed parts' groups 'part', and
// each placement's Mesh its faces' source ids in `userData.faces` (and their index ranges in `faceRanges`, for
// picking and selection). Hiding a face (FaceHiding) hides its triangles in every placement of the part: they get
// a geometry group of their own with an invisible material.

import * as THREE from 'three';
import { faceFailures, instances, partInstances, type FaceFailure, type Mat4, type Measures, type Mesh,
  type PartInstance, type Scene, type SourceId } from 'cad-scene';
import type { FaceHiding } from './model.ts';
import { DEFAULT_RENDER, EDGES } from './style.ts';

/** sRGB, as the exporters' default: faces, curves and points without a material. */
export const DEFAULT_COLOR: readonly [number, number, number] = [0.8, 0.8, 0.8];
/** The angle between faces (degrees) above which a part without B-rep edges gets an edge drawn. */
export const EDGE_ANGLE = 10;

const EDGE_KINDS = new Set(['shared', 'free']);

const matrix = (m: Mat4) => new THREE.Matrix4().fromArray(m);
/** The STEP entities among sources, each once. */
const stepIds = (sources: readonly SourceId[]) => [...new Set(sources.flatMap((s) => (s.format === 'step' ? [s.id]
  : [])))];

function setMatrix(o: THREE.Object3D, m: Mat4): void {
  o.matrix.copy(matrix(m));
  o.matrix.decompose(o.position, o.quaternion, o.scale);
}

/** Segment pairs for polylines given as point ranges. */
export function polylineSegments(lines: readonly { start: number; count: number }[]): Uint32Array {
  let n = 0;
  for (const l of lines) n += Math.max(0, l.count - 1);
  const index = new Uint32Array(2 * n);
  let k = 0;
  for (const l of lines) for (let i = 0; i < l.count - 1; i++) {
    index[k++] = l.start + i;
    index[k++] = l.start + i + 1;
  }
  return index;
}

/** A placed part: its group in the tree, and its appearance as the scene resolves it. */
export interface Placement {
  group: THREE.Group;
  instance: PartInstance;
}

/** A meshed part: what assigning faces to geometry groups and materials needs again when faces are hidden. */
interface MeshedPart {
  mesh: Mesh;
  attrs: { position: THREE.BufferAttribute; normal?: THREE.BufferAttribute; index: THREE.BufferAttribute };
  /** Geometries by grouping (runs of faces and their materials). */
  geometries: Map<string, THREE.BufferGeometry>;
  objects: { obj: THREE.Mesh; instance: PartInstance }[];
}

/**
 * Faces that failed to mesh: their outlines (Mesh.faceOutlines, from the file), in red (the user, 2026-10-28: so
 * where they should be can be found). The tree marks their nodes the same red (tree-panel.ts).
 */
export const FAILED_COLOR = 0xe02020;
const OUTLINE = new THREE.LineBasicMaterial({ color: FAILED_COLOR });

/** Hidden faces' triangles: drawn with nothing. */
const HIDDEN = new THREE.MeshBasicMaterial({ visible: false });

export class SceneGraph implements FaceHiding {
  readonly root = new THREE.Group();
  readonly scene: Scene;
  /** Each part's placements, by part index. */
  readonly placements = new Map<number, Placement[]>();
  private readonly materials = new Map<string, THREE.Material>();
  private readonly lineMaterial = new THREE.LineBasicMaterial({ color: 0x000000 });
  private readonly meshed = new Map<number, MeshedPart>();
  /** Failed faces' outline objects, by part, each with its face's source id (userData.outlineFace). */
  private readonly outlined = new Map<number, THREE.LineSegments[]>();
  /** Hidden faces' source ids, by part. */
  private readonly hiddenFaces = new Map<number, Set<number>>();
  /** The objects addMesh made for each part, one per placement (replaced by its next mesh). */
  private readonly made = new Map<number, THREE.Object3D[]>();

  private readonly shininess: number;
  private readonly specular: number;

  constructor(scene: Scene, name: string, shininess = DEFAULT_RENDER.shininess, specular = DEFAULT_RENDER.specular) {
    this.scene = scene;
    this.shininess = shininess;
    this.specular = specular;
    this.root.name = name;
    const groups = new Map<string, THREE.Group>();
    for (const inst of instances(scene)) {
      const parent = inst.path.length === 1 ? undefined : groups.get(inst.path.slice(0, -1).join('/'));
      const occ = parent ? scene.components[parent.userData.component as number]!.children[inst.path.at(-1)!]!
        : scene.roots[inst.path[0]!]!;
      const g = new THREE.Group();
      g.name = occ.name ?? scene.components[inst.component]!.name;
      // (Its STEP ids: the occurrence's, then its component's; step-ids.ts.)
      const sources = stepIds([...occ.sources, ...scene.components[inst.component]!.sources]);
      g.userData = { cad: 'assembly', component: inst.component, path: inst.path, sources };
      setMatrix(g, occ.transform);
      (parent ?? this.root).add(g);
      groups.set(inst.path.join('/'), g);
    }
    for (const pi of partInstances(scene)) {
      const g = new THREE.Group();
      g.name = scene.parts[pi.part]!.name;
      // (Its faces' ids STEP's when the part comes from STEP: a foreign file's are numbers of its own.)
      const sources = stepIds(scene.parts[pi.part]!.sources);
      g.userData = { cad: 'part', part: pi.part, path: pi.path, sources, stepFaces: sources.length > 0 };
      g.visible = pi.visible;
      setMatrix(g, pi.ref.transform);
      groups.get(pi.path.join('/'))!.add(g);
      let list = this.placements.get(pi.part);
      if (!list) this.placements.set(pi.part, (list = []));
      list.push({ group: g, instance: pi });
    }
  }

  /** The three.js material for a scene material (or the default) and a kind of object. */
  private material(index: number | undefined, kind: 'face' | 'curve' | 'point'): THREE.Material {
    const key = `${kind}:${index ?? 'default'}`;
    let m = this.materials.get(key);
    if (m) return m;
    const sm = index === undefined ? undefined : this.scene.materials[index];
    const [r, g, b] = sm?.color ?? DEFAULT_COLOR;
    const color = new THREE.Color().setRGB(r, g, b, THREE.SRGBColorSpace);
    const opacity = sm?.opacity ?? 1;
    const common = { color, opacity, transparent: opacity < 1 };
    m = kind === 'face' ? new THREE.MeshPhongMaterial({ ...common, specular: new THREE.Color().setScalar(this.specular),
      shininess: this.shininess,
      // Faces a little behind their edges, so edges draw on top.
      polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 })
      : kind === 'curve' ? new THREE.LineBasicMaterial(common) : new THREE.PointsMaterial({ ...common, size: 4,
        sizeAttenuation: false });
    if (sm?.name) m.name = sm.name;
    this.materials.set(key, m);
    return m;
  }

  /**
   * Attaches a part's mesh to each of its placements, in place of any it had (the file's own tessellation of a B-rep,
   * shown until ours comes); nothing for a part without one (it failed, or is empty). Returns the objects made, one
   * per placement. `linearDeflection` (mm) is the one the mesh was made with, where known: with the part's measures,
   * its faces are judged by their areas (faceFailures).
   */
  addMesh(part: number, mesh: Mesh, linearDeflection?: number): THREE.Object3D[] {
    const placements = this.placements.get(part) ?? [];
    if (!placements.length) return [];
    this.removeMesh(part);
    const triangles = mesh.indices.length > 0;
    let attrs: { position: THREE.BufferAttribute; normal?: THREE.BufferAttribute; index: THREE.BufferAttribute }
      | undefined;
    const geometries = new Map<string, THREE.BufferGeometry>();
    let edges: THREE.BufferGeometry | undefined;
    if (triangles) {
      attrs = { position: new THREE.BufferAttribute(mesh.positions, 3), index: new THREE.BufferAttribute(mesh.indices,
        1) };
      if (mesh.normals) attrs.normal = new THREE.BufferAttribute(mesh.normals, 3);
      const kept = (mesh.edges ?? []).filter((e) => EDGE_KINDS.has(e.kind));
      if (mesh.edgePositions && kept.length) {
        edges = new THREE.BufferGeometry();
        edges.setAttribute('position', new THREE.BufferAttribute(mesh.edgePositions, 3));
        edges.setIndex(new THREE.BufferAttribute(polylineSegments(kept), 1));
      } else if (!mesh.edges?.length) {
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', attrs.position);
        g.setIndex(attrs.index);
        edges = new THREE.EdgesGeometry(g, EDGE_ANGLE);
      }
    }
    let curves: THREE.BufferGeometry | undefined;
    if (mesh.curvePositions && mesh.curves?.length) {
      curves = new THREE.BufferGeometry();
      curves.setAttribute('position', new THREE.BufferAttribute(mesh.curvePositions, 3));
      curves.setIndex(new THREE.BufferAttribute(polylineSegments(mesh.curves), 1));
    }
    let points: THREE.BufferGeometry | undefined;
    if (mesh.points?.length) {
      points = new THREE.BufferGeometry();
      points.setAttribute('position', new THREE.BufferAttribute(mesh.points, 3));
    }

    const meshed: MeshedPart | undefined = attrs ? { mesh, attrs, geometries, objects: [] } : undefined;
    if (meshed) this.meshed.set(part, meshed);
    const faceSources = [...new Set(mesh.faces.flatMap((f) => f.source === null ? [] : [f.source]))];
    // Faces that failed (cad-scene's faceFailures: no triangles; with the part's measures, its triangles short of the
    // face's area, well over it, or no area to judge them by), all but `partly` drawn as failed (the user,
    // 2026-10-30: red, the kinds kept apart, in `faceReport`); an outline geometry for each that has outlines.
    const p = this.scene.parts[part]!;
    const measured = p.measures && linearDeflection !== undefined
      ? { measures: p.measures, deflection: linearDeflection / p.unit } : undefined;
    const failures = faceFailures(mesh, measured ? { measured } : {});
    const failedFaces = faceSources.filter((s) => failures.has(s) && failures.get(s) !== 'partly');
    const partlyFailedFaces = faceSources.filter((s) => failures.get(s) === 'partly');
    const faceReport = reportOf(mesh, p.unit, failures, p.measures);
    const outlines = new Map<number, THREE.BufferGeometry>();
    if (mesh.faceOutlinePositions && mesh.faceOutlines?.length) {
      const position = new THREE.BufferAttribute(mesh.faceOutlinePositions, 3);
      const bySource = new Map<number, { start: number; count: number }[]>();
      // (Only faces that failed: a mesh from elsewhere could outline a sliver.)
      for (const o of mesh.faceOutlines) {
        if (failures.has(o.source)) bySource.set(o.source, [...bySource.get(o.source) ?? [], o]);
      }
      for (const [source, lines] of bySource) {
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', position);
        g.setIndex(new THREE.BufferAttribute(polylineSegments(lines), 1));
        outlines.set(source, g);
      }
    }
    const hiddenFaces = this.hiddenFaces.get(part);
    const made: THREE.Object3D[] = [];
    for (const { group, instance } of placements) {
      let obj: THREE.Object3D;
      if (meshed) {
        const m = new THREE.Mesh();
        this.assign(part, meshed, m, instance);
        meshed.objects.push({ obj: m, instance });
        obj = m;
      } else {
        obj = new THREE.Group();
      }
      const closed = this.scene.parts[part]!.closed;
      obj.userData = { faces: faceSources, faceRanges: mesh.faces, failedFaces, partlyFailedFaces, faceReport,
        ...(closed === undefined ? {} : { closed }) };
      obj.name = group.name;
      obj.position.set(...mesh.origin);
      if (edges) {
        const e = Object.assign(new THREE.LineSegments(edges, this.lineMaterial), { name: 'edges' });
        e.layers.set(EDGES);
        obj.add(e);
      }
      if (curves) obj.add(Object.assign(new THREE.LineSegments(curves, this.material(instance.material, 'curve')),
        { name: 'curves' }));
      if (points) obj.add(Object.assign(new THREE.Points(points, this.material(instance.material, 'point')),
        { name: 'points' }));
      // (On the edges' layer too, so fat edges draw them fat; picked as their face.)
      for (const [source, g] of outlines) {
        const l = Object.assign(new THREE.LineSegments(g, OUTLINE), { name: 'outline' });
        l.userData.outlineFace = source;
        l.layers.enable(EDGES);
        l.visible = !hiddenFaces?.has(source);
        obj.add(l);
        this.outlined.set(part, [...this.outlined.get(part) ?? [], l]);
      }
      group.add(obj);
      made.push(obj);
    }
    this.made.set(part, made);
    return made;
  }

  /** Whether a part has a mesh drawn. */
  hasMesh(part: number): boolean {
    return this.made.has(part);
  }

  /** Takes a part's mesh away from its placements, its geometries disposed. */
  private removeMesh(part: number): void {
    const made = this.made.get(part);
    if (!made) return;
    for (const obj of made) {
      obj.removeFromParent();
      obj.traverse((o) => { if (o instanceof THREE.Mesh || o instanceof THREE.LineSegments || o instanceof THREE.Points)
        o.geometry.dispose(); });
    }
    for (const g of this.meshed.get(part)?.geometries.values() ?? []) g.dispose();
    this.made.delete(part);
    this.meshed.delete(part);
    this.outlined.delete(part);
  }

  /** Sets a placement's geometry (shared by grouping) and materials: runs of faces by material, hidden faces apart. */
  private assign(part: number, meshed: MeshedPart, obj: THREE.Mesh, instance: PartInstance): void {
    const hidden = this.hiddenFaces.get(part);
    const runs: { start: number; count: number; material: number | undefined | 'hidden' }[] = [];
    // (A mesh without faces, a foreign file's of one material: all its triangles in the part's.)
    const faces = meshed.mesh.faces.length ? meshed.mesh.faces : [{ source: null, start: 0,
      count: meshed.mesh.indices.length }];
    for (const f of faces) {
      const m = f.source !== null && hidden?.has(f.source) ? 'hidden' as const
        : (f.source !== null ? instance.faceMaterials.get(f.source) : undefined) ?? instance.material;
      const last = runs.at(-1);
      if (last && last.material === m && last.start + last.count === f.start) last.count += f.count;
      else runs.push({ start: f.start, count: f.count, material: m });
    }
    const key = runs.map((r) => `${r.start}:${r.material}`).join(',');
    let g = meshed.geometries.get(key);
    if (!g) {
      g = new THREE.BufferGeometry();
      g.setAttribute('position', meshed.attrs.position);
      if (meshed.attrs.normal) g.setAttribute('normal', meshed.attrs.normal);
      g.setIndex(meshed.attrs.index);
      runs.forEach((r, i) => g!.addGroup(r.start, r.count, i));
      meshed.geometries.set(key, g);
    }
    obj.geometry = g;
    obj.material = runs.map((r) => r.material === 'hidden' ? HIDDEN : this.material(r.material, 'face'));
  }

  /** Every hidden face, as its part and source id. */
  *hiddenFaceList(): Iterable<[number, number]> {
    for (const [part, sources] of this.hiddenFaces) for (const source of sources) yield [part, source];
  }

  isFaceHidden(part: number, source: number): boolean {
    return this.hiddenFaces.get(part)?.has(source) ?? false;
  }

  setFaceHidden(part: number, source: number, hidden: boolean): void {
    let set = this.hiddenFaces.get(part);
    if (!set) this.hiddenFaces.set(part, (set = new Set()));
    if (hidden) set.add(source);
    else set.delete(source);
    const meshed = this.meshed.get(part);
    if (meshed) for (const { obj, instance } of meshed.objects) this.assign(part, meshed, obj, instance);
    for (const l of this.outlined.get(part) ?? []) if (l.userData.outlineFace === source) l.visible = !hidden;
  }

  showAllFaces(): void {
    const parts = [...this.hiddenFaces.keys()];
    this.hiddenFaces.clear();
    for (const part of parts) {
      const meshed = this.meshed.get(part);
      if (meshed) for (const { obj, instance } of meshed.objects) this.assign(part, meshed, obj, instance);
      for (const l of this.outlined.get(part) ?? []) l.visible = true;
    }
  }
}

/** What Details says of a face: how it failed (faceFailures), and its measured and meshed areas in mm^2. */
export interface FaceReport { failure?: FaceFailure; area?: number; meshArea: number }

/** Each face's report, by source id (faces with a source only). */
function reportOf(mesh: Mesh, unit: number, failures: ReadonlyMap<number, FaceFailure>,
  measures: Measures | undefined): Record<number, FaceReport> {
  const p = mesh.positions, ix = mesh.indices, out: Record<number, FaceReport> = {};
  for (const f of mesh.faces) {
    if (f.source === null) continue;
    const r = out[f.source] ??= { meshArea: 0 };
    for (let t = f.start; t < f.start + f.count; t += 3) {
      const [i, j, k] = [3 * ix[t]!, 3 * ix[t + 1]!, 3 * ix[t + 2]!];
      const u = [p[j]! - p[i]!, p[j + 1]! - p[i + 1]!, p[j + 2]! - p[i + 2]!];
      const v = [p[k]! - p[i]!, p[k + 1]! - p[i + 1]!, p[k + 2]! - p[i + 2]!];
      r.meshArea += Math.hypot(u[1]! * v[2]! - u[2]! * v[1]!, u[2]! * v[0]! - u[0]! * v[2]!,
        u[0]! * v[1]! - u[1]! * v[0]!) / 2 * unit * unit;
    }
  }
  for (const [s, r] of Object.entries(out)) {
    const m = measures?.faces.get(Number(s)), failure = failures.get(Number(s));
    if (m) r.area = m.area * unit * unit;
    if (failure) r.failure = failure;
  }
  return out;
}
