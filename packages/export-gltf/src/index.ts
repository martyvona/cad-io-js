// Scene model → glTF 2.0, written with glTF-Transform (decision 1): GLB, or .gltf JSON with its buffer as a separate
// .bin or embedded as base64. See docs/architecture.md, "Stage 4", and docs/phase4_progress.md, step 4.
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
//   extras: names, source ids and properties; per triangle primitive its faces' sources as index ranges, for picking.
//
// Hidden part instances are left out (glTF core has no visibility), or with `hidden: 'extension'` written with
// KHR_node_visibility (decided by the user, 2026-10-21).

import { Document, Format, WebIO, type Accessor, type JSONDocument, type Buffer, type Material as GltfMaterial, type Mesh as GltfMesh, type Node, type TypedArray, type mat4 } from '@gltf-transform/core';
import { KHRMaterialsUnlit, KHRNodeVisibility } from '@gltf-transform/extensions';
import type { Diagnostic, ExportNode, ExportView, Look, Mat4, Mesh, PropertyValue, Scene, SourceId, Vec3 } from 'cad-scene';

export interface GltfOptions {
  /** Colour of faces, curves and points without a material (sRGB). Default light grey. */
  defaultColor?: Vec3;
  /** Colour of B-rep edges (sRGB). Default black. */
  edgeColor?: Vec3;
  /** B-rep edge kinds to write, when the view has edges. Default shared and free (seams and degenerate edges hidden). */
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
}

export type LineKind = 'edges' | 'curves' | 'points';

export interface GltfResult {
  document: Document;
  /** Hidden instances left out, as a warning. */
  diagnostics: Diagnostic[];
}

/** Millimetres to metres, and Z up to Y up: (x, y, z) mm → (x, z, −y) m. Column-major. */
export const ROOT_TRANSFORM: Mat4 = Float64Array.of(0.001, 0, 0, 0, 0, 0, -0.001, 0, 0, 0.001, 0, 0, 0, 0, 0, 1);

/** The scene's export view as a glTF-Transform document. */
export function gltfDocument(scene: Scene, view: ExportView, opts: GltfOptions = {}): GltfResult {
  return new Writer(scene, view, opts).write();
}

/** The scene's export view as GLB. */
export async function glb(scene: Scene, view: ExportView, opts: GltfOptions = {}): Promise<{ bytes: Uint8Array; diagnostics: Diagnostic[] }> {
  const { document, diagnostics } = gltfDocument(scene, view, opts);
  const { json, resources } = await write(document, Format.GLB);
  return { bytes: packGlb(json, Object.values(resources)[0]), diagnostics };
}

/**
 * The scene's export view as .gltf JSON and its buffer, which the JSON names `bin` (a URI relative to the JSON); with
 * `bin` undefined, the buffer is embedded in the JSON as a base64 data URI (a third bigger; the JSON is one string,
 * so a buffer beyond about 400 MB exceeds V8's string limit) and `bin` is empty.
 */
export async function gltfJson(scene: Scene, view: ExportView, bin: string | undefined, opts: GltfOptions = {}): Promise<{ json: string; bin: Uint8Array; diagnostics: Diagnostic[] }> {
  const { document, diagnostics } = gltfDocument(scene, view, opts);
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
  for (let i = 0; i < bytes.length; i += 3 * 8192) parts.push(btoa(String.fromCharCode(...bytes.subarray(i, i + 3 * 8192))));
  return parts.join('');
}

/**
 * glTF-Transform's JSON for a document, with each node's translation, rotation and scale as they are: its writer
 * leaves out any within 1e-5 of the default, which drops rotations of up to about 2e-5 rad (20 µm a metre away)
 * and scales within 1e-5 of 1 (docs/phase4_progress.md, step 4).
 */
