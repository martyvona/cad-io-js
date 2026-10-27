// Scene model -> glTF 2.0, written with glTF-Transform: GLB, or .gltf JSON with its buffer as a separate .bin or
// embedded as base64. See README.md, "`stepconv`", and CLAUDE.md, "Decisions".
//
//   nodes: a root node turning the scene's millimetres, Z up, into glTF's metres, Y up; under it a node per
//     instance-tree node (its local transform), and per placed part a node with the part's faces; its children
//     `edges`, `curves` and `points` (on request) each have their own mesh, as three.js has child objects.
//   meshes: the faces' mesh one per look, shared by every instance with that look, a TRIANGLES primitive per material
//     group; B-rep edges and wireframe curves as LINES and isolated points as POINTS, each a mesh shared by the
//     instances with the same part mesh and colour. Looks of one part mesh share its vertex accessors.
//   materials: pbrMetallicRoughness base colours (STEP's sRGB converted to linear), not metallic, fully rough (as
//     three.js's MeshStandardMaterial defaults), alpha blended when transparent; edges, curves and points optionally
//     KHR_materials_unlit.
//   extras (on request): names, source ids and properties; per triangle primitive its faces' sources, as index
//     ranges, or with Draco (which reorders triangles) as a `_FACE` vertex attribute indexing them, for picking.
//   compression (decided by the user, 2026-10-24): Draco by default (KHR_draco_mesh_compression, triangles only,
//     positions to 14 bits over the part mesh's extent, normals to 10), meshopt by option (EXT_meshopt_compression
//     on every buffer, with KHR_mesh_quantization: positions to 16 bits over each part mesh's extent, the scale and
//     offset in the part's node, normals to 8-bit octahedral; triangles reordered for the vertex cache only within
//     each face, so the face ranges hold), or none.
//
// Hidden part instances are left out (glTF core has no visibility), or with `hidden: 'extension'` written with
// KHR_node_visibility (decided by the user, 2026-10-21). Tree nodes with nothing to draw beneath them are left out
// unless `keepEmpty` (the user, 2026-10-24).
//
// Instancing (by option, decided by the user, 2026-10-24): every look placed more than once (as many times visible or
// hidden) becomes one node under the root with EXT_mesh_gpu_instancing (required: it has no fallback), its faces'
// mesh drawn at each placement's world transform; the placements leave the tree, with their occurrence names. Their
// edges, curves and points stay ordinary nodes, one per placement under the root, as three.js's GLTFLoader (0.186)
// instances only triangles. Mirrored or sheared placements, which TRS can't hold, stay in the tree. With extras, the
// instanced node's extras list each instance's tree path, names and occurrence sources in attribute order.

import { Document, Format, Logger, WebIO, type Accessor, type JSONDocument, type Buffer,
  type Material as GltfMaterial, type Mesh as GltfMesh, type Node, type TypedArray,
  type mat4 } from '@gltf-transform/core';
import { EXTMeshGPUInstancing, EXTMeshoptCompression, KHRDracoMeshCompression, KHRMaterialsUnlit,
  KHRMeshQuantization, KHRNodeVisibility } from '@gltf-transform/extensions';
import { identity, multiply, pruneView, Y_UP_METRES, type Diagnostic, type ExportNode, type ExportView, type Look,
  type Mat4, type Mesh, type Part, type PropertyValue, type Scene, type SourceId, type Vec3 } from 'cad-scene';

/** A part's `closed` for extras, where the source says it (cad-scene's Part.closed). */
const closedOf = (part: Part): { closed?: boolean } => (part.closed === undefined ? {} : { closed: part.closed });

export interface GltfOptions {
  /** Colour of faces, curves and points without a material (sRGB). Default light grey. */
  defaultColor?: Vec3;
  /** Colour of B-rep edges (sRGB). Default black. */
  edgeColor?: Vec3;
  /**
   * B-rep edge kinds to write, when the view has edges. Default shared and free (seams and degenerate edges hidden).
   */
  edgeKinds?: readonly ('shared' | 'seam' | 'free' | 'degenerate')[];
  /** Materials render both sides of faces. Default false. */
  doubleSided?: boolean;
  /** Name of the scene and its root node. */
  name?: string;
  /** Hidden part instances: left out (default), or written hidden with KHR_node_visibility. */
  hidden?: 'omit' | 'extension';
  /** Leave these out even when the view has them. */
  exclude?: readonly LineKind[];
  /** Edges, curves and points with KHR_materials_unlit (drawn in their flat colour). Default false. */
  unlitLines?: boolean;
  /** Geometry compression. Default 'draco'. */
  compression?: Compression;
  /**
   * Draco's position quantization, in bits over the extent of each primitive's vertex array (1 to 30): the part mesh's,
   * which its primitives share. Default 14.
   */
  dracoPositionBits?: number;
  /**
   * Our extras: source ids, properties, parts and whether they're closed (`closed`, where the source says) on nodes,
   * scene material indices on materials, face, edge, curve and point sources on primitives, and the root's unit and
   * up axis. Default false: other systems don't read them.
   */
  extras?: boolean;
  /** Each look placed more than once as one node with EXT_mesh_gpu_instancing, out of the tree. Default false. */
  instancing?: boolean;
  /** Keep tree nodes with nothing to draw beneath them. Default false. */
  keepEmpty?: boolean;
}

export type LineKind = 'edges' | 'curves' | 'points';
export type Compression = 'draco' | 'meshopt' | 'none';

