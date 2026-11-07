// A scene from a tree of nodes and meshes, as glTF and three.js JSON files hold one (docs/scene-formats.md): the
// shared core of `gltf-import` and `threejs-import`, which read their files into a TreeNode and leave the rest here.
//
// Our files (with our extras: the root's says millimetres, Z up below it) are read as the inverse of exportView and
// the exporters: tree nodes are component instances (`extras.component.index`), part nodes placed parts
// (`extras.part`), their meshes the part's level with its faces (ranges, or Draco's per-vertex `_FACE`), and their
// `edges`, `curves` and `points` children its B-rep edges, curves and points. A component's parts and children are
// the union over its instances (an instance the exporter left out, a hidden one in glTF, comes back hidden), and
// what one placement shows differently from the part's first (its colours, hidden) becomes an override for that
// placement alone.
//
// Other files (nodes as components, meshes as parts): every node a component placed once, its meshes parts shared
// wherever the file reuses them, a mesh's groups of triangles (glTF's primitives, as Onshape writes a face each;
// three.js's geometry groups) its faces, numbered from 0, with their own materials; lines and points parts of curves
// and points, except a child named `edges` of only lines beside one triangle mesh, its edges (as our exporters write
// B-rep edges without extras); the root from metres, Y up, to millimetres, Z up.

import type { Component, Diagnostic, Lod, Mat4, Material, Mesh, Occurrence, Part, PartRef, Properties, PropertyValue,
  Scene, SourceId, Vec3 } from './scene.ts';
import { boundsFrom, levelFrom, measuresFrom, placementFrom, unitFrom } from './measures.ts';
import { leafParts } from './leaf.ts';
import { identity, multiply } from './walk.ts';

export type TreeExtras = { [key: string]: unknown };

/** A material as the file has it: sRGB colour and opacity; our extras' scene material index where present. */
export interface TreeMaterial {
  /** The file's identity for it (shared materials, one scene material). */
  key: string;
  name?: string;
  color: Vec3;
  opacity: number;
  /** Our extras: the scene material it was. */
  index?: number;
}

/** Something a node draws: triangles, line segments or points. */
export interface TreeMesh {
  /** The file's identity for the geometry and its materials (the same key: one part, shared). */
  key: string;
  mode: 'triangles' | 'lines' | 'points';
  positions: Float32Array;
  normals?: Float32Array;
  /** Triangles or segments (pairs); absent: the vertices in order. */
  indices?: Uint32Array;
  /**
   * Ranges of the indices and their materials (triangles: one per material, or per face in other files: a glTF
   * mesh's primitives; lines and points: one).
   */
  groups: { start: number; count: number; material?: TreeMaterial }[];
  /** Our extras: `faces` (ranges of the indices, or with `vertexFaces` sources only), `edges`, `curves`, `points`. */
  extras?: TreeExtras;
  /** Draco with our extras: each vertex's face, an index into `extras.faces` (65535: none). */
  vertexFaces?: ArrayLike<number>;
}

export interface TreeNode {
  name: string;
  /** Its transform within its parent, column-major, in the file's units. */
  matrix: Mat4;
  visible: boolean;
  extras?: TreeExtras;
  meshes: TreeMesh[];
  children: TreeNode[];
}

/** Ours: the root's extras say what's beneath it, millimetres with Z up (export-gltf, export-threejs). */
export function isOurTree(root: TreeNode): boolean {
  return root.extras?.unit === 'millimetre' && root.extras.up === 'z';
}

/** Metres, Y up, to millimetres, Z up: (x, y, z) m -> (x, -z, y) mm (the inverse of cad-scene's Y_UP_METRES). */
export const MM_Z_UP: Mat4 = Float64Array.of(1000, 0, 0, 0, 0, 0, 1000, 0, 0, -1000, 0, 0, 0, 0, 0, 1);

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const obj = (v: unknown): TreeExtras | undefined => (v && typeof v === 'object' && !Array.isArray(v)
  ? v as TreeExtras : undefined);
const sourcesOf = (v: unknown): SourceId[] => (Array.isArray(v) ? v.flatMap((s) => {
  const o = obj(s);
  return o && typeof o.format === 'string' && num(o.id) !== undefined ? [{ format: o.format, id: o.id as number }]
    : [];
}) : []);
const propertiesOf = (v: unknown): Record<string, PropertyValue> => (obj(v) ?? {}) as Record<string, PropertyValue>;

/** The scene's properties: the source's, from our extras, with the file's own as `container`; else the file's own. */
export function propertiesFrom(source: Properties, own: Properties): Properties {
  return Object.keys(source).length ? { ...source, ...(Object.keys(own).length ? { container: own } : {}) } : own;
}
/**
 * Transforms equal to 1e-5 of their largest entry: one reference or child however its instances' files round it
 * (GPU instances' float32 translation, rotation and scale make each instance's local transform a little different,
 * the rotation's error scaled with the transform: a part in feet scales by 304.8).
 */
