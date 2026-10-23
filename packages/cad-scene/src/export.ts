// What every exporter needs from a scene and its meshes, computed once (README.md, "The exporters"):
//
//   looks: each part as it appears, with its materials resolved. All three formats share geometry between instances,
//     but a mesh carries its materials, so instances whose resolved materials differ (an assembly's colour applied
//     top down, an instance override) get different looks; instances with equal looks share one. A look's triangles
//     are reordered so faces with the same material are contiguous: one group per material.
//   nodes: the expanded instance tree, with local transforms and each instance's parts as looks.

import type { Component, Mat4, Mesh, Occurrence, Scene } from './scene.ts';
import { identity, multiply, partInstances, type PartInstance } from './walk.ts';

export interface ExportViewOptions {
  /** Keep B-rep edges. Default false (CLAUDE.md, "Decisions"). */
  edges?: boolean;
  /** Keep wireframe curves and isolated points. Default false (CLAUDE.md, "Decisions"). */
  curves?: boolean;
}

/** A part as it appears: its mesh, and its triangles grouped by material. */
export interface Look {
  part: number;
  mesh: Mesh;
  /** The material of faces without one of their own, and of edges, curves and points; undefined: the viewer's default. */
  material?: number;
  /** The mesh's triangles, reordered so each group is contiguous (the mesh's own when there's one group). */
  indices: Uint32Array;
  /** Ranges of `indices`, in the order their materials first appear; they partition `indices`. */
  groups: { material: number | undefined; start: number; count: number }[];
  /** The mesh's face ranges, moved with their triangles: ranges of `indices`, for picking. */
  faces: Mesh['faces'];
  /** Kept only when `ExportViewOptions` asks for them. */
  edges: boolean;
  curves: boolean;
}

/** One component instance in the expanded tree. */
export interface ExportNode {
  /** Indices from the root: into `Scene.roots`, then into each component's `children`. */
  path: number[];
  component: number;
  occurrence: Occurrence;
  /** The occurrence's name, else the component's. */
  name: string;
  /** From this node's coordinates to its parent's (or the scene's, for a root), in millimetres. */
  transform: Mat4;
  /** The component's parts that have something to draw. */
  parts: { look: number; transform: Mat4; visible: boolean }[];
  children: ExportNode[];
}

export interface ExportView {
  looks: Look[];
  roots: ExportNode[];
}

/**
 * A part's mesh: the tessellation from `meshes` for brep parts, the finest level for mesh parts, and the polylines
 * of curves parts as a mesh with curves only.
 */
export function partMesh(scene: Scene, meshes: ReadonlyMap<number, Mesh>, part: number): Mesh | undefined {
  const p = scene.parts[part];
  if (!p) return undefined;
  if (p.kind === 'mesh') return p.lods[0];
  if (p.kind === 'curves') {
    return {
      origin: p.origin, positions: new Float32Array(0), indices: new Uint32Array(0), faces: [],
      curvePositions: p.positions, curves: p.polylines.map((l) => ({ source: l.source ?? null, start: l.start, count: l.count })),
    };
  }
  return meshes.get(part);
}

function translation(v: readonly number[]): Mat4 {
  const m = identity();
  m[12] = v[0]!; m[13] = v[1]!; m[14] = v[2]!;
  return m;
}

/** The export view of a scene whose brep parts have been tessellated into `meshes` (by part index). */
export function exportView(scene: Scene, meshes: ReadonlyMap<number, Mesh>, opts: ExportViewOptions = {}): ExportView {
  const edges = opts.edges ?? false, curves = opts.curves ?? false;
  const looks: Look[] = [];
  const lookByKey = new Map<string, number>();
  const meshOf = new Map<number, Mesh | undefined>();

  const lookFor = (part: number, material: number | undefined, faceMaterials: ReadonlyMap<number, number>): number | undefined => {
    if (!meshOf.has(part)) meshOf.set(part, partMesh(scene, meshes, part));
    const mesh = meshOf.get(part);
    if (!mesh) return undefined;
    const hasEdges = edges && !!mesh.edges?.length;
    const hasCurves = curves && (!!mesh.curves?.length || !!mesh.pointSources?.length);
    if (!mesh.indices.length && !hasEdges && !hasCurves) return undefined;
    // Each face range's material (its own, else the default); these and the default decide the look.
    const perFace = mesh.faces.map((f) => (f.source === null ? undefined : faceMaterials.get(f.source)) ?? material);
    const key = `${part}:${material}:${perFace.join(',')}`;
    const known = lookByKey.get(key);
    if (known !== undefined) return known;
    const look: Look = { part, mesh, ...group(mesh, perFace, material), edges: hasEdges, curves: hasCurves };
    if (material !== undefined) look.material = material;
    lookByKey.set(key, looks.length);
    looks.push(look);
    return looks.length - 1;
  };

  // Resolved appearance per component instance, in its parts' order (partInstances yields them so).
  const resolved = new Map<string, PartInstance[]>();
  for (const pi of partInstances(scene)) {
    const key = pi.path.join('/');
    let list = resolved.get(key);
    if (!list) resolved.set(key, (list = []));
    list.push(pi);
  }

  // The tree, as `instances` walks it (a component inside itself isn't expanded again).
  const visit = (occ: Occurrence, path: number[], onPath: Set<number>): ExportNode => {
    const comp: Component = scene.components[occ.component]!;
    const node: ExportNode = {
      path, component: occ.component, occurrence: occ, name: occ.name ?? comp.name, transform: occ.transform, parts: [], children: [],
    };
    for (const pi of resolved.get(path.join('/')) ?? []) {
      const look = lookFor(pi.part, pi.material, pi.faceMaterials);
      if (look === undefined) continue;
      node.parts.push({ look, transform: multiply(pi.ref.transform, translation(looks[look]!.mesh.origin)), visible: pi.visible });
    }
    comp.children.forEach((child, i) => {
      if (onPath.has(child.component)) return;
      onPath.add(child.component);
      node.children.push(visit(child, [...path, i], onPath));
      onPath.delete(child.component);
    });
    return node;
  };
  const roots = scene.roots.map((occ, i) => visit(occ, [i], new Set([occ.component])));
  return { looks, roots };
}

/** A mesh's triangles reordered by face material, groups in order of first appearance; a mesh without faces is one group. */
function group(mesh: Mesh, perFace: (number | undefined)[], material: number | undefined): Pick<Look, 'indices' | 'groups' | 'faces'> {
  const order: (number | undefined)[] = [];
  const ranges = new Map<number | undefined, number[]>();
  mesh.faces.forEach((f, k) => {
    const m = perFace[k];
    let list = ranges.get(m);
    if (!list) { ranges.set(m, (list = [])); order.push(m); }
    list.push(k);
  });
  if (order.length <= 1) {
    const m = order.length ? order[0] : material;
    return { indices: mesh.indices, groups: mesh.indices.length ? [{ material: m, start: 0, count: mesh.indices.length }] : [], faces: mesh.faces };
  }
  const indices = new Uint32Array(mesh.indices.length);
  const groups: Look['groups'] = [];
  const faces: Look['faces'] = [];
  let at = 0;
  for (const m of order) {
    const start = at;
    for (const k of ranges.get(m)!) {
      const f = mesh.faces[k]!;
      indices.set(mesh.indices.subarray(f.start, f.start + f.count), at);
      faces.push({ source: f.source, start: at, count: f.count });
      at += f.count;
    }
    if (at > start) groups.push({ material: m, start, count: at - start });
  }
  return { indices, groups, faces };
}