export interface GltfResult {
  document: Document;
  /** Hidden instances left out, as a warning. */
  diagnostics: Diagnostic[];
}

/** Output the options can't give: more faces in a primitive than Draco's `_FACE` attribute can number. */
export class GltfError extends Error {
  override name = 'GltfError';
}

/** The most faces a primitive can have with Draco and extras: `_FACE` is 16 bits, and 65535 marks unused vertices. */
export const MAX_DRACO_FACES = 65535;

/** Millimetres to metres, and Z up to Y up: (x, y, z) mm -> (x, z, -y) m. Column-major (cad-scene's `Y_UP_METRES`). */
export const ROOT_TRANSFORM: Mat4 = Y_UP_METRES;

/**
 * The scene's export view as a glTF-Transform document, with the compression's extensions set: writing it compresses
 * only with their encoders registered (`draco3d.encoder` from draco3dgltf, `meshopt.encoder` from meshoptimizer).
 */
export async function gltfDocument(scene: Scene, view: ExportView, opts: GltfOptions = {}): Promise<GltfResult> {
  const compression = opts.compression ?? 'draco';
  if (!['draco', 'meshopt', 'none'].includes(compression)) throw new GltfError(`unknown compression '${compression}'`);
  const bits = opts.dracoPositionBits ?? 14;
  if (!(Number.isInteger(bits) && bits >= 1 && bits <= 30)) throw new GltfError(
    `dracoPositionBits must be a whole number from 1 to 30, not ${bits}`);
  const reorder = compression === 'meshopt' ? (await meshoptEncoder()).reorderMesh : undefined;
  return new Writer(scene, view, opts, reorder).write();
}

/** The scene's export view as GLB. */
export async function glb(scene: Scene, view: ExportView, opts: GltfOptions = {}): Promise<{ bytes: Uint8Array;
  diagnostics: Diagnostic[] }> {
  const { document, diagnostics } = await gltfDocument(scene, view, opts);
  const { json, resources } = await write(document, Format.GLB);
  return { bytes: packGlb(json, Object.values(resources)[0]), diagnostics };
}

/**
 * The scene's export view as .gltf JSON and its buffer, which the JSON names `bin` (a URI relative to the JSON); with
 * `bin` undefined, the buffer is embedded in the JSON as a base64 data URI (a third bigger; the JSON is one string,
 * so a buffer beyond about 400 MB exceeds V8's string limit) and `bin` is empty.
 */
export async function gltfJson(scene: Scene, view: ExportView, bin: string | undefined,
  opts: GltfOptions = {}): Promise<{ json: string; bin: Uint8Array; diagnostics: Diagnostic[] }> {
  const { document, diagnostics } = await gltfDocument(scene, view, opts);
  const uri = bin ?? 'buffer.bin';
  for (const b of document.getRoot().listBuffers()) b.setURI(uri);
  const { json, resources } = await write(document, Format.GLTF);
  const bytes = resources[uri] ?? new Uint8Array();
  if (bin !== undefined) return { json: JSON.stringify(json), bin: bytes, diagnostics };
  for (const b of json.buffers ?? []) b.uri = `data:application/octet-stream;base64,${base64(bytes)}`;
  return { json: JSON.stringify(json), bin: new Uint8Array(), diagnostics };
}

/** Base64, in pieces (String.fromCharCode takes a limited number of arguments). */
export function base64(bytes: Uint8Array): string {
  const parts: string[] = [];
  for (let i = 0; i < bytes.length; i += 3 * 8192) parts.push(
    btoa(String.fromCharCode(...bytes.subarray(i, i + 3 * 8192))));
  return parts.join('');
}

type MeshoptEncoderModule = typeof import('meshoptimizer').MeshoptEncoder;
type ReorderMesh = MeshoptEncoderModule['reorderMesh'];
let dracoEncoder: Promise<unknown> | undefined;

/** meshoptimizer's encoder (WebAssembly), imported only when used. */
async function meshoptEncoder(): Promise<MeshoptEncoderModule> {
  const { MeshoptEncoder } = await import('meshoptimizer');
  await MeshoptEncoder.ready;
  return MeshoptEncoder;
}

/** The encoders a document's compression needs, loaded once each. */
async function encoders(document: Document): Promise<Record<string, unknown>> {
  const used = document.getRoot().listExtensionsUsed().map((e) => e.extensionName);
  const deps: Record<string, unknown> = {};
  if (used.includes(KHRDracoMeshCompression.EXTENSION_NAME)) {
    dracoEncoder ??= import('draco3dgltf').then((m) => m.default.createEncoderModule());
    deps['draco3d.encoder'] = await dracoEncoder;
  }
  if (used.includes(EXTMeshoptCompression.EXTENSION_NAME)) deps['meshopt.encoder'] = await meshoptEncoder();
  return deps;
}

/**
 * glTF-Transform's JSON for a document, with each node's translation, rotation and scale as they are: its writer
 * leaves out any within 1e-5 of the default, which drops rotations of up to about 2e-5 rad (20 um a metre away)
 * and scales within 1e-5 of 1 (CLAUDE.md, "JavaScript, Node and the libraries").
 */
