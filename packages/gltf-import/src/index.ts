// glTF 2.0 (GLB, or .gltf JSON with its buffers) to the scene model (the user, 2026-10-29; CLAUDE.md, "Decisions":
// importers for every format), read with glTF-Transform: the default scene as a tree of nodes and meshes, which
// cad-scene's sceneFromTree turns into a scene, ours (with our extras) as written, others as their own tree.
//
//   compression: Draco (KHR_draco_mesh_compression) and meshopt (EXT_meshopt_compression, KHR_mesh_quantization)
//     decoded on reading; quantized positions read normalized, their scale in the node's matrix.
//   our extras, beyond three.js JSON's: with Draco, faces by the `_FACE` vertex attribute; hidden placements
//     (KHR_node_visibility) hidden, and left out ones (hidden instances are by default) restored hidden; instanced
//     placements (EXT_mesh_gpu_instancing) put back where their extras say (`path`, `names`), with their edges,
//     curves and points (nodes of their own under the root), the tree nodes left empty by them made again.
//   materials: base colour factors are linear (glTF's specification), read back to sRGB, except Onshape's, which
//     are sRGB already (as the viewer found, 2026-10-27); textures aren't supported (said, and ignored).

import { WebIO, type Accessor, type Document, type Material as GltfMaterial, type Node,
  type Primitive } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { identity, multiply, sceneFromTree, type Diagnostic, type Mat4, type Scene, type TreeExtras,
  type TreeMaterial, type TreeMesh, type TreeNode, type Vec3 } from 'cad-scene';

export interface GltfImport {
  scene: Scene;
  diagnostics: Diagnostic[];
}

/** A .gltf's JSON (text or parsed) and the files it names (`.bin`, by its URI); data URIs need none. */
export interface GltfJsonInput {
  json: string | object;
  resources?: Record<string, Uint8Array>;
}

/** Writers that put sRGB in glTF's linear colour factors (by `asset.generator`): Onshape's. */
export function srgbFactorsFrom(generator: string | undefined): boolean {
  return /onshape/i.test(generator ?? '');
}

const linearToSrgb = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);
const obj = (v: unknown): TreeExtras | undefined => (v && typeof v === 'object' && !Array.isArray(v)
  ? v as TreeExtras : undefined);

let draco: Promise<unknown> | undefined;
let meshopt: Promise<unknown> | undefined;

/**
 * The reader, with the decoders a file needs (imported only then), its messages diagnostics (glTF-Transform's own
 * logger prints them).
 */
async function io(used: readonly string[], diagnostics: Diagnostic[]): Promise<WebIO> {
  const say = (severity: Diagnostic['severity']) => (message: string) => diagnostics.push({ severity,
    message: `glTF reader: ${message}` });
  const io = new WebIO().setLogger({ debug: () => {}, info: () => {}, warn: say('info'), error: say('warning') })
    .registerExtensions(ALL_EXTENSIONS);
  const deps: Record<string, unknown> = {};
  if (used.includes('KHR_draco_mesh_compression')) {
    draco ??= import('draco3dgltf').then((m) => m.default.createDecoderModule());
    deps['draco3d.decoder'] = await draco;
  }
  if (used.includes('EXT_meshopt_compression')) {
    meshopt ??= import('meshoptimizer').then(async (m) => { await m.MeshoptDecoder.ready; return m.MeshoptDecoder; });
    deps['meshopt.decoder'] = await meshopt;
  }
  return io.registerDependencies(deps);
}

/** An accessor's elements as floats (normalized integers read as glTF says: KHR_mesh_quantization's included). */
function floats(a: Accessor): Float32Array {
  const n = a.getCount(), size = a.getElementSize();
  const out = new Float32Array(n * size);
  const el: number[] = [];
  for (let i = 0; i < n; i++) {
    a.getElement(i, el);
    for (let k = 0; k < size; k++) out[i * size + k] = el[k]!;
  }
  return out;
}

const MODES: Record<number, TreeMesh['mode']> = { 0: 'points', 1: 'lines', 2: 'lines', 3: 'lines', 4: 'triangles',
  5: 'triangles', 6: 'triangles' };

