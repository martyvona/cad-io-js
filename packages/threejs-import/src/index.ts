// three.js JSON (Object Scene format 4, as Object3D.toJSON and our exporter write it) to the scene model (the user,
// 2026-10-29; CLAUDE.md, "Decisions": importers for every format): the file's objects as a tree of nodes and meshes,
// which cad-scene's sceneFromTree turns into a scene, ours (with our userData) as written, others as their own tree.
// Geometries are BufferGeometry (other kinds, made from parameters, are skipped with a warning); materials give a
// colour (sRGB, as the file holds it) and opacity; textures aren't supported (said, and ignored: the user,
// 2026-10-29).

import { boundScene, dropSourceDegenerate, identity, sceneFromTree, type Diagnostic, type Scene, type TreeMaterial,
  type TreeMesh, type TreeNode } from 'cad-scene';

export interface ThreejsImport {
  scene: Scene;
  diagnostics: Diagnostic[];
}

type Json = { [key: string]: unknown };
const obj = (v: unknown): Json | undefined => (v && typeof v === 'object' && !Array.isArray(v) ? v as Json
  : undefined);
const numbers = (v: unknown): number[] | undefined => (Array.isArray(v) && v.every((x) => typeof x === 'number')
  ? v as number[] : undefined);

const MESH_TYPES: Record<string, TreeMesh['mode']> = { Mesh: 'triangles', SkinnedMesh: 'triangles',
  InstancedMesh: 'triangles', LineSegments: 'lines', Line: 'lines', LineLoop: 'lines', Points: 'points' };

export interface ThreejsImportOptions {
  /**
   * Drop triangles with two corners at one position from the file's meshes (cad-scene's dropSourceDegenerate), with
   * an info diagnostic per part. Default true; false keeps every triangle the file gives.
   */
  dropDegenerate?: boolean;
}