async function write(document: Document, format: Format): Promise<JSONDocument> {
  const out = await new WebIO().setLogger(new Logger(Logger.Verbosity.ERROR))
    .registerExtensions([KHRMaterialsUnlit, KHRNodeVisibility, EXTMeshGPUInstancing, KHRDracoMeshCompression,
      EXTMeshoptCompression, KHRMeshQuantization])
    .registerDependencies(await encoders(document)).writeJSON(document, { format });
  const nodes = document.getRoot().listNodes(); // the writer's order
  out.json.nodes?.forEach((def, i) => {
    const n = nodes[i]!;
    const t = n.getTranslation(), r = n.getRotation(), sc = n.getScale();
    delete def.translation; delete def.rotation; delete def.scale;
    if (t.some((x) => x !== 0)) def.translation = t;
    if (r[0] !== 0 || r[1] !== 0 || r[2] !== 0 || r[3] !== 1) def.rotation = r;
    if (sc.some((x) => x !== 1)) def.scale = sc;
  });
  return out;
}

/** GLB: a 12-byte header, the JSON chunk (padded with spaces), the BIN chunk (padded with zeros) if there is one. */
function packGlb(json: unknown, bin: Uint8Array | undefined): Uint8Array {
  const pad = (n: number) => (n + 3) & ~3;
  const text = new TextEncoder().encode(JSON.stringify(json));
  const jsonLength = pad(text.length), binLength = bin?.length ? pad(bin.length) : 0;
  const total = 12 + 8 + jsonLength + (binLength ? 8 + binLength : 0);
  const out = new Uint8Array(total);
  const v = new DataView(out.buffer);
  v.setUint32(0, 0x46546c67, true); // 'glTF'
  v.setUint32(4, 2, true);
  v.setUint32(8, total, true);
  v.setUint32(12, jsonLength, true);
  v.setUint32(16, 0x4e4f534a, true); // 'JSON'
  out.set(text, 20);
  out.fill(0x20, 20 + text.length, 20 + jsonLength);
  if (binLength) {
    const at = 20 + jsonLength;
    v.setUint32(at, binLength, true);
    v.setUint32(at + 4, 0x004e4942, true); // 'BIN'
    out.set(bin!, at + 8);
  }
  return out;
}

/**
 * An affine matrix as glTF's translation, rotation (a unit quaternion, x y z w) and scale; undefined when it has shear,
 * a mirror or a zero scale, which TRS can't hold (instancing).
 */
export function decompose(m: Mat4): { t: Vec3; r: [number, number, number, number]; s: Vec3 } | undefined {
  const c = [0, 4, 8].map((k) => [m[k]!, m[k + 1]!, m[k + 2]!]);
  const s = c.map((v) => Math.hypot(v[0]!, v[1]!, v[2]!)) as Vec3;
  if (!s.every((x) => x > 0)) return undefined;
  const dot = (i: number, j: number) => c[i]![0]! * c[j]![0]! + c[i]![1]! * c[j]![1]! + c[i]![2]! * c[j]![2]!;
  if (Math.abs(dot(0, 1)) > 1e-9 * s[0] * s[1] || Math.abs(dot(0, 2)) > 1e-9 * s[0] * s[2]
    || Math.abs(dot(1, 2)) > 1e-9 * s[1] * s[2]) return undefined;
  const r = c.map((v, i) => v.map((x) => x / s[i]!)); // r[col][row]
  const det = r[0]![0]! * (r[1]![1]! * r[2]![2]! - r[2]![1]! * r[1]![2]!)
    - r[1]![0]! * (r[0]![1]! * r[2]![2]! - r[2]![1]! * r[0]![2]!)
    + r[2]![0]! * (r[0]![1]! * r[1]![2]! - r[1]![1]! * r[0]![2]!);
  if (det <= 0) return undefined;
  const e = (row: number, col: number) => r[col]![row]!;
  // From the largest of the four candidates, for precision.
  const tr = e(0, 0) + e(1, 1) + e(2, 2);
  let q: [number, number, number, number];
  if (tr > 0) {
    const k = 2 * Math.sqrt(tr + 1);
    q = [(e(2, 1) - e(1, 2)) / k, (e(0, 2) - e(2, 0)) / k, (e(1, 0) - e(0, 1)) / k, k / 4];
  } else if (e(0, 0) > e(1, 1) && e(0, 0) > e(2, 2)) {
    const k = 2 * Math.sqrt(1 + e(0, 0) - e(1, 1) - e(2, 2));
    q = [k / 4, (e(0, 1) + e(1, 0)) / k, (e(0, 2) + e(2, 0)) / k, (e(2, 1) - e(1, 2)) / k];
  } else if (e(1, 1) > e(2, 2)) {
    const k = 2 * Math.sqrt(1 + e(1, 1) - e(0, 0) - e(2, 2));
    q = [(e(0, 1) + e(1, 0)) / k, k / 4, (e(1, 2) + e(2, 1)) / k, (e(0, 2) - e(2, 0)) / k];
  } else {
    const k = 2 * Math.sqrt(1 + e(2, 2) - e(0, 0) - e(1, 1));
    q = [(e(0, 2) + e(2, 0)) / k, (e(1, 2) + e(2, 1)) / k, k / 4, (e(1, 0) - e(0, 1)) / k];
  }
  const n = Math.hypot(...q);
  return { t: [m[12]!, m[13]!, m[14]!], r: q.map((x) => x / n) as typeof q, s };
}