export const closeTransforms = (a: Mat4, b: Mat4) => {
  const size = Math.max(1, ...Array.from(a, Math.abs), ...Array.from(b, Math.abs));
  return a.every((x, i) => Math.abs(x - b[i]!) <= 1e-5 * size);
};
const close = closeTransforms;
/** A part reference or child occurrence: what it places, and where. */
interface Placed { id: string; matrix: Mat4 }
/** The first of a list's references or children matching, not among those an instance has matched already. */
const find = (list: Placed[], id: string, m: Mat4, used: Set<number>) => list.findIndex((k, i) => !used.has(i) &&
  k.id === id && close(k.matrix, m));

/** A face's material, and the default (a part's material: what faces without their own take). */
interface Appearance { material: number | undefined; faces: Map<number, number | undefined> }

class Builder {
  readonly diagnostics: Diagnostic[] = [];
  readonly components: Component[] = [];
  readonly parts: Part[] = [];
  readonly materials: Material[] = [];
  readonly overrides: Scene['overrides'] = [];
  private readonly materialOf = new Map<string, number>();
  private readonly partOf = new Map<string, number>();
  /** Ours: a material without our index is the exporters' default (no scene material). */
  ours = false;
  /** Each part's appearance in its first placement: what other placements are compared with. */
  private readonly base = new Map<number, Appearance>();

  warn(message: string): void {
    this.diagnostics.push({ severity: 'warning', message });
  }

  /** A scene material for a file's: by our extras' index, else by the file's key. */
  material(m: TreeMaterial | undefined): number | undefined {
    if (!m || (this.ours && m.index === undefined)) return undefined;
    if (m.index !== undefined) {
      while (this.materials.length <= m.index) this.materials.push({ color: [0.8, 0.8, 0.8], opacity: 1, sources: [] });
      if (!this.materialOf.has(`#${m.index}`)) {
        this.materialOf.set(`#${m.index}`, m.index);
        this.materials[m.index] = { ...(m.name ? { name: m.name } : {}), color: m.color, opacity: m.opacity,
          sources: [] };
      }
      return m.index;
    }
    let i = this.materialOf.get(m.key);
    if (i === undefined) {
      this.materialOf.set(m.key, (i = this.materials.length));
      this.materials.push({ ...(m.name ? { name: m.name } : {}), color: m.color, opacity: m.opacity, sources: [] });
    }
    return i;
  }

  /** A part, made once per key from the first `make`. */
  part(key: string, make: () => Part): number {
    let i = this.partOf.get(key);
    if (i === undefined) {
      this.partOf.set(key, (i = this.parts.length));
      this.parts.push(make());
    }
    return i;
  }

  /**
   * An override for a placement whose appearance differs from its part's first (that one's becomes the part's own):
   * the default material, and every face's that differs from it.
   */
  appearance(part: number, a: Appearance, path: number[], ref: number): void {
    const base = this.base.get(part);
    if (!base) {
      this.base.set(part, a);
      const p = this.parts[part]!;
      if (a.material !== undefined) p.material = a.material;
      const faces = [...a.faces].filter(([, m]) => m !== a.material && m !== undefined);
      if (faces.length) p.faceMaterials = faces.map(([face, material]) => ({ face, material: material! }));
      return;
    }
    const same = base.material === a.material && a.faces.size === base.faces.size &&
      [...a.faces].every(([f, m]) => base.faces.get(f) === m);
    if (same) return;
    const faceMaterials = [...a.faces].filter(([, m]) => m !== a.material && m !== undefined)
      .map(([face, material]) => ({ part, face, material: material! }));
    this.overrides.push({ path, ref, ...(a.material !== undefined ? { material: a.material } : {}),
      ...(faceMaterials.length ? { faceMaterials } : {}), sources: [] });
  }
}

/** Polylines back from segment pairs, by our extras' ranges of the indices: each a run of consecutive vertices. */
function polylines(m: TreeMesh, ranges: unknown): { source: number | null; start: number; count: number;
  kind?: string; dihedral?: number }[] {
  if (!Array.isArray(ranges) || !m.indices) return [];
  const out = [];
  for (const r of ranges) {
    const o = obj(r);
    const start = num(o?.start), count = num(o?.count);
    if (!o || start === undefined || count === undefined || count < 2) continue;
    const first = m.indices[start];
    if (first === undefined) continue;
    out.push({ source: num(o.source) ?? null, start: first, count: count / 2 + 1,
      ...(typeof o.kind === 'string' ? { kind: o.kind } : {}), ...(num(o.dihedral) !== undefined
        ? { dihedral: o.dihedral as number } : {}) });
  }
  return out;
}

