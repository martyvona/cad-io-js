// Scene model -> three.js JSON Object Scene format 4 (the form Object3D.toJSON writes), loadable with
// THREE.ObjectLoader. See README.md, "`stepconv`", and CLAUDE.md, "Decisions".
//
//   objects: a root Group (its matrix to metres, Y up), a Group per instance-tree node (matrix =
//     the node's local transform), and per placed part a Mesh (or a Group, for a part without triangles) whose
//     children are its B-rep edges (LineSegments), wireframe curves (LineSegments) and points (Points).
//   geometries: one per distinct mesh and grouping, shared by every instance; groups index the Mesh's material array.
//   materials: one per scene material and kind (MeshStandardMaterial, LineBasicMaterial, PointsMaterial).
//   userData (on request): source ids, properties and parts (and `closed`, where the source says whether a part's
//     faces bound solids); per Mesh its faces' sources as index ranges, for
//     picking; the scene's properties, and the unit and up axis below the root, on the root.
//
// Tree nodes with nothing to draw beneath them are left out unless `keepEmpty` (the user, 2026-10-24).
//
// The root's matrix turns the scene's millimetres and Z up into metres and Y up (three.js's up axis, glTF's unit and
// axis), with extras or without, so a file sits the same in any three.js application; below it lengths are
// millimetres and axes as in the source (CAD files are usually Z-up), which the root's userData says with extras (the
// user, 2026-10-24). Format 4 holds numbers as JSON arrays, so output is produced in chunks: a large model's JSON can
// exceed V8's maximum string length.

import { partExtras, pruneView, Y_UP_METRES, type ExportNode, type ExportView, type Look, type Mat4, type Mesh,
  type PropertyValue, type Scene, type SourceId, type Vec3 } from 'cad-scene';

/** Millimetres to metres, and Z up to Y up: (x, y, z) mm -> (x, z, -y) m. Column-major (cad-scene's `Y_UP_METRES`). */
export const ROOT_TRANSFORM: Mat4 = Y_UP_METRES;

export interface ThreejsOptions {
  /** Colour of faces, curves and points without a material (sRGB). Default light grey. */
  defaultColor?: Vec3;
  /** Colour of B-rep edges (sRGB). Default black. */
  edgeColor?: Vec3;
  /**
   * B-rep edge kinds to write, when the view has edges. Default shared and free (seams and degenerate edges hidden).
   */
  edgeKinds?: readonly ('shared' | 'seam' | 'free' | 'degenerate')[];
  /** Render both sides of faces (open shells and surface models are then seen from behind too). Default false. */
  doubleSided?: boolean;
  /** Name of the root object. */
  name?: string;
  /**
   * Our userData: source ids, properties, parts and whether they're closed (where the source says) on objects, scene
   * material indices on materials, face, edge, curve and point sources, and the unit and up axis below the root.
   * Default false: other systems don't read them (the user, 2026-10-24).
   */
  extras?: boolean;
  /** Keep tree nodes with nothing to draw beneath them. Default false. */
  keepEmpty?: boolean;
}

const DOUBLE_SIDE = 2; // THREE.DoubleSide
const NUMBERS_PER_CHUNK = 16384;

/** The scene's export view as three.js JSON, in chunks; concatenated, they are one JSON document. */
export function* threejsChunks(scene: Scene, view: ExportView, opts: ThreejsOptions = {}): Generator<string> {
  const w = new Writer(scene, opts.keepEmpty ? view : pruneView(view), opts);
  const root = w.root();
  yield `{"metadata":{"version":4.7,"type":"Object","generator":"cad-io-js export-threejs"},"geometries":[`;
  let first = true;
  for (const g of w.geometries) {
    if (!first) yield ',';
    first = false;
    yield* geometryChunks(g);
  }
  yield `],"materials":${JSON.stringify(w.materials)},"object":`;
  yield JSON.stringify(root);
  yield '}';
}

/** The scene's export view as one three.js JSON string (small scenes; see `threejsChunks`). */
export function threejsJson(scene: Scene, view: ExportView, opts: ThreejsOptions = {}): string {
  return [...threejsChunks(scene, view, opts)].join('');
}

/** A float32 in the fewest digits that read back to the same float32. */
export function formatFloat32(x: number): string {
  if (!Number.isFinite(x)) return 'null';
  if (Number.isInteger(x)) return String(x);
  for (let p = 6; p < 9; p++) {
    const t = Number(x.toPrecision(p));
    if (Math.fround(t) === x) return String(t);
  }
  return String(Number(x.toPrecision(9)));
}

interface Geometry {
  uuid: string;
  name: string;
  attributes: { name: string; array: Float32Array }[];
  index: Uint32Array;
  groups?: { start: number; count: number; materialIndex: number }[];
}

function* numberChunks(array: Float32Array | Uint32Array, float: boolean): Generator<string> {
  for (let i = 0; i < array.length; i += NUMBERS_PER_CHUNK) {
    const part = array.subarray(i, Math.min(array.length, i + NUMBERS_PER_CHUNK));
    const text = float ? Array.from(part, formatFloat32).join(',') : part.join(',');
    yield i ? `,${text}` : text;
  }
}