/** sRGB to linear, as glTF's base colour factor is linear. */
export function srgbToLinear(c: number): number {
  const v = Math.min(1, Math.max(0, c));
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

/** Segment pairs for a set of polylines, and each polyline's range of index entries. */
function segments(lines: { start: number; count: number }[]): { index: Uint32Array;
  ranges: { start: number; count: number }[] } {
  let n = 0;
  for (const l of lines) n += Math.max(0, l.count - 1) * 2;
  const index = new Uint32Array(n);
  const ranges: { start: number; count: number }[] = [];
  let at = 0;
  for (const l of lines) {
    const start = at;
    for (let k = 0; k + 1 < l.count; k++) { index[at++] = l.start + k; index[at++] = l.start + k + 1; }
    ranges.push({ start, count: at - start });
  }
  return { index, ranges };
}

/** Indices as 16 bits when every vertex fits (65535 is the primitive restart value, so not as an index). */
function indexArray(indices: Uint32Array, vertices: number): Uint16Array | Uint32Array {
  return vertices <= 65535 ? Uint16Array.from(indices) : indices;
}

/**
 * Triangles reordered for the GPU's vertex cache (meshoptimizer's reorderMesh) within each face range, so the ranges
 * stay valid. Each face alone, with its vertices numbered from 0 as reorderMesh wants, then numbered back.
 */
export function reorderWithinFaces(indices: Uint32Array, faces: readonly { start: number; count: number }[],
  reorderMesh: ReorderMesh): Uint32Array {
  const out = indices.slice();
  for (const f of faces) {
    const sub = out.slice(f.start, f.start + f.count);
    const local = new Map<number, number>(), back: number[] = [];
    for (let i = 0; i < sub.length; i++) {
      let v = local.get(sub[i]!);
      if (v === undefined) { local.set(sub[i]!, (v = back.length)); back.push(sub[i]!); }
      sub[i] = v;
    }
    const [remap] = reorderMesh(sub, true, false); // reorders sub, renumbering its vertices by remap
    const inv = new Uint32Array(back.length);
    for (let v = 0; v < remap.length; v++) if (remap[v] !== 0xffffffff) inv[remap[v]!] = v;
    for (let i = 0; i < sub.length; i++) out[f.start + i] = back[inv[sub[i]!]!]!;
  }
  return out;
}

/** Vertex numbers in order of first use by `indices`, then the unused ones in their order: old -> new. */
function firstUse(indices: Uint32Array, vertices: number): Uint32Array {
  const order = new Uint32Array(vertices).fill(0xffffffff);
  let next = 0;
  for (const v of indices) if (order[v] === 0xffffffff) order[v] = next++;
  for (let v = 0; v < vertices; v++) if (order[v] === 0xffffffff) order[v] = next++;
  return order;
}

/** A part mesh's quantization volume: a centre and a half-width, the same on every axis (so normals keep). */
interface Volume { center: Vec3; half: number }

function volume(mesh: Mesh): Volume {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const a of [mesh.positions, mesh.edgePositions, mesh.curvePositions, mesh.points]) {
    if (!a) continue;
    for (let i = 0; i < a.length; i++) {
      lo[i % 3] = Math.min(lo[i % 3]!, a[i]!);
      hi[i % 3] = Math.max(hi[i % 3]!, a[i]!);
    }
  }
  if (lo[0] === Infinity) return { center: [0, 0, 0], half: 1 };
  const half = Math.max(hi[0]! - lo[0]!, hi[1]! - lo[1]!, hi[2]! - lo[2]!) / 2;
  return { center: [(lo[0]! + hi[0]!) / 2, (lo[1]! + hi[1]!) / 2, (lo[2]! + hi[2]!) / 2], half: half || 1 };
}

/** Positions as normalized 16-bit integers in a volume (vertex v moved to order[v] when given). */
function quantize(src: Float32Array, v: Volume, order?: Uint32Array): Int16Array {
  const out = new Int16Array(src.length);
  for (let i = 0; i < src.length / 3; i++) {
    const j = order ? order[i]! : i;
    for (let k = 0; k < 3; k++) out[3 * j + k] = Math.round((src[3 * i + k]! - v.center[k]!) / v.half * 32767);
  }
  return out;
}

/** A vec3 array with vertex v moved to order[v]. */
function permute(src: Float32Array, order: Uint32Array): Float32Array {
  const out = new Float32Array(src.length);
  for (let i = 0; i < src.length / 3; i++) out.set(src.subarray(3 * i, 3 * i + 3), 3 * order[i]!);
  return out;
}

/** The node matrix that takes a volume's normalized coordinates back to the mesh's. */
function dequantization(v: Volume): Mat4 {
  return Float64Array.of(v.half, 0, 0, 0, 0, v.half, 0, 0, 0, 0, v.half, 0, v.center[0], v.center[1], v.center[2], 1);
}

type Json = { [key: string]: PropertyValue | Json | Json[] | number[] | undefined };
type Placed = ExportNode['parts'][number];
/** An instanced look's placements, in tree order, with their world transforms (below the root) and tree nodes. */
interface Instances { look: number; visible: boolean; items: { node: ExportNode; names: string[]; world: Mat4 }[] }