/**
 * A node's triangles as one mesh (their positions joined; faces from our extras, ranges or Draco's per-vertex faces,
 * moved with their triangles), and each face's material by the group its triangles are in.
 */
function triangles(meshes: TreeMesh[]): { mesh: Mesh; faceMaterial: Map<number, TreeMaterial | undefined>;
  groups: { start: number; count: number; material?: TreeMaterial }[] } {
  const total = meshes.reduce((n, m) => n + m.positions.length, 0);
  const positions = new Float32Array(total);
  const normals = meshes.every((m) => m.normals) ? new Float32Array(total) : undefined;
  const indices: number[] = [];
  const faces: Mesh['faces'] = [];
  const faceMaterial = new Map<number, TreeMaterial | undefined>();
  const groups: { start: number; count: number; material?: TreeMaterial }[] = [];
  let base = 0;
  for (const m of meshes) {
    positions.set(m.positions, 3 * base);
    if (normals) normals.set(m.normals!, 3 * base);
    const ix = m.indices ?? Uint32Array.from({ length: m.positions.length / 3 }, (_, i) => i);
    const listed = Array.isArray(m.extras?.faces) ? m.extras.faces as unknown[] : [];
    // Each triangle's face: by our extras' ranges, by Draco's per-vertex faces, else none.
    const faceOf = new Int32Array(ix.length / 3).fill(-1);
    if (m.vertexFaces) {
      for (let t = 0; t < faceOf.length; t++) {
        const f = m.vertexFaces[ix[3 * t]!]!;
        if (f < listed.length) faceOf[t] = f;
      }
    } else listed.forEach((r, k) => {
      const start = num(obj(r)?.start), count = num(obj(r)?.count);
      if (start === undefined || count === undefined) return;
      for (let t = start / 3; t < (start + count) / 3 && t < faceOf.length; t++) faceOf[t] = k;
    });
    const groupOf = (t: number) => m.groups.find((g) => 3 * t >= g.start && 3 * t < g.start + g.count);
    // Triangles by face, in the faces' order (then those of none), each face's run contiguous.
    const order = Array.from(faceOf.keys()).sort((a, b) => (faceOf[a]! < 0 ? 1e9 : faceOf[a]!) -
      (faceOf[b]! < 0 ? 1e9 : faceOf[b]!) || a - b);
    let run = -2;
    for (const t of order) {
      const f = faceOf[t]!;
      if (f !== run) {
        run = f;
        const source = f < 0 ? null : num(obj(listed[f])?.source) ?? null;
        faces.push({ source, start: indices.length, count: 0 });
        if (source !== null) faceMaterial.set(source, groupOf(t)?.material);
      }
      faces.at(-1)!.count += 3;
      const g = groupOf(t);
      const last = groups.at(-1);
      if (last && last.material === g?.material && last.start + last.count === indices.length) last.count += 3;
      else groups.push({ start: indices.length, count: 3, ...(g?.material ? { material: g.material } : {}) });
      indices.push(base + ix[3 * t]!, base + ix[3 * t + 1]!, base + ix[3 * t + 2]!);
    }
    base += m.positions.length / 3;
  }
  // Without faces of our extras: no face ranges (a mesh of one unknown face).
  const known = faces.some((f) => f.source !== null);
  const mesh: Mesh = { origin: [0, 0, 0], positions, indices: Uint32Array.from(indices), faces: known ? faces : [] };
  if (normals) mesh.normals = normals;
  return { mesh, faceMaterial, groups };
}