function* geometryChunks(g: Geometry): Generator<string> {
  yield `{"uuid":"${g.uuid}","type":"BufferGeometry","name":${JSON.stringify(g.name)},"data":{"attributes":{`;
  let first = true;
  for (const a of g.attributes) {
    yield `${first ? '' : ','}"${a.name}":{"itemSize":3,"type":"Float32Array","normalized":false,"array":[`;
    first = false;
    yield* numberChunks(a.array, true);
    yield ']}';
  }
  yield '},"index":{"type":"Uint32Array","array":[';
  yield* numberChunks(g.index, false);
  yield ']}';
  if (g.groups) yield `,"groups":${JSON.stringify(g.groups)}`;
  yield '}}';
}

const hex = (c: Vec3) => c.reduce((h, v) => h * 256 + Math.round(Math.min(1, Math.max(0, v)) * 255), 0);
/** A matrix as three.js stores it: both are column-major. */
const matrix = (m: Mat4) => Array.from(m);

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

type Json = { [key: string]: PropertyValue | Json | Json[] | number[] | undefined };

class Writer {
  readonly geometries: Geometry[] = [];
  readonly materials: Json[] = [];
  private uuids = 0;
  private materialIds = new Map<string, string>();
  private faceGeometries = new Map<Mesh, { uuid: string; groups: number; ranges: string; indices: Uint32Array;
    faces: Look['faces'] }[]>();
  private lineGeometry = new Map<Mesh, Map<string, { uuid: string; userData: Json } | undefined>>();
  private readonly defaultColor: Vec3;
  private readonly edgeColor: Vec3;
  private readonly edgeKinds: ReadonlySet<string>;
  private readonly scene: Scene;
  private readonly view: ExportView;
  private readonly opts: ThreejsOptions;
  private readonly extras: boolean;

  constructor(scene: Scene, view: ExportView, opts: ThreejsOptions) {
    this.scene = scene;
    this.view = view;
    this.opts = opts;
    this.defaultColor = opts.defaultColor ?? [0.8, 0.8, 0.8];
    this.edgeColor = opts.edgeColor ?? [0, 0, 0];
    this.edgeKinds = new Set(opts.edgeKinds ?? ['shared', 'free']);
    this.extras = opts.extras ?? false;
  }

  /** Deterministic uuids, so the same scene gives the same file. */
  private uuid(): string {
    return `00000000-0000-4000-8000-${(++this.uuids).toString(16).padStart(12, '0')}`;
  }

  private material(kind: 'mesh' | 'line' | 'points', material: number | undefined, color?: Vec3): string {
    const key = `${kind}:${material}:${color}`;
    let id = this.materialIds.get(key);
    if (id) return id;
    id = this.uuid();
    this.materialIds.set(key, id);
    const m = material === undefined ? undefined : this.scene.materials[material];
    const c = color ?? m?.color ?? this.defaultColor;
    const opacity = m?.opacity ?? 1;
    const json: Json = {
      uuid: id,
      type: kind === 'mesh' ? 'MeshStandardMaterial' : kind === 'line' ? 'LineBasicMaterial' : 'PointsMaterial',
      color: hex(c),
    };
    if (m?.name) json.name = m.name;
    if (opacity < 1) { json.opacity = opacity; json.transparent = true; }
    if (kind === 'mesh' && this.opts.doubleSided) json.side = DOUBLE_SIDE;
    if (kind === 'points') { json.size = 4; json.sizeAttenuation = false; }
    if (material !== undefined && this.extras) json.userData = { material };
    this.materials.push(json);
    return id;
  }

  /**
   * The geometry for a look's triangles, how many groups it has, and its faces' ranges (the geometry's, which a look
   * with one material reusing another's has, its triangles in that one's order). A look with one material reuses any
   * geometry of its mesh (its material repeated for each group); others share one with the same triangles in the
   * same order.
   */
  private faceGeometry(look: Look, name: string): { uuid: string; groups: number; faces: Look['faces'] } {
    let list = this.faceGeometries.get(look.mesh);
    if (!list) this.faceGeometries.set(look.mesh, (list = []));
    if (look.groups.length === 1 && list.length) return list[0]!;
    const ranges = look.groups.map((g) => `${g.start}+${g.count}`).join(',');
    const same = (a: Uint32Array, b: Uint32Array) => a === b || (
      a.length === b.length && a.every((x, i) => x === b[i]));
    const known = list.find((g) => g.ranges === ranges && same(g.indices, look.indices));
    if (known) return known;
    const g: Geometry = { uuid: this.uuid(), name, attributes: [{ name: 'position', array: look.mesh.positions }],
      index: look.indices };
    if (look.mesh.normals) g.attributes.push({ name: 'normal', array: look.mesh.normals });
    if (look.groups.length > 1) g.groups = look.groups.map(
      (gr, i) => ({ start: gr.start, count: gr.count, materialIndex: i }));
    this.geometries.push(g);
    const made = { uuid: g.uuid, groups: look.groups.length, ranges, indices: look.indices, faces: look.faces };
    list.push(made);
    return made;
  }