class Writer {
  private readonly doc = new Document();
  private readonly buffer: Buffer;
  private readonly diagnostics: Diagnostic[] = [];
  private visibility?: KHRNodeVisibility;
  private gpuInstancing?: EXTMeshGPUInstancing;
  private instanced = new Set<Placed>();
  private unlit?: KHRMaterialsUnlit;
  private materials = new Map<string, GltfMaterial>();
  private meshes = new Map<number, GltfMesh | undefined>();
  private lineMeshes = new Map<string, GltfMesh>();
  private meshIds = new Map<Mesh, number>();
  private readonly exclude: ReadonlySet<LineKind>;
  private vertices = new Map<Float32Array, Accessor>();
  private indexAccessors = new Map<Uint32Array, Map<string, Accessor>>();
  private faceAttributes = new Map<Uint32Array, Map<string, { face: Accessor; positions?: Accessor;
    normals?: Accessor; indices?: Accessor }>>();
  private lines = new Map<Mesh, Map<string, { indices: Accessor; positions: Accessor; extras: Json } | undefined>>();
  private volumes = new Map<Mesh, Volume>();
  /** meshopt: each part mesh's vertex order, and each look's reordered indices. */
  private orders = new Map<Mesh, Uint32Array>();
  private reordered = new Map<Uint32Array, Uint32Array>();
  private hiddenLeftOut = 0;
  private readonly defaultColor: Vec3;
  private readonly edgeColor: Vec3;
  private readonly edgeKinds: ReadonlySet<string>;
  private readonly compression: Compression;
  private readonly extras: boolean;
  private readonly scene: Scene;
  private readonly view: ExportView;
  private readonly opts: GltfOptions;
  private readonly reorderMesh?: ReorderMesh;

  constructor(scene: Scene, view: ExportView, opts: GltfOptions, reorderMesh?: ReorderMesh) {
    this.scene = scene;
    this.view = view;
    this.opts = opts;
    this.reorderMesh = reorderMesh;
    this.defaultColor = opts.defaultColor ?? [0.8, 0.8, 0.8];
    this.edgeColor = opts.edgeColor ?? [0, 0, 0];
    this.edgeKinds = new Set(opts.edgeKinds ?? ['shared', 'free']);
    this.exclude = new Set(opts.exclude ?? []);
    this.compression = opts.compression ?? 'draco';
    this.extras = opts.extras ?? false;
    this.buffer = this.doc.createBuffer();
    this.doc.getRoot().getAsset().generator = 'cad-io-js export-gltf';
    // (The Draco extension notes, through the document's logger, that it leaves lines and points uncompressed.)
    this.doc.setLogger(new Logger(Logger.Verbosity.ERROR));
  }

  write(): GltfResult {
    const root = this.doc.createNode(this.opts.name ?? '').setMatrix(Array.from(ROOT_TRANSFORM) as mat4);
    // Below the root: millimetres, the source's axes.
    if (this.extras) root.setExtras({ unit: 'millimetre', up: 'z',
      ...(Object.keys(this.scene.properties).length ? { properties: this.scene.properties } : {}) });
    const omit = this.opts.hidden !== 'extension';
    const visit = (n: ExportNode) => {
      for (const p of n.parts) if (!p.visible && omit) this.hiddenLeftOut++;
      n.children.forEach(visit);
    };
    this.view.roots.forEach(visit);
    const groups = this.opts.instancing ? this.instances(omit) : [];
    const roots = this.opts.keepEmpty ? this.view.roots : pruneView(this.view,
      (p) => (p.visible || !omit) && !this.instanced.has(p)).roots;
    for (const n of roots) root.addChild(this.node(n));
    for (const g of groups) for (const node of this.instancedNodes(g)) root.addChild(node);
    this.doc.createScene(this.opts.name ?? '').addChild(root);
    // A scene with nothing to draw has no accessors, and an empty buffer isn't valid glTF.
    if (!this.doc.getRoot().listAccessors().length) this.buffer.dispose();
    else if (this.compression === 'draco') {
      this.doc.createExtension(KHRDracoMeshCompression).setRequired(true).setEncoderOptions({
        method: KHRDracoMeshCompression.EncoderMethod.EDGEBREAKER,
        quantizationBits: { POSITION: this.opts.dracoPositionBits ?? 14 } });
    } else if (this.compression === 'meshopt') {
      this.doc.createExtension(KHRMeshQuantization).setRequired(true);
      this.doc.createExtension(EXTMeshoptCompression).setRequired(true)
        .setEncoderOptions({ method: EXTMeshoptCompression.EncoderMethod.FILTER });
    }
    if (this.hiddenLeftOut) {
      const n = this.hiddenLeftOut;
      this.diagnostics.push({ severity: 'warning',
        message: `${n} hidden part ${n === 1 ? 'instance' : 'instances'} left out (glTF has no visibility without `
        + `KHR_node_visibility)` });
    }
    return { document: this.doc, diagnostics: this.diagnostics };
  }

  private accessor(name: string, type: 'SCALAR' | 'VEC3' | 'VEC4',
    array: Float32Array | Int16Array | Uint16Array | Uint32Array): Accessor {
    const a = this.doc.createAccessor(name).setType(type).setArray(array as TypedArray).setBuffer(this.buffer);
    return array instanceof Int16Array ? a.setNormalized(true) : a;
  }

  private volume(mesh: Mesh): Volume {
    let v = this.volumes.get(mesh);
    if (!v) this.volumes.set(mesh, (v = volume(mesh)));
    return v;
  }

  /**
   * One accessor per vertex array, whichever looks and primitives use it; with meshopt, positions quantized in the
   * part mesh's volume (`quantized`), and vertices in the mesh's order (`order`).
   */
  private vec3(array: Float32Array, name: string, mesh?: Mesh, quantized = false, order?: Uint32Array): Accessor {
    let a = this.vertices.get(array);
    if (a) return a;
    const data = quantized ? quantize(array, this.volume(mesh!), order) : order ? permute(array, order) : array;
    this.vertices.set(array, (a = this.accessor(name, 'VEC3', data)));
    return a;
  }