/** A primitive's indices as triangles or segment pairs (strips, fans and loops unrolled). */
function indicesOf(p: Primitive, vertices: number): Uint32Array {
  const ix = p.getIndices();
  const raw = ix ? Uint32Array.from(ix.getArray() as ArrayLike<number>) : Uint32Array.from({ length: vertices },
    (_, i) => i);
  const mode = p.getMode();
  if (mode === 5) return Uint32Array.from({ length: 3 * Math.max(0, raw.length - 2) }, (_, k) => {
    const t = Math.floor(k / 3), c = k % 3;
    // (Every other triangle turned, so all wind alike.)
    return raw[t + (t % 2 === 1 && c > 0 ? 3 - c : c)]!;
  });
  if (mode === 6) return Uint32Array.from({ length: 3 * Math.max(0, raw.length - 2) }, (_, k) => {
    const t = Math.floor(k / 3), c = k % 3;
    return raw[c === 0 ? 0 : t + c]!;
  });
  if (mode === 2 || mode === 3) {
    const n = raw.length + (mode === 2 ? 1 : 0);
    return Uint32Array.from({ length: 2 * Math.max(0, n - 1) }, (_, k) => raw[((k >> 1) + (k & 1)) % raw.length]!);
  }
  return raw;
}

/** A matrix's inverse (affine). */
function invert(m: Mat4): Mat4 {
  const [a, b, c, d, e, f, g, h, i] = [m[0]!, m[1]!, m[2]!, m[4]!, m[5]!, m[6]!, m[8]!, m[9]!, m[10]!];
  const det = a * (e * i - f * h) - d * (b * i - c * h) + g * (b * f - c * e);
  const r = [(e * i - f * h) / det, (c * h - b * i) / det, (b * f - c * e) / det,
    (f * g - d * i) / det, (a * i - c * g) / det, (c * d - a * f) / det,
    (d * h - e * g) / det, (b * g - a * h) / det, (a * e - b * d) / det];
  const t = [m[12]!, m[13]!, m[14]!];
  const out = identity();
  for (let col = 0; col < 3; col++) for (let row = 0; row < 3; row++) out[4 * col + row] = r[3 * col + row]!;
  for (let row = 0; row < 3; row++) {
    out[12 + row] = -(out[row]! * t[0]! + out[4 + row]! * t[1]! + out[8 + row]! * t[2]!);
  }
  return out;
}

/** A TRS's matrix, column-major. */
function trs(t: ArrayLike<number>, r: ArrayLike<number>, s: ArrayLike<number>): Mat4 {
  const [x, y, z, w] = [r[0]!, r[1]!, r[2]!, r[3]!];
  const m = Float64Array.of(
    (1 - 2 * (y * y + z * z)) * s[0]!, 2 * (x * y + z * w) * s[0]!, 2 * (x * z - y * w) * s[0]!, 0,
    2 * (x * y - z * w) * s[1]!, (1 - 2 * (x * x + z * z)) * s[1]!, 2 * (y * z + x * w) * s[1]!, 0,
    2 * (x * z + y * w) * s[2]!, 2 * (y * z - x * w) * s[2]!, (1 - 2 * (x * x + y * y)) * s[2]!, 0,
    t[0]!, t[1]!, t[2]!, 1);
  return m;
}