/** Our part node's level: its triangles, and its children's edges, curves and points. */
function ourLevel(node: TreeNode, b: Builder): { lod: Lod; appearance: Appearance } {
  const tri = triangles(node.meshes.filter((m) => m.mode === 'triangles'));
  const mesh = tri.mesh;
  let lineMaterial: TreeMaterial | undefined;
  for (const c of node.children) {
    for (const m of c.meshes) {
      if (c.name === 'edges' && m.mode === 'lines') {
        mesh.edgePositions = m.positions;
        mesh.edges = polylines(m, m.extras?.edges).map((l) => ({ source: l.source, start: l.start, count: l.count,
          kind: (['shared', 'seam', 'free', 'degenerate'].includes(l.kind ?? '') ? l.kind : 'shared') as 'shared',
          ...(l.dihedral !== undefined ? { dihedral: l.dihedral } : {}) }));
      } else if (c.name === 'curves' && m.mode === 'lines') {
        mesh.curvePositions = m.positions;
        mesh.curves = polylines(m, m.extras?.curves).map((l) => ({ source: l.source, start: l.start,
          count: l.count }));
        lineMaterial ??= m.groups[0]?.material;
      } else if (c.name === 'points' && m.mode === 'points') {
        mesh.points = m.positions;
        const sources = Array.isArray(m.extras?.points) ? m.extras.points as unknown[] : [];
        mesh.pointSources = Array.from({ length: m.positions.length / 3 }, (_, i) => num(sources[i]) ?? null);
        lineMaterial ??= m.groups[0]?.material;
      }
    }
  }
  // The default material: the curves' and points' (the exporters give them the part's), else the faces' commonest.
  const faces = new Map<number, number | undefined>();
  for (const [f, m] of tri.faceMaterial) faces.set(f, b.material(m));
  let material = b.material(lineMaterial);
  if (material === undefined) {
    const counts = new Map<number | undefined, number>();
    for (const g of tri.groups) counts.set(b.material(g.material), (counts.get(b.material(g.material)) ?? 0) + g.count);
    material = [...counts].sort((x, y) => y[1] - x[1])[0]?.[0];
  }
  // Faces without an id and a material of their own can't keep it (it takes an id): said once per part.
  if (!mesh.faces.length && new Set(tri.groups.map((g) => g.material?.key)).size > 1) b.warn(
    `part '${node.name}': several materials and no face ids; drawn in one`);
  return { lod: { mesh, from: 'source' }, appearance: { material, faces } };
}

/** A part node's placement: its part reference's own data from our extras, at the node's transform. */
function placementOf(ch: TreeNode, part: number): PartRef {
  const { index: _, ...own } = placementFrom(ch.extras?.placement);
  return { part, transform: ch.matrix, ...own };
}

/** Our part node's part, made at its first placement. */
function ourPart(ch: TreeNode, b: Builder): number {
  // (The node named as its placement is; the part's own name in our extras, from 2026-11-01.)
  const name = typeof ch.extras?.partName === 'string' ? ch.extras.partName : ch.name;
  return b.part(`ours:${num(ch.extras?.part)}`, () => ({ name, sources: sourcesOf(ch.extras?.sources),
    properties: propertiesOf(ch.extras?.properties), unit: unitFrom(ch.extras?.unit), origin: [0, 0, 0] as Vec3,
    lods: [],
    ...(typeof ch.extras?.closed === 'boolean' ? { closed: ch.extras.closed } : {}),
    ...(measuresFrom(ch.extras?.measures) ? { measures: measuresFrom(ch.extras?.measures)! } : {}) }));
}

/** A part node's level and appearance at a placement (path and reference), hidden as the node is. */
function ourPlacement(ch: TreeNode, ref: PartRef, b: Builder, path: number[], r: number): void {
  const part = b.parts[ref.part]!;
  const level = ourLevel(ch, b);
  if (!part.lods.length) part.lods.push({ ...level.lod, ...levelFrom(ch.extras?.level) });
  b.appearance(ref.part, level.appearance, path, r);
  if (!ch.visible) b.overrides.push({ path, ref: r, visible: false, sources: [] });
}