  /** A range of a look's indices, shared by looks with the same index array. */
  private indices(indices: Uint32Array, start: number, count: number, vertices: number, name: string): Accessor {
    let byRange = this.indexAccessors.get(indices);
    if (!byRange) this.indexAccessors.set(indices, (byRange = new Map()));
    const key = `${start}+${count}`;
    let a = byRange.get(key);
    if (!a) byRange.set(key, (
      a = this.accessor(name, 'SCALAR', indexArray(indices.subarray(start, start + count), vertices))));
    return a;
  }

  /**
   * Draco with extras: per vertex, the index of its face among the group's faces (`_FACE`, 16 bits; 65535 for the
   * vertices the group doesn't use). A vertex two faces share (our backends never share them) gets a copy per face,
   * with its own positions, normals and indices for the group.
   */
  private faceAttribute(look: Look, g: Look['groups'][number], faces: Look['faces'], name: string) {
    let byRange = this.faceAttributes.get(look.indices);
    if (!byRange) this.faceAttributes.set(look.indices, (byRange = new Map()));
    const key = `${g.start}+${g.count}`;
    const known = byRange.get(key);
    if (known) return known;
    if (faces.length > MAX_DRACO_FACES) throw new GltfError(`part '${name}': ${faces.length} faces in one `
      + `primitive, more than Draco's _FACE attribute can number (${MAX_DRACO_FACES}); write it without extras or `
      + 'with another compression');
    const { positions, normals } = look.mesh;
    const n = positions.length / 3;
    const face = new Uint16Array(n).fill(65535);
    const extra: number[] = []; // copies: [original vertex, face]
    const indices = look.indices.slice(g.start, g.start + g.count);
    faces.forEach((f, j) => {
      const copies = new Map<number, number>();
      for (let i = f.start - g.start; i < f.start - g.start + f.count; i++) {
        const v = indices[i]!;
        if (face[v] === 65535 || face[v] === j) { face[v] = j; continue; }
        let c = copies.get(v);
        if (c === undefined) { copies.set(v, (c = n + extra.length / 2)); extra.push(v, j); }
        indices[i] = c;
      }
    });
    let made: { face: Accessor; positions?: Accessor; normals?: Accessor; indices?: Accessor };
    if (!extra.length) made = { face: this.accessor(`${name} faces`, 'SCALAR', face) };
    else {
      const m = n + extra.length / 2;
      const grow = (src: Float32Array) => {
        const out = new Float32Array(3 * m);
        out.set(src);
        for (let k = 0; k < extra.length; k += 2) out.set(src.subarray(3 * extra[k]!, 3 * extra[k]! + 3),
          3 * (n + k / 2));
        return out;
      };
      const all = new Uint16Array(m);
      all.set(face);
      for (let k = 0; k < extra.length; k += 2) all[n + k / 2] = extra[k + 1]!;
      made = { face: this.accessor(`${name} faces`, 'SCALAR', all),
        positions: this.accessor(name, 'VEC3', grow(positions)),
        ...(normals ? { normals: this.accessor(`${name} normals`, 'VEC3', grow(normals)) } : {}),
        indices: this.accessor(name, 'SCALAR', indexArray(indices, m)) };
    }
    byRange.set(key, made);
    return made;
  }

  /** meshopt: a look's indices reordered within its faces, in its part mesh's vertex order. */
  private lookIndices(look: Look): Uint32Array {
    if (!this.reorderMesh) return look.indices;
    // (Looks with the same index array have the same faces.)
    let r = this.reordered.get(look.indices);
    if (r) return r;
    r = reorderWithinFaces(look.indices, look.faces, this.reorderMesh);
    let order = this.orders.get(look.mesh);
    if (!order) this.orders.set(look.mesh, (order = firstUse(r, look.mesh.positions.length / 3)));
    for (let i = 0; i < r.length; i++) r[i] = order[r[i]!]!;
    this.reordered.set(look.indices, r);
    return r;
  }

  /** A material for faces, or (`lines`) for edges, curves and points, which are unlit with `unlitLines`. */
  private material(material: number | undefined, color?: Vec3, lines = false): GltfMaterial {
    const unlit = lines && (this.opts.unlitLines ?? false);
    const key = `${material}:${color}:${unlit}`;
    let m = this.materials.get(key);
    if (m) return m;
    const source = material === undefined ? undefined : this.scene.materials[material];
    const c = color ?? source?.color ?? this.defaultColor;
    const opacity = source?.opacity ?? 1;
    m = this.doc.createMaterial(source?.name ?? '')
      .setBaseColorFactor([srgbToLinear(c[0]), srgbToLinear(c[1]), srgbToLinear(c[2]), opacity])
      .setMetallicFactor(0).setRoughnessFactor(1)
      .setDoubleSided(this.opts.doubleSided ?? false);
    if (opacity < 1) m.setAlphaMode('BLEND');
    if (material !== undefined && this.extras) m.setExtras({ material });
    if (unlit) {
      this.unlit ??= this.doc.createExtension(KHRMaterialsUnlit);
      m.setExtension('KHR_materials_unlit', this.unlit.createUnlit());
    }
    this.materials.set(key, m);
    return m;
  }