  private linesGeometry(mesh: Mesh, what: 'edges' | 'curves' | 'points', name: string): { uuid: string;
    userData: Json } | undefined {
    let byWhat = this.lineGeometry.get(mesh);
    if (!byWhat) this.lineGeometry.set(mesh, (byWhat = new Map()));
    if (byWhat.has(what)) return byWhat.get(what);
    let made: { uuid: string; userData: Json } | undefined;
    if (what === 'points') {
      const n = mesh.pointSources!.length;
      const g: Geometry = { uuid: this.uuid(), name, attributes: [{ name: 'position', array: mesh.points! }],
        index: Uint32Array.from({ length: n }, (_, i) => i) };
      this.geometries.push(g);
      made = { uuid: g.uuid, userData: { points: mesh.pointSources! } };
    } else {
      const positions = what === 'edges' ? mesh.edgePositions! : mesh.curvePositions!;
      const lines = what === 'edges' ? mesh.edges!.filter((e) => this.edgeKinds.has(e.kind)) : mesh.curves!;
      const { index, ranges } = segments(lines);
      if (index.length) {
        const g: Geometry = { uuid: this.uuid(), name, attributes: [{ name: 'position', array: positions }], index };
        this.geometries.push(g);
        const list = lines.map((l: { source: number | null; kind?: string; dihedral?: number }, i) => {
          const out: Json = { source: l.source, start: ranges[i]!.start, count: ranges[i]!.count };
          if (l.kind !== undefined) out.kind = l.kind;
          if (l.dihedral !== undefined) out.dihedral = l.dihedral;
          return out;
        });
        made = { uuid: g.uuid, userData: what === 'edges' ? { edges: list } : { curves: list } };
      }
    }
    byWhat.set(what, made);
    return made;
  }

  private sourced(sources: SourceId[], properties: Record<string, PropertyValue>): Json {
    const u: Json = {};
    if (sources.length) u.sources = sources.map((s) => ({ format: s.format, id: s.id }));
    if (Object.keys(properties).length) u.properties = properties;
    return u;
  }

  private part(p: ExportNode['parts'][number]): Json {
    const look = this.view.looks[p.look]!;
    const part = this.scene.parts[look.part]!;
    const children: Json[] = [];
    const lines = (what: 'edges' | 'curves' | 'points') => {
      const g = this.linesGeometry(look.mesh, what, `${part.name} ${what}`);
      if (!g) return;
      const material = what === 'edges' ? this.material('line', undefined, this.edgeColor) : this.material(
        what === 'points' ? 'points' : 'line', look.material);
      children.push({ uuid: this.uuid(), type: what === 'points' ? 'Points' : 'LineSegments', name: what,
        geometry: g.uuid, material, ...(this.extras ? { userData: g.userData } : {}) });
    };
    if (look.edges) lines('edges');
    if (look.curves && look.mesh.curves?.length) lines('curves');
    if (look.curves && look.mesh.pointSources?.length) lines('points');
    const userData: Json = { part: look.part, ...(part.closed === undefined ? {} : { closed: part.closed }),
      ...this.sourced(part.sources, part.properties), ...partExtras(part, look.lod) };
    const o: Json = { uuid: this.uuid(), type: 'Group', name: part.name, matrix: matrix(p.transform) };
    if (look.groups.length) {
      o.type = 'Mesh';
      const g = this.faceGeometry(look, part.name);
      o.geometry = g.uuid;
      const mats = look.groups.map((gr) => this.material('mesh', gr.material));
      o.material = g.groups === 1 ? mats[0] : look.groups.length === 1 ? Array<string>(g.groups).fill(mats[0]!) : mats;
      // (The geometry's ranges: a reused geometry's triangles are in its own order.)
      userData.faces = g.faces.map((f) => ({ source: f.source, start: f.start, count: f.count }));
    }
    if (!p.visible) o.visible = false;
    if (this.extras) o.userData = userData;
    if (children.length) o.children = children;
    return o;
  }

  private node(n: ExportNode): Json {
    const comp = this.scene.components[n.component]!;
    const userData: Json = { ...this.sourced(n.occurrence.sources, n.occurrence.properties) };
    userData.component = { index: n.component, name: comp.name, ...this.sourced(comp.sources, comp.properties) };
    if (comp.external) userData.external = { uri: comp.external.uri,
      ...(comp.external.format ? { format: comp.external.format } : {}) };
    const children = [...n.parts.map((p) => this.part(p)), ...n.children.map((c) => this.node(c))];
    const o: Json = { uuid: this.uuid(), type: 'Group', name: n.name, matrix: matrix(n.transform),
      ...(this.extras ? { userData } : {}) };
    if (children.length) o.children = children;
    return o;
  }

  root(): Json {
    const o: Json = { uuid: this.uuid(), type: 'Group', name: this.opts.name ?? '', matrix: matrix(ROOT_TRANSFORM) };
    if (this.extras) o.userData = { unit: 'millimetre', up: 'z',
      ...(Object.keys(this.scene.properties).length ? { properties: this.scene.properties } : {}) };
    const children = this.view.roots.map((n) => this.node(n));
    if (children.length) o.children = children;
    return o;
  }
}