/** Our tree: components by their index, parts by theirs, instances' differences as overrides. */
function fromOurs(root: TreeNode, b: Builder): { roots: Occurrence[]; rootParts: PartRef[] } {
  interface Comp { key: string; comp: Component; refKeys: Placed[]; childKeys: Placed[] }
  const comps = new Map<string, Comp>();
  // (By node too, for visiting each instance.)
  const byNode = new Map<TreeNode, Comp>();
  const isPart = (n: TreeNode) => num(n.extras?.part) !== undefined;
  const compOf = (n: TreeNode): number | undefined => num(obj(n.extras?.component)?.index);
  const occurrence = (n: TreeNode, component: number, compName: string): Occurrence => ({ component,
    transform: n.matrix, ...(n.name !== compName ? { name: n.name } : {}),
    sources: sourcesOf(n.extras?.sources), properties: propertiesOf(n.extras?.properties) });
  // (A child's index in its parent component, the last of its path, where it has one: siblings alike in name and
  // place, as nodes made again for instanced placements are, stay apart.)
  const childId = (n: TreeNode) => `${compOf(n) ?? n.name}|${n.name}|${Array.isArray(n.extras?.path)
    ? (n.extras.path as unknown[]).at(-1) : ''}`;
  const refId = (n: TreeNode) => `${num(n.extras?.part)}|${placementFrom(n.extras?.placement).index ?? ''}`;

  // The component of a tree node (made at its first instance), with the union of its instances' parts and children.
  // A node without our component index (one the export pruned, made again) is one by its slot in its parent's
  // component, so every instance of the parent shares it.
  const component = (n: TreeNode, slot: string): Comp => {
    const ci = compOf(n);
    const key = ci !== undefined ? `${ci}` : slot;
    let c = comps.get(key);
    if (!c) {
      const ce = obj(n.extras?.component);
      const external = obj(n.extras?.external);
      const comp: Component = { name: typeof ce?.name === 'string' ? ce.name : n.name, sources: sourcesOf(ce?.sources),
        properties: propertiesOf(ce?.properties), parts: [], children: [],
        ...(external && typeof external.uri === 'string' ? { external: { uri: external.uri,
          ...(typeof external.format === 'string' ? { format: external.format } : {}) } } : {}) };
      b.components.push(comp);
      comps.set(key, (c = { key, comp, refKeys: [], childKeys: [] }));
    }
    byNode.set(n, c);
    // (Each of this instance's references and children matched once: two placements alike are two.)
    const usedRefs = new Set<number>(), usedChildren = new Set<number>();
    for (const ch of n.children) {
      if (isPart(ch)) {
        const r = find(c.refKeys, refId(ch), ch.matrix, usedRefs);
        if (r >= 0) { usedRefs.add(r); continue; }
        usedRefs.add(c.refKeys.length);
        c.refKeys.push({ id: refId(ch), matrix: ch.matrix });
        c.comp.parts.push(placementOf(ch, ourPart(ch, b)));
      } else {
        // (Matched or not, its own references and children joined to its component's.)
        const k = find(c.childKeys, childId(ch), ch.matrix, usedChildren);
        const sub = component(ch, `${c.key}/${k >= 0 ? k : c.childKeys.length}`);
        if (k >= 0) { usedChildren.add(k); continue; }
        usedChildren.add(c.childKeys.length);
        c.childKeys.push({ id: childId(ch), matrix: ch.matrix });
        c.comp.children.push(occurrence(ch, b.components.indexOf(sub.comp), sub.comp.name));
      }
    }
    return c;
  };
  // The roots, likewise a union (one per root node of the file).
  const rootKeys: Placed[] = [];
  const roots: Occurrence[] = [];
  const rootNodes = root.children.filter((n) => !isPart(n));
  const usedRoots = new Set<number>();
  for (const n of rootNodes) {
    const k = find(rootKeys, childId(n), n.matrix, usedRoots);
    const c = component(n, `root/${k >= 0 ? k : rootKeys.length}`);
    if (k >= 0) { usedRoots.add(k); continue; }
    usedRoots.add(rootKeys.length);
    rootKeys.push({ id: childId(n), matrix: n.matrix });
    roots.push(occurrence(n, b.components.indexOf(c.comp), c.comp.name));
  }
  // The root parts (the scene's: one instance), in order.
  const rootParts = root.children.filter(isPart).map((ch) => placementOf(ch, ourPart(ch, b)));
  root.children.filter(isPart).forEach((ch, r) => ourPlacement(ch, rootParts[r]!, b, [], r));

  // Each instance: its parts' levels (made at their first placement) and appearances, what it lacks hidden.
  const visit = (n: TreeNode, path: number[]) => {
    const c = byNode.get(n)!;
    const present = new Set<number>();
    for (const ch of n.children) {
      if (isPart(ch)) {
        // (Matched as component() matched them: in order, each once.)
        const r = find(c.refKeys, refId(ch), ch.matrix, present);
        present.add(r);
        ourPlacement(ch, c.comp.parts[r]!, b, path, r);
      }
    }
    c.comp.parts.forEach((_, r) => {
      if (!present.has(r)) b.overrides.push({ path, ref: r, visible: false, sources: [] });
    });
    const seen = new Set<number>();
    for (const ch of n.children) {
      if (isPart(ch)) continue;
      const k = find(c.childKeys, childId(ch), ch.matrix, seen);
      seen.add(k);
      visit(ch, [...path, k]);
    }
    c.comp.children.forEach((_, k) => {
      if (!seen.has(k)) b.overrides.push({ path: [...path, k], visible: false, sources: [] });
    });
  };
  const rootsSeen = new Set<number>();
  for (const n of rootNodes) {
    const k = find(rootKeys, childId(n), n.matrix, rootsSeen);
    rootsSeen.add(k);
    visit(n, [k]);
  }
  return { roots, rootParts };
}

/**
 * A file's own tree: a node with meshes and nothing below it but its own `edges`, `curves` and `points` (as our
 * exporters write a placed part) is a placed part, a part reference in its parent's component, its meshes one part
 * (merged: shared wherever the file reuses the same meshes); every other node a component placed once, its own meshes
 * parts. A mesh's triangle groups (a glTF mesh's primitives, a three.js geometry's groups) are its part's faces,
 * numbered from 0 in order, each with its material. `container`: the root is the file's scene, its children the roots
 * (glTF's scene, three.js's Scene object), each turned by `frame`; else the root is a node, turned by it.
 */