/** Reads a GLB (bytes), or a .gltf's JSON with its resources. Problems in the file are diagnostics. */
export async function importGltf(input: Uint8Array | GltfJsonInput): Promise<GltfImport> {
  const diagnostics: Diagnostic[] = [];
  const warn = (message: string) => diagnostics.push({ severity: 'warning', message });
  const empty = () => ({ scene: sceneFromTree({ name: '', matrix: identity(), visible: true, meshes: [],
    children: [] }).scene, diagnostics });
  let doc: Document;
  // (The writer, from the file's own JSON: glTF-Transform's reader names itself the generator.)
  let generator: string | undefined;
  try {
    if (input instanceof Uint8Array) {
      // (The JSON chunk's extensionsUsed, for the decoders to load.)
      const json = input.length > 20 ? new TextDecoder().decode(input.subarray(20, 20 +
        new DataView(input.buffer, input.byteOffset).getUint32(12, true))) : '{}';
      const head = JSON.parse(json) as { extensionsUsed?: string[]; asset?: { generator?: string } };
      generator = head.asset?.generator;
      doc = await (await io(head.extensionsUsed ?? [], diagnostics)).readBinary(input);
    } else {
      const json = (typeof input.json === 'string' ? JSON.parse(input.json) : input.json) as
        { extensionsUsed?: string[]; buffers?: { uri?: string }[]; asset?: { generator?: string } };
      generator = json.asset?.generator;
      // Data URIs as resources (the reader takes files only).
      const resources = { ...input.resources };
      for (const b of json.buffers ?? []) {
        if (b.uri?.startsWith('data:') && !resources[b.uri]) {
          const base64 = b.uri.slice(b.uri.indexOf(',') + 1);
          resources[b.uri] = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
        }
      }
      doc = await (await io(json.extensionsUsed ?? [], diagnostics)).readJSON({ json: json as never,
        resources: resources as never });
    }
  } catch (e) {
    diagnostics.push({ severity: 'error', message: `not glTF, or not readable: ${(e as Error).message}` });
    return empty();
  }
  const root = doc.getRoot();
  if (root.listTextures().length) warn('textures are not supported: ignored');
  const srgb = srgbFactorsFrom(generator);
  if (srgb) diagnostics.push({ severity: 'info', message:
    `colours read as sRGB: ${generator} writes them so (glTF's are linear)` });

  const ids = new Map<object, number>();
  const id = (o: object) => { let i = ids.get(o); if (i === undefined) ids.set(o, (i = ids.size)); return i; };
  const materials = new Map<GltfMaterial, TreeMaterial>();
  const material = (m: GltfMaterial | null): TreeMaterial | undefined => {
    if (!m) return undefined;
    let t = materials.get(m);
    if (!t) {
      const [r, g, b, a] = m.getBaseColorFactor();
      const index = obj(m.getExtras())?.material;
      t = { key: `m${id(m)}`, ...(m.getName() ? { name: m.getName() } : {}),
        color: (srgb ? [r, g, b] : [r, g, b].map(linearToSrgb)) as Vec3,
        opacity: m.getAlphaMode() === 'BLEND' ? a : 1, ...(typeof index === 'number' ? { index } : {}) };
      materials.set(m, t);
    }
    return t;
  };
  const meshesOf = (n: Node): TreeMesh[] => {
    const mesh = n.getMesh();
    if (!mesh) return [];
    return mesh.listPrimitives().flatMap((p, k) => {
      const pos = p.getAttribute('POSITION');
      const mode = MODES[p.getMode()];
      if (!pos || !mode) return [];
      const positions = floats(pos);
      const normal = p.getAttribute('NORMAL');
      const face = p.getAttribute('_FACE');
      const indices = indicesOf(p, pos.getCount());
      const extras = obj(p.getExtras());
      const m = material(p.getMaterial());
      return [{ key: `${id(mesh)}:${k}`, mode, positions, ...(normal && mode === 'triangles'
        ? { normals: floats(normal) } : {}), indices, groups: [{ start: 0, count: indices.length,
        ...(m ? { material: m } : {}) }], ...(extras && Object.keys(extras).length ? { extras } : {}),
      ...(face ? { vertexFaces: face.getArray() as ArrayLike<number> } : {}) }];
    });
  };
  const visible = (n: Node) => (n.getExtension('KHR_node_visibility') as { getVisible(): boolean } | null)
    ?.getVisible() !== false;
  const instanced = (n: Node) => n.getExtension('EXT_mesh_gpu_instancing') as {
    getAttribute(s: string): Accessor | null } | null;
  const tree = (n: Node): TreeNode => ({
    name: n.getName(), matrix: Float64Array.from(n.getMatrix()), visible: visible(n),
    ...(Object.keys(n.getExtras()).length ? { extras: n.getExtras() as TreeExtras } : {}),
    meshes: meshesOf(n), children: n.listChildren().map(tree),
  });

  const scene = root.getDefaultScene() ?? root.listScenes()[0];
  const tops = scene?.listChildren() ?? [];
  // Ours: one root node with our extras; else a root of the scene's nodes.
  const ours = tops.length === 1 && obj(tops[0]!.getExtras())?.unit === 'millimetre';
  const top: TreeNode = ours ? tree(tops[0]!) : { name: scene?.getName() ?? '', matrix: identity(), visible: true,
    meshes: [], children: tops.map(tree) };
  if (ours) restoreInstances(tops[0]!, top, instanced, warn);
  else if (tops.some((n) => n.listChildren().some(instanced) || instanced(n))) {
    warn('GPU instances (EXT_mesh_gpu_instancing) read once each, not at every instance');
  }
  const built = sceneFromTree(top);
  built.scene.diagnostics.unshift(...diagnostics);
  return { scene: built.scene, diagnostics: built.scene.diagnostics };
}

