// Our own 3MF files with extras (export-3mf's `cadio:tree` and `cadio:materials` metadata) read back as the scene
// they were written from (the user, 2026-10-29; CLAUDE.md, "Decisions": 3MF import, decision 4): the tree the
// metadata describes, made a TreeNode tree as glTF and three.js JSON files give one, its placed parts' meshes from
// their build items' objects, and cad-scene's sceneFromTree the rest (components by our index, parts by ours, what
// one placement shows differently an override). What 3MF can't hold stays lost: faces are by colour (mesh.ts), and
// there are no edges, curves or points. Our files without extras are read as anyone's (the user, 2026-10-29).

import { identity, multiply, sceneFromTree, type Diagnostic, type Mat4, type Scene, type TreeExtras,
  type TreeMaterial, type TreeMesh, type TreeNode } from 'cad-scene';
import type { ModelFile, ObjectDef } from './model.ts';

/** An affine transform's inverse (its linear part inverted, then the translation). */
export function invertAffine(m: Mat4): Mat4 {
  const [a, b, c, d, e, f, g, h, i] = [m[0]!, m[1]!, m[2]!, m[4]!, m[5]!, m[6]!, m[8]!, m[9]!, m[10]!];
  const det = a * (e * i - f * h) - d * (b * i - c * h) + g * (b * f - c * e);
  const r = Float64Array.of((e * i - f * h) / det, (c * h - b * i) / det, (b * f - c * e) / det, 0,
    (f * g - d * i) / det, (a * i - c * g) / det, (c * d - a * f) / det, 0,
    (d * h - e * g) / det, (b * g - a * h) / det, (a * e - b * d) / det, 0, 0, 0, 0, 1);
  for (let k = 0; k < 3; k++) r[12 + k] = -(r[k]! * m[12]! + r[4 + k]! * m[13]! + r[8 + k]! * m[14]!);
  return r;
}

const obj = (v: unknown): TreeExtras | undefined => (v && typeof v === 'object' && !Array.isArray(v)
  ? v as TreeExtras : undefined);
const matrixOf = (v: unknown): Mat4 | undefined => (Array.isArray(v) && v.length === 16 && v.every(Number.isFinite)
  ? Float64Array.from(v as number[]) : undefined);

/**
 * The scene of our file with extras, or undefined (and a warning) if its tree can't be read. `world` gives a build
 * item's placement of its object, in millimetres, from the object's numbers.
 */
export function oursFromTree(root: ModelFile, world: (item: number) => { object: ObjectDef; matrix: Mat4 }
  | undefined, warn: (m: string) => void): { scene: Scene; diagnostics: Diagnostic[] } | undefined {
  let tree: TreeExtras | undefined, slots: unknown[] = [];
  try {
    tree = obj(JSON.parse(root.metadata['cadio:tree']!));
    const s = JSON.parse(root.metadata['cadio:materials'] ?? '[]');
    if (Array.isArray(s)) slots = s;
  } catch (e) {
    warn(`our tree metadata (cadio:tree) isn't JSON (${(e as Error).message}): read as written`);
    return undefined;
  }
  if (!tree || !Array.isArray(tree.roots)) {
    warn('our tree metadata (cadio:tree) has no roots: read as written');
    return undefined;
  }
  const group = root.groups.get(1);
  // A part's colour faces as one mesh with a group per face, each the material its colour slot was.
  const meshOf = (o: ObjectDef): TreeMesh[] => {
    if (!o.mesh) return [];
    const { mesh, faceProperties } = o.mesh;
    const groups = mesh.faces.map((f, k) => {
      const p = faceProperties[k];
      const entry = p && p[0] === 1 ? group?.entries[p[1]] : undefined;
      const index = p ? slots[p[1]] : undefined;
      const material: TreeMaterial | undefined = entry ? { key: `${p![0]}:${p![1]}`, color: entry.color,
        opacity: entry.opacity, ...(entry.name ? { name: entry.name } : {}),
        ...(typeof index === 'number' ? { index } : {}) } : undefined;
      return { start: f.start, count: f.count, ...(material ? { material } : {}) };
    });
    return [{ key: `${o.id}`, mode: 'triangles', positions: mesh.positions, normals: mesh.normals,
      indices: mesh.indices, groups, extras: { faces: mesh.faces.map((f) => ({ source: f.source, start: f.start,
        count: f.count })) } }];
  };
  let bad = 0;
  const node = (j: unknown, parentWorld: Mat4): TreeNode | undefined => {
    const n = obj(j), matrix = matrixOf(n?.matrix);
    if (!n || !matrix) { bad++; return undefined; }
    const w = multiply(parentWorld, matrix);
    const parts = (Array.isArray(n.parts) ? n.parts : []).flatMap((pj): TreeNode[] => {
      const p = obj(pj);
      const placed = typeof p?.item === 'number' ? world(p.item) : undefined;
      if (!p || !placed) { bad++; return []; }
      // Its mesh is about its new origin: where the item puts that, relative to the node.
      const o = placed.object.mesh?.mesh.origin ?? [0, 0, 0];
      const at = identity();
      at[12] = o[0]; at[13] = o[1]; at[14] = o[2];
      return [{ name: typeof p.name === 'string' ? p.name : '', matrix: multiply(invertAffine(w),
        multiply(placed.matrix, at)), visible: p.visible !== false, extras: obj(p.extras),
      meshes: meshOf(placed.object), children: [] }];
    });
    const children = (Array.isArray(n.children) ? n.children : []).flatMap((c) => node(c, w) ?? []);
    return { name: typeof n.name === 'string' ? n.name : '', matrix, visible: true, extras: obj(n.extras),
      meshes: [], children: [...parts, ...children] };
  };
  const roots = tree.roots.flatMap((r) => node(r, identity()) ?? []);
  if (bad) warn(`our tree metadata (cadio:tree): ${bad} nodes or placed parts unreadable or naming no build item, `
    + 'left out');
  return sceneFromTree({ name: '', matrix: identity(), visible: true, extras: { unit: 'millimetre', up: 'z',
    ...(obj(tree.properties) ? { properties: tree.properties } : {}) }, meshes: [], children: roots });
}