function fromOthers(root: TreeNode, b: Builder, frame: Mat4, container: boolean): { roots: Occurrence[];
  rootParts: PartRef[] } {
  /** The part a placed part's node draws (its meshes and its lines children's, merged). */
  const leafPart = (n: TreeNode): number => {
    // (One mesh alone: its key, so a component holding the same mesh shares the part.)
    const key = n.meshes.length === 1 && !n.children.length ? n.meshes[0]!.key : `leaf:${[...n.meshes.map((m) =>
      m.key), ...n.children.map((c) => `${c.name}:${c.meshes.map((m) => m.key).join(',')}`)].join('|')}`;
    return b.part(key, () => {
      const { mesh, materials } = mergedMesh(n);
      const material = materials[0];
      const faceMaterials = materials.flatMap((x, face) => (face > 0 && x !== undefined && x !== material
        ? [{ face, material: x }] : []));
      return { name: n.name || 'part', sources: [], properties: {}, unit: 1, origin: [0, 0, 0] as Vec3,
        lods: [{ mesh, from: 'source' as const }], ...(material !== undefined ? { material } : {}),
        ...(faceMaterials.length ? { faceMaterials } : {}) };
    });
    function mergedMesh(node: TreeNode): { mesh: Mesh; materials: (number | undefined)[] } {
      const tris = node.meshes.filter((m) => m.mode === 'triangles');
      const lines = [...node.meshes.filter((m) => m.mode === 'lines').map((m) => ({ m, matrix: identity() })),
        ...node.children.filter((c) => c.name === 'curves').flatMap((c) => c.meshes.map((m) => ({ m,
          matrix: c.matrix })))];
      const points = [...node.meshes.filter((m) => m.mode === 'points').map((m) => ({ m, matrix: identity() })),
        ...node.children.filter((c) => c.name === 'points').flatMap((c) => c.meshes.map((m) => ({ m,
          matrix: c.matrix })))];
      const edges = node.children.filter((c) => c.name === 'edges');
      const materials: (number | undefined)[] = [];
      let mesh: Mesh;
      if (tris.length === 1) {
        mesh = otherMesh(tris[0]!);
        const groups = tris[0]!.groups;
        for (const g of groups.length > 1 ? groups : groups.slice(0, 1)) materials.push(b.material(g.material));
      } else {
        // (Several meshes: each group of each a face, so their materials stay apart.)
        const pos: number[] = [], nor: number[] = [], ix: number[] = [];
        const faces: Mesh['faces'] = [];
        const normals = tris.length > 0 && tris.every((m) => m.normals);
        for (const m of tris) {
          const base = pos.length / 3;
          pos.push(...m.positions);
          if (normals) nor.push(...m.normals!);
          const all = m.indices ?? Uint32Array.from({ length: m.positions.length / 3 }, (_, i) => i);
          const groups = m.groups.length ? m.groups : [{ start: 0, count: all.length }];
          for (const g of groups) {
            faces.push({ source: faces.length, start: ix.length, count: g.count });
            for (let k = g.start; k < g.start + g.count; k++) ix.push(base + all[k]!);
            materials.push(b.material((g as { material?: TreeMaterial }).material));
          }
        }
        mesh = { origin: [0, 0, 0], positions: Float32Array.from(pos), indices: Uint32Array.from(ix), faces };
        if (normals) mesh.normals = Float32Array.from(nor);
      }
      if (edges.length && mesh.indices.length) Object.assign(mesh, edgesOf(edges));
      const placed = (list: { m: TreeMesh; matrix: Mat4 }[], pairs: boolean): number[] => list.flatMap(({ m,
        matrix }) => {
        const ix = m.indices ?? Uint32Array.from({ length: m.positions.length / 3 }, (_, i) => i);
        const out: number[] = [];
        for (let k = 0; k < (pairs ? ix.length - (ix.length % 2) : ix.length); k++) {
          const v = ix[k]!;
          const [x, y, z] = [m.positions[3 * v]!, m.positions[3 * v + 1]!, m.positions[3 * v + 2]!];
          for (let r = 0; r < 3; r++) {
            out.push(matrix[r]! * x + matrix[4 + r]! * y + matrix[8 + r]! * z + matrix[12 + r]!);
          }
        }
        return out;
      });
      if (lines.length) {
        const c = placed(lines, true);
        mesh.curvePositions = Float32Array.from(c);
        mesh.curves = Array.from({ length: c.length / 6 }, (_, k) => ({ source: null, start: 2 * k, count: 2 }));
        if (!tris.length) materials.push(b.material(lines[0]!.m.groups[0]?.material));
      }
      if (points.length) {
        const q = placed(points, false);
        mesh.points = Float32Array.from(q);
        mesh.pointSources = Array<null>(q.length / 3).fill(null);
        if (!tris.length && !lines.length) materials.push(b.material(points[0]!.m.groups[0]?.material));
      }
      return { mesh, materials };
    }
  };
  const ref = (n: TreeNode, transform: Mat4): PartRef => ({ part: leafPart(n), transform,
    ...(n.name ? { name: n.name } : {}), ...(n.visible ? {} : { visible: false }) });
  const visit = (n: TreeNode, path: number[]): number => {
    const comp: Component = { name: n.name, sources: [], properties: {}, parts: [], children: [] };
    const index = b.components.length;
    b.components.push(comp);
    // (A child named `edges` holding only lines, as our exporters write a part's B-rep edges without extras: the
    // edges of the node's one triangle mesh, not a part of its own.)
    const tris = n.meshes.filter((m) => m.mode === 'triangles');
    const edgeNodes = tris.length === 1 ? n.children.filter((c) => c.name === 'edges' && !c.children.length &&
      c.meshes.length > 0 && c.meshes.every((m) => m.mode === 'lines')) : [];
    for (const m of n.meshes) {
      const edges = m.mode === 'triangles' ? edgeNodes : [];
      const key = edges.length ? `${m.key}|${edges.map((c) => c.meshes.map((l) => l.key).join(',')).join(';')}`
        : m.key;
      const part = b.part(key, () => {
        const mesh = otherMesh(m);
        if (edges.length) Object.assign(mesh, edgesOf(edges));
        const materials = (m.mode === 'triangles' && m.groups.length > 1 ? m.groups : m.groups.slice(0, 1))
          .map((g) => b.material(g.material));
        const material = materials[0];
        const faceMaterials = materials.flatMap((x, face) => (face > 0 && x !== undefined && x !== material
          ? [{ face, material: x }] : []));
        return { name: n.name || m.mode, sources: [], properties: {}, unit: 1, origin: [0, 0, 0] as Vec3,
          lods: [{ mesh, from: 'source' as const }], ...(material !== undefined ? { material } : {}),
          ...(faceMaterials.length ? { faceMaterials } : {}) };
      });
      comp.parts.push({ part, transform: identity() });
    }
    if (!n.visible) b.overrides.push({ path, visible: false, sources: [] });
    let k = 0;
    for (const c of n.children.filter((x) => !edgeNodes.includes(x))) {
      if (isPlacedPart(c)) {
        comp.parts.push(ref(c, c.matrix));
        continue;
      }
      const child = visit(c, [...path, k++]);
      comp.children.push({ component: child, transform: c.matrix, ...(c.name ? { name: c.name } : {}), sources: [],
        properties: {} });
    }
    return index;
  };
  const roots: Occurrence[] = [], rootParts: PartRef[] = [];
  for (const n of container ? root.children : [root]) {
    const transform = multiply(frame, container ? n.matrix : root.matrix);
    if (isPlacedPart(n)) rootParts.push(ref(n, transform));
    else {
      const top = visit(n, [roots.length]);
      roots.push({ component: top, transform, ...(container && n.name ? { name: n.name } : {}), sources: [],
        properties: {} });
    }
  }
  return { roots, rootParts };
}