async function write(document: Document, format: Format): Promise<JSONDocument> {
  const out = await new WebIO().registerExtensions([KHRMaterialsUnlit, KHRNodeVisibility]).writeJSON(document, { format });
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

/** sRGB to linear, as glTF's base colour factor is linear. */
export function srgbToLinear(c: number): number {
  const v = Math.min(1, Math.max(0, c));
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

/** Segment pairs for a set of polylines, and each polyline's range of index entries. */
function segments(lines: { start: number; count: number }[]): { index: Uint32Array; ranges: { start: number; count: number }[] } {
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

type Json = { [key: string]: PropertyValue | Json | Json[] | number[] | undefined };

class Writer {
  private readonly doc = new Document();
  private readonly buffer: Buffer;
  private readonly diagnostics: Diagnostic[] = [];
  private visibility?: KHRNodeVisibility;
  private unlit?: KHRMaterialsUnlit;
  private materials = new Map<string, GltfMaterial>();
  private meshes = new Map<number, GltfMesh | undefined>();
  private lineMeshes = new Map<string, GltfMesh>();
  private meshIds = new Map<Mesh, number>();
  private readonly exclude: ReadonlySet<LineKind>;
  private vertices = new Map<Float32Array, Accessor>();
  private indexAccessors = new Map<Uint32Array, Map<string, Accessor>>();
  private lines = new Map<Mesh, Map<string, { indices: Accessor; positions: Accessor; extras: Json } | undefined>>();
  private hiddenLeftOut = 0;
  private readonly defaultColor: Vec3;
  private readonly edgeColor: Vec3;
  private readonly edgeKinds: ReadonlySet<string>;
  private readonly scene: Scene;
  private readonly view: ExportView;
  private readonly opts: GltfOptions;

  constructor(scene: Scene, view: ExportView, opts: GltfOptions) {
    this.scene = scene;
    this.view = view;
    this.opts = opts;
    this.defaultColor = opts.defaultColor ?? [0.8, 0.8, 0.8];
    this.edgeColor = opts.edgeColor ?? [0, 0, 0];
    this.edgeKinds = new Set(opts.edgeKinds ?? ['shared', 'free']);
    this.exclude = new Set(opts.exclude ?? []);
    this.buffer = this.doc.createBuffer();
    this.doc.getRoot().getAsset().generator = 'cad-io-js export-gltf';
  }

  write(): GltfResult {
    const root = this.doc.createNode(this.opts.name ?? '').setMatrix(Array.from(ROOT_TRANSFORM) as mat4);
    // Below the root: millimetres, the source's axes.
    root.setExtras({ unit: 'millimetre', up: 'z', ...(Object.keys(this.scene.properties).length ? { properties: this.scene.properties } : {}) });
    for (const n of this.view.roots) root.addChild(this.node(n));
    this.doc.createScene(this.opts.name ?? '').addChild(root);
    // A scene with nothing to draw has no accessors, and an empty buffer isn't valid glTF.
    if (!this.doc.getRoot().listAccessors().length) this.buffer.dispose();
    if (this.hiddenLeftOut) {
      const n = this.hiddenLeftOut;
      this.diagnostics.push({ severity: 'warning', message: `${n} hidden part ${n === 1 ? 'instance' : 'instances'} left out (glTF has no visibility without KHR_node_visibility)` });
    }
    return { document: this.doc, diagnostics: this.diagnostics };
  }

  private accessor(name: string, type: 'SCALAR' | 'VEC3', array: Float32Array | Uint16Array | Uint32Array): Accessor {
    return this.doc.createAccessor(name).setType(type).setArray(array as TypedArray).setBuffer(this.buffer);
  }

  /** One accessor per vertex array, whichever looks and primitives use it. */
  private vec3(array: Float32Array, name: string): Accessor {
    let a = this.vertices.get(array);
    if (!a) this.vertices.set(array, (a = this.accessor(name, 'VEC3', array)));
    return a;
  }

  /** A range of a look's indices, shared by looks with the same index array. */
  private indices(indices: Uint32Array, start: number, count: number, vertices: number, name: string): Accessor {
    let byRange = this.indexAccessors.get(indices);
    if (!byRange) this.indexAccessors.set(indices, (byRange = new Map()));
    const key = `${start}+${count}`;
    let a = byRange.get(key);
    if (!a) byRange.set(key, (a = this.accessor(name, 'SCALAR', indexArray(indices.subarray(start, start + count), vertices))));
    return a;
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
    if (material !== undefined) m.setExtras({ material });
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
    let made: { indices: Accessor; positions: Accessor; extras: Json } | undefined;
    if (what === 'points') {
      const n = mesh.pointSources!.length;
      made = {
        positions: this.vec3(mesh.points!, `${name} points`),
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
          positions: this.vec3(positions, `${name} ${what}`),
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
      for (const g of look.groups) {
        const p = this.doc.createPrimitive().setMode(4) // TRIANGLES
          .setAttribute('POSITION', this.vec3(look.mesh.positions, name))
          .setIndices(this.indices(look.indices, g.start, g.count, vertices, name))
          .setMaterial(this.material(g.material));
        if (look.mesh.normals) p.setAttribute('NORMAL', this.vec3(look.mesh.normals, `${name} normals`));
        // The faces in this group, as ranges of its indices.
        const faces = look.faces.filter((f) => f.start >= g.start && f.start < g.start + g.count)
          .map((f) => ({ source: f.source, start: f.start - g.start, count: f.count }));
        p.setExtras({ faces });
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
    const mat = what === 'edges' ? this.material(undefined, this.edgeColor, true) : this.material(material, undefined, true);
    const mesh = this.doc.createMesh(`${name} ${what}`).addPrimitive(this.doc.createPrimitive().setMode(what === 'points' ? 0 : 1) // POINTS, LINES
      .setAttribute('POSITION', d.positions).setIndices(d.indices).setMaterial(mat).setExtras(d.extras));
    this.lineMeshes.set(key, mesh);
    return mesh;
  }

  private sourced(sources: SourceId[], properties: Record<string, PropertyValue>): Json {
    const u: Json = {};
    if (sources.length) u.sources = sources.map((s) => ({ format: s.format, id: s.id }));
    if (Object.keys(properties).length) u.properties = properties;
    return u;
  }

  private part(p: ExportNode['parts'][number]): Node | undefined {
    if (!p.visible && this.opts.hidden !== 'extension') { this.hiddenLeftOut++; return undefined; }
    const look = this.view.looks[p.look]!;
    const part = this.scene.parts[look.part]!;
    const node = this.doc.createNode(part.name).setMatrix(Array.from(p.transform) as mat4)
      .setExtras({ part: look.part, ...this.sourced(part.sources, part.properties) });
    const mesh = this.mesh(p.look);
    if (mesh) node.setMesh(mesh);
    for (const what of ['edges', 'curves', 'points'] as const) {
      const m = this.lineMesh(look, what);
      if (m) node.addChild(this.doc.createNode(what).setMesh(m));
    }
    // (KHR_node_visibility hides the node's children too.)
    if (!p.visible) {
      this.visibility ??= this.doc.createExtension(KHRNodeVisibility);
      node.setExtension('KHR_node_visibility', this.visibility.createVisibility().setVisible(false));
    }
    return node;
  }

  private node(n: ExportNode): Node {
    const comp = this.scene.components[n.component]!;
    const extras: Json = { ...this.sourced(n.occurrence.sources, n.occurrence.properties) };
    extras.component = { index: n.component, name: comp.name, ...this.sourced(comp.sources, comp.properties) };
    if (comp.external) extras.external = { uri: comp.external.uri, ...(comp.external.format ? { format: comp.external.format } : {}) };
    const node = this.doc.createNode(n.name).setMatrix(Array.from(n.transform) as mat4).setExtras(extras);
    for (const p of n.parts) { const c = this.part(p); if (c) node.addChild(c); }
    for (const c of n.children) node.addChild(this.node(c));
    return node;
  }
}