  /** A mesh's edges, curves or points: positions, indices and their extras, shared by the mesh's looks. */
  private lineData(mesh: Mesh, what: 'edges' | 'curves' | 'points', name: string) {
    let byWhat = this.lines.get(mesh);
    if (!byWhat) this.lines.set(mesh, (byWhat = new Map()));
    if (byWhat.has(what)) return byWhat.get(what);
    const quantized = this.compression === 'meshopt';
    let made: { indices: Accessor; positions: Accessor; extras: Json } | undefined;
    if (what === 'points') {
      const n = mesh.pointSources!.length;
      made = {
        positions: this.vec3(mesh.points!, `${name} points`, mesh, quantized),
        indices: this.accessor(`${name} points`, 'SCALAR', indexArray(Uint32Array.from({ length: n }, (_, i) => i), n)),
        extras: { points: mesh.pointSources! },
      };
    } else {
      const positions = what === 'edges' ? mesh.edgePositions! : mesh.curvePositions!;
      const lines = what === 'edges' ? mesh.edges!.filter((e) => this.edgeKinds.has(e.kind)) : mesh.curves!;
      const { index, ranges } = segments(lines);
      if (index.length) {
        const list = lines.map((l: { source: number | null; kind?: string; dihedral?: number }, i) => {
          const out: Json = { source: l.source, start: ranges[i]!.start, count: ranges[i]!.count };
          if (l.kind !== undefined) out.kind = l.kind;
          if (l.dihedral !== undefined) out.dihedral = l.dihedral;
          return out;
        });
        made = {
          positions: this.vec3(positions, `${name} ${what}`, mesh, quantized),
          indices: this.accessor(`${name} ${what}`, 'SCALAR', indexArray(index, positions.length / 3)),
          extras: what === 'edges' ? { edges: list } : { curves: list },
        };
      }
    }
    byWhat.set(what, made);
    return made;
  }

  /** The faces' mesh for a look, made on first use; undefined if it has no triangles. */
  private mesh(index: number): GltfMesh | undefined {
    if (this.meshes.has(index)) return this.meshes.get(index);
    const look: Look = this.view.looks[index]!;
    const name = this.scene.parts[look.part]!.name;
    let made: GltfMesh | undefined;
    if (look.groups.length) {
      made = this.doc.createMesh(name);
      const vertices = look.mesh.positions.length / 3;
      const meshopt = this.compression === 'meshopt';
      const indices = this.lookIndices(look);
      const order = meshopt ? this.orders.get(look.mesh) : undefined;
      for (const g of look.groups) {
        // The faces in this group, as ranges of its indices.
        const faces = look.faces.filter((f) => f.start >= g.start && f.start < g.start + g.count);
        // Draco reorders triangles: with extras, the faces by vertex attribute, not by range.
        const fa = this.extras && this.compression === 'draco' ? this.faceAttribute(look, g, faces, name) : undefined;
        const p = this.doc.createPrimitive().setMode(4) // TRIANGLES
          .setAttribute('POSITION', fa?.positions ?? this.vec3(look.mesh.positions, name, look.mesh, meshopt, order))
          .setIndices(fa?.indices ?? this.indices(indices, g.start, g.count, vertices, name))
          .setMaterial(this.material(g.material));
        if (look.mesh.normals) p.setAttribute('NORMAL', fa?.normals ?? this.vec3(look.mesh.normals,
          `${name} normals`, look.mesh, false, order));
        if (fa) {
          p.setAttribute('_FACE', fa.face);
          p.setExtras({ faces: faces.map((f) => ({ source: f.source })) });
        } else if (this.extras) {
          p.setExtras({ faces: faces.map((f) => ({ source: f.source, start: f.start - g.start, count: f.count })) });
        }
        made.addPrimitive(p);
      }
    }
    this.meshes.set(index, made);
    return made;
  }

  /**
   * A look's edges, curves or points as a mesh of their own, shared by the looks of the same part mesh in the same
   * colour; undefined if there are none (or they're excluded).
   */
  private lineMesh(look: Look, what: LineKind): GltfMesh | undefined {
    if (this.exclude.has(what) || !(what === 'edges' ? look.edges : look.curves)) return undefined;
    const material = what === 'edges' ? undefined : look.material;
    let id = this.meshIds.get(look.mesh);
    if (id === undefined) this.meshIds.set(look.mesh, (id = this.meshIds.size));
    const key = `${id}:${what}:${material}`;
    if (this.lineMeshes.has(key)) return this.lineMeshes.get(key);
    const name = this.scene.parts[look.part]!.name;
    if (what === 'curves' && !look.mesh.curves?.length) return undefined;
    if (what === 'points' && !look.mesh.pointSources?.length) return undefined;
    const d = this.lineData(look.mesh, what, name);
    if (!d) return undefined;
    const mat = what === 'edges' ? this.material(undefined, this.edgeColor, true) : this.material(material,
      undefined, true);
    // POINTS, LINES
    const prim = this.doc.createPrimitive().setMode(what === 'points' ? 0 : 1)
      .setAttribute('POSITION', d.positions).setIndices(d.indices).setMaterial(mat);
    if (this.extras) prim.setExtras(d.extras);
    const mesh = this.doc.createMesh(`${name} ${what}`).addPrimitive(prim);
    this.lineMeshes.set(key, mesh);
    return mesh;
  }

  private sourced(sources: SourceId[], properties: Record<string, PropertyValue>): Json {
    const u: Json = {};
    if (sources.length) u.sources = sources.map((s) => ({ format: s.format, id: s.id }));
    if (Object.keys(properties).length) u.properties = properties;
    return u;
  }

  private part(p: Placed): Node | undefined {
    if ((!p.visible && this.opts.hidden !== 'extension') || this.instanced.has(p)) return undefined;
    return this.partNode(p.look, p.transform, p.visible, true);
  }