/** Reads three.js JSON (its text, bytes or parsed object). Problems in the file are diagnostics. */
export function importThreejs(input: string | Uint8Array | object, opts: ThreejsImportOptions = {}): ThreejsImport {
  const diagnostics: Diagnostic[] = [];
  const warn = (message: string) => diagnostics.push({ severity: 'warning', message });
  let json: Json | undefined;
  try {
    json = obj(typeof input === 'string' ? JSON.parse(input) : input instanceof Uint8Array
      ? JSON.parse(new TextDecoder().decode(input)) : input);
  } catch (e) {
    diagnostics.push({ severity: 'error', message: `not JSON: ${(e as Error).message}` });
  }
  const root = obj(json?.object);
  if (!json || !root) {
    if (json) diagnostics.push({ severity: 'error', message: 'no object: not three.js JSON (Object Scene format)' });
    // (Said in the scene too, as the scene's diagnostics are what readers keep.)
    const { scene } = sceneFromTree({ name: '', matrix: identity(), visible: true, meshes: [], children: [] });
    scene.diagnostics.push(...diagnostics);
    return { scene, diagnostics: scene.diagnostics };
  }

  const geometries = new Map<string, Json>();
  for (const g of Array.isArray(json.geometries) ? json.geometries : []) {
    const o = obj(g);
    if (o && typeof o.uuid === 'string') geometries.set(o.uuid, o);
  }
  const materials = new Map<string, TreeMaterial & { textured: boolean }>();
  for (const m of Array.isArray(json.materials) ? json.materials : []) {
    const o = obj(m);
    if (!o || typeof o.uuid !== 'string') continue;
    const hex = typeof o.color === 'number' ? o.color : 0xcccccc;
    const index = typeof obj(o.userData)?.material === 'number' ? obj(o.userData)!.material as number : undefined;
    materials.set(o.uuid, { key: o.uuid, ...(typeof o.name === 'string' && o.name ? { name: o.name } : {}),
      color: [((hex >> 16) & 255) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255],
      opacity: typeof o.opacity === 'number' ? o.opacity : 1, ...(index !== undefined ? { index } : {}),
      textured: ['map', 'normalMap', 'emissiveMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'alphaMap', 'bumpMap']
        .some((k) => typeof o[k] === 'string') });
  }
  if ((Array.isArray(json.textures) && json.textures.length) || [...materials.values()].some((m) => m.textured)) {
    warn('textures are not supported: ignored');
  }
  const skipped = new Set<string>();

  /** A geometry's arrays: position, normal, index, groups. */
  const arrays = (uuid: string) => {
    const g = geometries.get(uuid);
    const data = obj(g?.data);
    if (!g || !data || (g.type !== 'BufferGeometry' && g.type !== undefined)) {
      if (g && !skipped.has(String(g.type))) {
        skipped.add(String(g.type));
        warn(`geometries of type ${String(g.type)}: not read`);
      }
      return undefined;
    }
    const attrs = obj(data.attributes);
    const position = numbers(obj(attrs?.position)?.array);
    if (!position || (obj(attrs?.position)?.itemSize ?? 3) !== 3) return undefined;
    const normal = numbers(obj(attrs?.normal)?.array);
    const index = numbers(obj(data.index)?.array);
    const groups = (Array.isArray(data.groups) ? data.groups : []).flatMap((x) => {
      const o = obj(x);
      return o && typeof o.start === 'number' && typeof o.count === 'number' ? [{ start: o.start, count: o.count,
        materialIndex: typeof o.materialIndex === 'number' ? o.materialIndex : 0 }] : [];
    });
    return { positions: Float32Array.from(position), ...(normal && normal.length === position.length
      ? { normals: Float32Array.from(normal) } : {}), ...(index ? { indices: Uint32Array.from(index) } : {}),
    groups, extras: obj(data.userData) ?? obj(g.userData) };
  };

  const node = (o: Json): TreeNode => {
    const meshes: TreeMesh[] = [];
    const mode = typeof o.type === 'string' ? MESH_TYPES[o.type] : undefined;
    if (mode && typeof o.geometry === 'string') {
      const a = arrays(o.geometry);
      if (a) {
        const mats = (Array.isArray(o.material) ? o.material : [o.material]).map((u) => (typeof u === 'string'
          ? materials.get(u) : undefined));
        const count = a.indices?.length ?? a.positions.length / 3;
        const groups = a.groups.length && mode === 'triangles' ? a.groups.map((g) => ({ start: g.start, count: g.count,
          ...(mats[g.materialIndex] ? { material: mats[g.materialIndex]! } : {}) }))
          : [{ start: 0, count, ...(mats[0] ? { material: mats[0] } : {}) }];
        let indices = a.indices;
        // A strip or loop as segment pairs.
        if (o.type === 'Line' || o.type === 'LineLoop') {
          const n = count + (o.type === 'LineLoop' ? 1 : 0);
          const at = (k: number) => (a.indices ? a.indices[k % count]! : k % count);
          indices = Uint32Array.from({ length: 2 * Math.max(0, n - 1) }, (_, k) => at((k >> 1) + (k & 1)));
        }
        const extras = obj(o.userData);
        meshes.push({ key: `${o.geometry}|${(Array.isArray(o.material) ? o.material : [o.material]).join(',')}`, mode,
          positions: a.positions, ...(a.normals ? { normals: a.normals } : {}), ...(indices ? { indices } : {}),
          groups, ...(extras ? { extras } : {}) });
      }
    }
    const matrix = numbers(o.matrix);
    const name = typeof o.name === 'string' ? o.name : '';
    // An instanced mesh: a child node per instance, at its matrix (applied before the object's own).
    const instances = o.type === 'InstancedMesh' ? numbers(obj(o.instanceMatrix)?.array) : undefined;
    const count = Math.min(typeof o.count === 'number' ? o.count : Infinity, (instances?.length ?? 0) / 16);
    const each: TreeNode[] = instances && meshes.length ? Array.from({ length: count }, (_, k) => ({
      name: `${name || 'instance'} ${k + 1}`, matrix: Float64Array.from(instances.slice(16 * k, 16 * k + 16)),
      visible: true, meshes, children: [] })) : [];
    if (o.type === 'InstancedMesh' && !each.length && meshes.length) warn(`'${name}': instanced mesh without ` +
      'instance matrices: read once');
    return { name, matrix: matrix && matrix.length === 16 ? Float64Array.from(matrix) : identity(),
      visible: o.visible !== false, ...(obj(o.userData) ? { extras: obj(o.userData) } : {}),
      meshes: each.length ? [] : meshes, children: [...each, ...(Array.isArray(o.children) ? o.children : [])
        .flatMap((c) => (obj(c) ? [node(obj(c)!)] : []))] };
  };
  const tree = node(root);
  // (Files written with our extras before 2026-10-24 say millimetres and no up axis at their root, and were in
  // millimetres, the source's axes, with no root matrix: read as they are.)
  const old = obj(root.userData)?.unit === 'millimetre' && obj(root.userData)?.up === undefined;
  const { scene } = sceneFromTree(tree, old ? { frame: identity() } : {});
  // The reader's, then the tree's (the scene's own list).
  scene.diagnostics.unshift(...diagnostics);
  if (opts.dropDegenerate ?? true) dropSourceDegenerate(scene);
  boundScene(scene);
  return { scene, diagnostics: scene.diagnostics };
}