/** A placed part's node: meshes, and below it only its own `edges`, `curves` and `points` (lines and points). */
function isPlacedPart(n: TreeNode): boolean {
  const own = (c: TreeNode) => ['edges', 'curves', 'points'].includes(c.name) && !c.children.length &&
    c.meshes.length > 0 && c.meshes.every((m) => m.mode !== 'triangles');
  return n.meshes.length > 0 && n.children.every(own);
}

/** Lines nodes' segments as a mesh's edges, in the parent node's frame (each node's matrix applied). */
function edgesOf(nodes: TreeNode[]): Pick<Mesh, 'edgePositions' | 'edges'> {
  const out: number[] = [];
  for (const n of nodes) for (const l of n.meshes) {
    const ix = l.indices ?? Uint32Array.from({ length: l.positions.length / 3 }, (_, i) => i);
    const m = n.matrix;
    for (let k = 0; k + 1 < ix.length; k += 2) for (const v of [ix[k]!, ix[k + 1]!]) {
      const [x, y, z] = [l.positions[3 * v]!, l.positions[3 * v + 1]!, l.positions[3 * v + 2]!];
      for (let r = 0; r < 3; r++) out.push(m[r]! * x + m[4 + r]! * y + m[8 + r]! * z + m[12 + r]!);
    }
  }
  return { edgePositions: Float32Array.from(out), edges: Array.from({ length: out.length / 6 }, (_, k) => ({
    source: null, start: 2 * k, count: 2, kind: 'shared' as const })) };
}

/**
 * A foreign mesh as a level: its triangles, a face per group where it has several (in the groups' order), or its
 * lines or points.
 */