  /** A placed part's node: its faces (unless instanced elsewhere), and its edges, curves and points as children. */
  private partNode(lookIndex: number, transform: Mat4, visible: boolean, faces: boolean,
    instance?: Json): Node {
    const look = this.view.looks[lookIndex]!;
    const part = this.scene.parts[look.part]!;
    const node = this.doc.createNode(part.name);
    if (this.extras) node.setExtras({ part: look.part, ...closedOf(part), ...this.sourced(part.sources,
      part.properties), ...(instance ? { instance } : {}) });
    const mesh = faces ? this.mesh(lookIndex) : undefined;
    if (mesh) node.setMesh(mesh);
    for (const what of ['edges', 'curves', 'points'] as const) {
      const m = this.lineMesh(look, what);
      if (m) node.addChild(this.doc.createNode(what).setMesh(m));
    }
    node.setMatrix(Array.from(this.placement(look, transform, !!mesh || node.listChildren().length > 0)) as mat4);
    if (!visible) this.hide(node);
    return node;
  }

  /** A part node's matrix: meshopt's positions are in the part mesh's volume (its children's too). */
  private placement(look: Look, transform: Mat4, drawn: boolean): Mat4 {
    return this.compression === 'meshopt' && drawn ? multiply(transform, dequantization(this.volume(look.mesh)))
      : transform;
  }

  /** (KHR_node_visibility hides the node's children too.) */
  private hide(node: Node): void {
    this.visibility ??= this.doc.createExtension(KHRNodeVisibility);
    node.setExtension('KHR_node_visibility', this.visibility.createVisibility().setVisible(false));
  }

  /**
   * The looks to instance: written placements (TRS-decomposable world transforms) grouped by look and visibility,
   * in order of first placement, two or more each, of looks with faces. Marks their placements instanced.
   */
  private instances(omit: boolean): Instances[] {
    const groups = new Map<string, Instances & { placed: Placed[] }>();
    const walk = (n: ExportNode, parent: Mat4, above: string[]) => {
      const t = multiply(parent, n.transform);
      const names = [...above, n.name];
      for (const p of n.parts) {
        if ((!p.visible && omit) || !this.view.looks[p.look]!.groups.length) continue;
        const world = multiply(t, p.transform);
        if (!decompose(world)) continue;
        const key = `${p.look}:${p.visible}`;
        let g = groups.get(key);
        if (!g) groups.set(key, (g = { look: p.look, visible: p.visible, items: [], placed: [] }));
        g.items.push({ node: n, names, world });
        g.placed.push(p);
      }
      for (const c of n.children) walk(c, t, names);
    };
    for (const r of this.view.roots) walk(r, identity(), []);
    const out = [...groups.values()].filter((g) => g.items.length > 1);
    for (const g of out) for (const p of g.placed) this.instanced.add(p);
    return out;
  }

  /** An instanced look's faces node, then a node per placement for its edges, curves and points if it has any. */
  private instancedNodes(g: Instances): Node[] {
    const look = this.view.looks[g.look]!;
    const part = this.scene.parts[look.part]!;
    const node = this.doc.createNode(part.name).setMesh(this.mesh(g.look)!);
    const n = g.items.length;
    const t = new Float32Array(3 * n), r = new Float32Array(4 * n), s = new Float32Array(3 * n);
    g.items.forEach((item, i) => {
      const d = decompose(this.placement(look, item.world, true))!;
      t.set(d.t, 3 * i); r.set(d.r, 4 * i); s.set(d.s, 3 * i);
    });
    this.gpuInstancing ??= this.doc.createExtension(EXTMeshGPUInstancing).setRequired(true);
    node.setExtension('EXT_mesh_gpu_instancing', this.gpuInstancing.createInstancedMesh()
      .setAttribute('TRANSLATION', this.accessor(`${part.name} instance translations`, 'VEC3', t))
      .setAttribute('ROTATION', this.accessor(`${part.name} instance rotations`, 'VEC4', r))
      .setAttribute('SCALE', this.accessor(`${part.name} instance scales`, 'VEC3', s)));
    const instance = (item: Instances['items'][number]): Json => ({ path: item.node.path, names: item.names,
      ...(item.node.occurrence.sources.length ? { sources: item.node.occurrence.sources.map((x) => ({
        format: x.format, id: x.id })) } : {}) });
    if (this.extras) node.setExtras({ part: look.part, ...closedOf(part), ...this.sourced(part.sources,
      part.properties), instances: g.items.map(instance) });
    if (!g.visible) this.hide(node);
    const out = [node];
    if (look.edges || look.curves) for (const item of g.items) {
      const lines = this.partNode(g.look, item.world, g.visible, false, instance(item));
      if (lines.listChildren().length) out.push(lines);
      else lines.dispose();
    }
    return out;
  }

  private node(n: ExportNode): Node {
    const comp = this.scene.components[n.component]!;
    const node = this.doc.createNode(n.name).setMatrix(Array.from(n.transform) as mat4);
    if (this.extras) {
      const extras: Json = { ...this.sourced(n.occurrence.sources, n.occurrence.properties) };
      extras.component = { index: n.component, name: comp.name, ...this.sourced(comp.sources, comp.properties) };
      if (comp.external) extras.external = { uri: comp.external.uri,
        ...(comp.external.format ? { format: comp.external.format } : {}) };
      node.setExtras(extras);
    }
    for (const p of n.parts) { const c = this.part(p); if (c) node.addChild(c); }
    for (const c of n.children) node.addChild(this.node(c));
    return node;
  }
}