/**
 * Our instanced placements back in the tree: each instance of an instanced node (its extras' `instances`: the
 * placement's tree path and the names along it) a part node at its world transform, in the node its path names
 * (made again, empty, where the export left it out), with the edges, curves and points of the placement's own node
 * under the root (its extras' `instance`).
 */
function restoreInstances(rootNode: Node, root: TreeNode, instanced: (n: Node) => { getAttribute(s: string):
  Accessor | null } | null, warn: (m: string) => void): void {
  const nodes = rootNode.listChildren();
  const isLines = (n: TreeNode) => obj(n.extras?.instance) !== undefined;
  const pathKey = (p: unknown) => (Array.isArray(p) ? p.join('/') : '');
  // The tree nodes by path, and their world transforms below the root.
  const byPath = new Map<string, { node: TreeNode; world: Mat4 }>();
  const index = (n: TreeNode, world: Mat4) => {
    const w = multiply(world, n.matrix);
    if (Array.isArray(n.extras?.path)) byPath.set(pathKey(n.extras.path), { node: n, world: w });
    n.children.forEach((c) => index(c, w));
  };
  root.children.forEach((c) => index(c, identity()));
  // The lines of instanced placements, found by path and world transform (to 1e-5 relative: the instances' float32
  // translation, rotation and scale against the lines' node's matrix).
  const lines = root.children.filter(isLines);
  const close = (a: Mat4, b: Mat4) => a.every((x, i) => Math.abs(x - b[i]!) <= 1e-5 * Math.max(1, Math.abs(x),
    Math.abs(b[i]!)));
  const own = (path: unknown, m: Mat4) => lines.find((n) => pathKey(obj(n.extras!.instance)!.path) === pathKey(path) &&
    close(n.matrix, m));
  const kept: TreeNode[] = [];
  nodes.forEach((gn, i) => {
    const tn = root.children[i]!;
    const gi = instanced(gn);
    const items = Array.isArray(tn.extras?.instances) ? tn.extras.instances as unknown[] : undefined;
    if (isLines(tn)) return;
    if (!gi || !items) { kept.push(tn); return; }
    const [t, r, s] = ['TRANSLATION', 'ROTATION', 'SCALE'].map((a) => gi.getAttribute(a));
    const { instances: _, ...partExtras } = tn.extras!;
    items.forEach((item, k) => {
      const o = obj(item);
      const world = multiply(tn.matrix, trs(t ? t.getElement(k, []) : [0, 0, 0], r ? r.getElement(k, [])
        : [0, 0, 0, 1], s ? s.getElement(k, []) : [1, 1, 1]));
      const path = Array.isArray(o?.path) ? o.path as number[] : [];
      const names = Array.isArray(o?.names) ? o.names as string[] : [];
      // The node at the path, or made again from the nearest one above, with the names along the path.
      let at = byPath.get(pathKey(path));
      if (!at) {
        let d = path.length - 1;
        while (d > 0 && !byPath.has(pathKey(path.slice(0, d)))) d--;
        let parent = byPath.get(pathKey(path.slice(0, d)));
        if (!parent) {
          // (The root of the path: a node of the root's.)
          const made: TreeNode = { name: names[0] ?? '', matrix: identity(), visible: true,
            extras: { path: path.slice(0, 1) }, meshes: [], children: [] };
          kept.push(made);
          parent = { node: made, world: identity() };
          byPath.set(pathKey(path.slice(0, 1)), parent);
          d = 1;
        }
        for (; d < path.length; d++) {
          const made: TreeNode = { name: names[d] ?? '', matrix: identity(), visible: true,
            extras: { path: path.slice(0, d + 1) }, meshes: [], children: [] };
          parent.node.children.push(made);
          parent = { node: made, world: parent.world };
          byPath.set(pathKey(path.slice(0, d + 1)), parent);
        }
        at = parent;
      }
      at.node.children.push({ name: tn.name, matrix: multiply(invert(at.world), world), visible: tn.visible,
        extras: partExtras, meshes: tn.meshes, children: own(path, world)?.children ?? [] });
    });
  });
  if (nodes.length !== root.children.length) warn('the root\'s nodes and the tree disagree: instances not restored');
  root.children = kept;
}