function otherMesh(m: TreeMesh): Mesh {
  const ix = m.indices ?? Uint32Array.from({ length: m.positions.length / 3 }, (_, i) => i);
  const empty = { origin: [0, 0, 0] as Vec3, positions: new Float32Array(0), indices: new Uint32Array(0), faces: [] };
  if (m.mode === 'points') return { ...empty, points: m.positions, pointSources: Array<null>(m.positions.length / 3)
    .fill(null) };
  if (m.mode === 'lines') {
    const curves = [];
    for (let k = 0; k + 1 < ix.length; k += 2) curves.push({ source: null, start: curves.length * 2, count: 2 });
    const pos = new Float32Array(3 * (ix.length - (ix.length % 2)));
    for (let k = 0; k < pos.length / 3; k++) pos.set(m.positions.subarray(3 * ix[k]!, 3 * ix[k]! + 3), 3 * k);
    return { ...empty, curvePositions: pos, curves };
  }
  const groups = m.groups.length > 1 ? m.groups : [{ start: 0, count: ix.length }];
  const indices = new Uint32Array(groups.reduce((n, g) => n + g.count, 0));
  const faces: Mesh['faces'] = [];
  let at = 0;
  groups.forEach((g, k) => {
    indices.set(ix.subarray(g.start, g.start + g.count), at);
    faces.push({ source: k, start: at, count: g.count });
    at += g.count;
  });
  const mesh: Mesh = { origin: [0, 0, 0], positions: m.positions, indices, faces: m.groups.length > 1 ? faces : [] };
  if (m.normals) mesh.normals = m.normals;
  return mesh;
}

/**
 * A root frame's turn alone (each column scaled to length 1, no translation), or undefined where it doesn't turn: the
 * file's axes in the scene's (Scene.fileAxes).
 */
export function axesOf(frame: Mat4): Mat4 | undefined {
  const m = new Float64Array(16);
  m[15] = 1;
  for (let c = 0; c < 3; c++) {
    const len = Math.hypot(frame[c * 4]!, frame[c * 4 + 1]!, frame[c * 4 + 2]!);
    for (let r = 0; r < 3; r++) m[c * 4 + r] = len > 0 ? frame[c * 4 + r]! / len : 0;
  }
  const turns = [0, 1, 2].some((c) => [0, 1, 2].some((r) => Math.abs(m[c * 4 + r]! - (r === c ? 1 : 0)) > 1e-12));
  return turns ? m : undefined;
}

/**
 * The scene a tree holds: ours read back as written, others as their own tree, `frame` taking the root's frame to
 * millimetres, Z up (default MM_Z_UP: metres, Y up, as glTF and three.js are). `properties` are the file's own
 * metadata, the scene's; but ours with the properties of the scene we exported have those, the file's own as their
 * `container`.
 */
export function sceneFromTree(root: TreeNode, opts: { frame?: Mat4; container?: boolean; properties?: Properties } =
  {}): { scene: Scene; diagnostics: Diagnostic[] } {
  const b = new Builder();
  const ours = isOurTree(root);
  b.ours = ours;
  // (Ours in a container, as written since 2026-11-01: no root node of ours, each top node turned to metres and Y
  // up itself; turned back here, the rest read as below our old root node.)
  const tops = ours && opts.container ? { ...root, children: root.children.map((c) => ({ ...c,
    matrix: multiply(opts.frame ?? MM_Z_UP, c.matrix) })) } : root;
  const { roots, rootParts } = ours ? fromOurs(tops, b) : fromOthers(root, b, opts.frame ?? MM_Z_UP,
    opts.container ?? false);
  const scene: Scene = {
    unit: 'millimetre', components: b.components, roots, ...(rootParts.length ? { rootParts } : {}), parts: b.parts,
    materials: b.materials, layers: [],
    overrides: b.overrides, properties: propertiesFrom(ours ? propertiesOf(root.extras?.properties) : {},
      opts.properties ?? {}), diagnostics: b.diagnostics,
  };
  const bounds = ours ? boundsFrom(root.extras?.bounds) : undefined;
  if (bounds) scene.bounds = bounds;
  // The source's unit: our extras' (the file we exported from), else the format's (metres; `frame` scales by it).
  const unit = ours ? num(root.extras?.sourceUnit) : Math.hypot(...Array.from((opts.frame ?? MM_Z_UP).slice(0, 3)));
  if (unit !== undefined && unit > 0) scene.sourceUnit = unit;
  const axes = axesOf(opts.frame ?? MM_Z_UP);
  if (axes) scene.fileAxes = axes;
  // (Our files written before 2026-11-01 placed a leaf product as a component holding its part.)
  leafParts(scene);
  return { scene, diagnostics: b.diagnostics };
}
