// Scene model -> 3MF (core specification 1.4.0), zipped with fflate. See README.md (what each format holds) and
// docs/claude/scene-formats.md.
//
//   meshes: each part mesh's vertices welded by position, exactly (OCCT gives a shared edge's nodes the same
//     coordinates on both faces, and welding within a tolerance merges distinct vertices: the step 5 survey), and the
//     triangles welding made degenerate dropped; then a mesh object per look, its triangles' properties its groups'
//     materials. Vertices are in the part's unit, relative to its origin, as the scene has them; the transforms scale
//     and place them, in the source's unit where 3MF has a name for it (`unit="inch"`), else millimetres. A mesh that
//     isn't a closed, oriented manifold of positive volume (what a `model` object must be), or whose part the source
//     says is open (its `closed` false: an open shell), is left out with a warning, or written as a `surface` object.
//   build: an item per placed part (the scene's root parts first) at its world transform, its path in the instance tree
//     as its part number (`<path>:<index>`, the path empty for a root part) and, on request (`extras`), its names in
//     our metadata, and the model's metadata the tree itself (`cadio:tree`: each node's name, transform and the extras
//     export-gltf gives its nodes, each placed part by its item), so 3mf-import rebuilds the scene; with extras in
//     either mode, the colour slots' scene materials (`cadio:materials`: null for the default colour); or (`build:
//     'assembly'`) one item, an object whose components follow the instance tree, identical subtrees shared.
//   faces (with extras): each object's triangles' faces as runs (`cadio:faces`), which 3MF itself can't hold.
//   colours: one basematerials group (sRGB displaycolor with alpha), or (`colors: 'colorgroup'`) the Materials and
//     Properties extension's colorgroup (opaque), declared but not required.
//
// Hidden part instances are left out (3MF has no visibility), or with `hidden: 'keep'` written as ordinary parts.
// The model part is written and compressed in pieces, so its size isn't bound by the longest string V8 allows.

import { Zip, ZipDeflate, strToU8 } from 'fflate';
import { drain, identity, manifoldProblems, multiply, paced, partExtras, placedName, placementJson, scaling,
  sceneJson, standardMetadata, weld, type Diagnostic, type ExportNode, type ExportPart, type ExportView, type Look,
  type Mat4, type Mesh, type PropertyValue, type Scene, type SourceId, type Vec3 } from 'cad-scene';

export interface ThreeMfOptions {
  /** Colour of faces without a material (sRGB). Default light grey. */
  defaultColor?: Vec3;
  /** The model's title (metadata). */
  name?: string;
  /** basematerials (default; display colours with alpha) or the Materials extension's colorgroup (opaque). */
  colors?: 'basematerials' | 'colorgroup';
  /** An item per placed part (default), or one item for the scene with components following the instance tree. */
  build?: 'parts' | 'assembly';
  /** Meshes that aren't closed, oriented manifolds: left out (default), or written as `surface` objects. */
  nonManifold?: 'omit' | 'surface';
  /** Hidden part instances: left out (default), or written as ordinary parts. */
  hidden?: 'omit' | 'keep';
  /**
   * Our metadata: each item's path of names (`cadio:path`), and with an item per placed part the tree and the colour
   * slots' materials (`cadio:tree`, `cadio:materials`), from which 3mf-import rebuilds the scene. Default false:
   * other systems don't read it.
   */
  extras?: boolean;
}

export interface ThreeMfResult {
  /** The zip, in pieces. */
  chunks: Uint8Array[];
  diagnostics: Diagnostic[];
}

/** The namespace of our metadata names (the core spec wants names outside its list prefixed with one). */
export const METADATA_NAMESPACE = 'urn:cad-io-js:3mf';
const CORE = 'http://schemas.microsoft.com/3dmanufacturing/core/2015/02';
const MATERIAL = 'http://schemas.microsoft.com/3dmanufacturing/material/2015/02';
const MODEL_PATH = '3D/3dmodel.model';
const CONTENT_TYPES = '<?xml version="1.0" encoding="UTF-8"?>\n<Types '
  + 'xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
  + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
  + '<Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>\n';
const RELS = '<?xml version="1.0" encoding="UTF-8"?>\n<Relationships '
  + 'xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
  + `<Relationship Target="/${MODEL_PATH}" Id="rel0" `
    + `Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>\n`;
/** The zip entries' time, fixed so the same scene gives the same bytes (local time, as zip's DOS times are). */
const MTIME = new Date(1980, 0, 1);
/** Text is encoded and compressed in pieces of about this many characters. */
const PIECE = 1 << 20;

/** The scene's export view as a 3MF package. */
export function threemf(scene: Scene, view: ExportView, opts: ThreeMfOptions = {}): ThreeMfResult {
  return drain(new Writer(scene, view, opts).write());
}

/**
 * The same, pausing (`pause`, awaited) now and then between objects, so the thread can do other things meanwhile (the
 * viewer's import worker sends its heartbeat then); the same bytes.
 */
export function threemfAsync(scene: Scene, view: ExportView, pause: () => Promise<void>,
  opts: ThreeMfOptions = {}): Promise<ThreeMfResult> {
  return paced(new Writer(scene, view, opts).write(), pause);
}

/** The shortest decimal that reads back as the same float32. */
export function float32Text(x: number): string {
  for (let p = 6; p < 9; p++) {
    const s = Number(x.toPrecision(p));
    if (Math.fround(s) === x) return String(s);
  }
  return String(Number(x.toPrecision(9)));
}

/** A transform as 3MF writes it: the first three rows of the row-vector matrix, so our column-major columns 0-3. */
export function transformText(m: Mat4): string {
  return [0, 1, 2, 4, 5, 6, 8, 9, 10, 12, 13, 14].map((i) => String(m[i]! + 0)).join(' ');
}

const isIdentity = (m: Mat4) => m.every((x, i) => x === (i % 5 === 0 ? 1 : 0));

/**
 * Text for an XML attribute (or, `content`, an element's content); characters XML 1.0 can't carry are dropped. Only
 * the named entities: lib3mf 2.5.0 refuses numeric character references ("XML contains an invalid escape
 * character"), so an attribute's tabs and line breaks become spaces (as XML's attribute normalization would read
 * them anyway), and content keeps them as they are.
 */
export function xmlText(s: string, content = false): string {
  // Characters XML 1.0 doesn't allow: controls other than tab, LF and CR; U+FFFE, U+FFFF; lone surrogates.
  const kept = s.replace(new RegExp(String.raw`[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]`
    + String.raw`|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]`, 'g'), '');
  const escaped = kept.replace(/[&<>"]/g, (c) => ENTITIES[c]!);
  return content ? escaped : escaped.replace(/[\t\n\r]/g, ' ');
}
const ENTITIES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };

const hex = (c: number) => Math.round(Math.min(1, Math.max(0, c)) * 255).toString(16).padStart(2, '0').toUpperCase();

/** A part mesh welded once for all its looks: positions, each old vertex's new index, and its status. */
interface Solid {
  positions: Float32Array;
  remap: Uint32Array;
  triangles: number;
  degenerate: number;
  problems: string[];
}

/** The model part's text, compressed as it's written. */
class ModelStream {
  private pieces: string[] = [];
  private length = 0;
  private readonly encoder = new TextEncoder();
  private readonly entry: ZipDeflate;

  constructor(zip: Zip) {
    this.entry = entry(zip, MODEL_PATH);
  }

  push(s: string): void {
    this.pieces.push(s);
    this.length += s.length;
    if (this.length >= PIECE) this.flush(false);
  }

  flush(final: boolean): void {
    this.entry.push(this.encoder.encode(this.pieces.join('')), final);
    this.pieces = [];
    this.length = 0;
  }
}

/** A placed part written: its tree node (none for a root part), the names along its path, and its world transform. */
type Placed = { node: ExportNode | undefined; names: string[]; index: number; look: number; part: ExportPart;
  world: Mat4 };

class Writer {
  private readonly diagnostics: Diagnostic[] = [];
  private readonly solids = new Map<Mesh, Solid>();
  /** Material slots by scene material (undefined: the default colour), in order of first use. */
  private readonly slots = new Map<number | undefined, number>();
  private readonly lookObjects = new Map<number, number | undefined>();
  private nextId = 2; // 1 is the material group
  private hiddenLeftOut = 0;
  private readonly failedParts = new Map<number, string[]>();
  private readonly scene: Scene;
  private readonly view: ExportView;
  private readonly opts: ThreeMfOptions;
  /** A part number per part: its first placing component's. */
  private readonly partNumbers = new Map<number, string>();

  constructor(scene: Scene, view: ExportView, opts: ThreeMfOptions) {
    this.scene = scene;
    this.view = view;
    this.opts = opts;
  }

  /** The package, an object at a time (a step each: `drain` or `paced`). */
  *write(): Generator<void, ThreeMfResult> {
    const chunks: Uint8Array[] = [];
    const zip = new Zip((err, data) => {
      if (err) throw err;
      chunks.push(data);
    });
    for (const [file, text] of [['[Content_Types].xml', CONTENT_TYPES], ['_rels/.rels', RELS]] as const) {
      entry(zip, file).push(strToU8(text), true);
    }

    // What gets written: the placed parts (with their world transforms) whose looks have an object; a root part's
    // node undefined.
    const placed: Placed[] = [];
    const place = (n: ExportNode | undefined, p: ExportPart, t: Mat4, names: string[]) => {
      const part = this.view.looks[p.look]!.part;
      // (The part number of the product it places, else of the component holding it.)
      const props = p.ref.product?.properties ?? (n ? this.scene.components[n.component]!.properties : {});
      if (typeof props.partNumber === 'string' && !this.partNumbers.has(part)) this.partNumbers.set(part,
        props.partNumber);
      if (!p.visible && this.opts.hidden !== 'keep') { this.hiddenLeftOut++; return; }
      if (this.usable(p.look)) placed.push({ node: n, names, index: p.index, look: p.look, part: p,
        world: multiply(t, p.transform) });
    };
    const walk = (n: ExportNode, parent: Mat4, above: string[]) => {
      const t = multiply(parent, n.transform);
      const names = [...above, n.name];
      for (const p of n.parts) place(n, p, t, names);
      for (const c of n.children) walk(c, t, names);
    };
    for (const p of this.view.parts) place(undefined, p, identity(), []);
    for (const r of this.view.roots) walk(r, identity(), []);

    const colorgroup = this.opts.colors === 'colorgroup';
    const extras = this.opts.extras ?? false;
    const model = new ModelStream(zip);
    model.push(`<?xml version="1.0" encoding="UTF-8"?>\n<model unit="${this.unit.name}" xml:lang="und" xmlns="${CORE}"`
      + `${colorgroup ? ` xmlns:m="${MATERIAL}"` : ''}${extras ? ` xmlns:cadio="${METADATA_NAMESPACE}"` : ''}>\n`);
    // The core spec's metadata, from the source's (standardMetadata), with or without our extras; the title given
    // first.
    const standard = { ...standardMetadata(this.scene.properties),
      ...(this.opts.name ? { Title: this.opts.name } : {}) };
    for (const k of ['Title', 'Designer', 'Description', 'Copyright', 'LicenseTerms', 'Rating',
      'CreationDate'] as const) {
      const v = standard[k];
      if (v) model.push(`<metadata name="${k}">${xmlText(v, true)}</metadata>\n`);
    }
    model.push('<metadata name="Application">cad-io-js export-3mf</metadata>\n');

    // Material slots first (the group comes before the objects that use it), then the objects.
    for (const p of placed) for (const g of this.view.looks[p.look]!.groups) this.slot(g.material);
    if (extras) {
      const meta = (name: string, value: unknown) => model.push(`<metadata name="cadio:${name}">${xmlText(
        JSON.stringify(value), true)}</metadata>\n`);
      if (this.opts.build !== 'assembly') meta('tree', this.tree(placed));
      // (The tree holds them where it's written.)
      else if (sceneJson(this.scene).properties) meta('properties', sceneJson(this.scene).properties);
      meta('materials', [...this.slots.keys()].map((m) => m ?? null));
    }
    model.push('<resources>\n');
    if (this.slots.size) model.push(this.materialGroup(colorgroup));
    for (const p of placed) {
      this.object(p.look, model);
      yield;
    }
    const items: string[] = [];
    if (this.opts.build === 'assembly') {
      const roots = [...this.view.parts.flatMap((p) => p.visible || this.opts.hidden === 'keep'
        ? [{ id: this.placedObject(p, model), transform: this.fromPart(p.transform) }] : []),
      ...this.view.roots.map((r) => ({ id: this.assembly(r, model), transform: this.between(r.transform) }))].filter(
        (r) => r.id !== undefined);
      let id = roots[0]?.id, transform = roots[0]?.transform;
      if (roots.length > 1) {
        id = this.nextId++;
        const name = this.opts.name ? ` name="${xmlText(this.opts.name)}"` : '';
        model.push(`<object id="${id}"${name}><components>\n`
          + `${roots.map((r) => component(r.id!, r.transform)).join('')}</components></object>\n`);
        transform = identity();
      }
      if (id !== undefined) items.push(
        `<item objectid="${id}"${isIdentity(transform!) ? '' : ` transform="${transformText(transform!)}"`}/>\n`);
    } else {
      for (const p of placed) {
        const names = [...p.names, placedName(this.scene, p.part.ref)];
        const world = this.fromPart(p.world);
        const transform = isIdentity(world) ? '' : ` transform="${transformText(world)}"`;
        items.push(`<item objectid="${this.lookObjects.get(p.look)}"${transform}`
          + ` partnumber="${xmlText(`${p.node?.path.join('.') ?? ''}:${p.index}`)}"${extras
            ? '><metadatagroup><metadata '
            + `name="cadio:path">${xmlText(names.join(' / '), true)}</metadata></metadatagroup></item>` : '/>'}\n`);
      }
    }
    model.push('</resources>\n<build>\n');
    for (const [k, i] of items.entries()) {
      model.push(i);
      if (k % 1000 === 999) yield;
    }
    model.push('</build>\n</model>\n');
    model.flush(true);
    zip.end();

    this.report(colorgroup);
    return { chunks, diagnostics: this.diagnostics };
  }

  /**
   * Our tree for 3mf-import: the scene's properties, and each root's node (name, transform, the extras export-gltf
   * gives a tree node), its placed parts that were written (the part's name, its reference's transform, the extras
   * export-gltf gives a part node, its item's index; `visible: false` for a hidden one kept) and its children.
   */
  private tree(placed: Placed[]): Record<string, unknown> {
    const items = new Map<ExportNode | undefined, Map<number, number>>();
    placed.forEach((p, k) => {
      let m = items.get(p.node);
      if (!m) items.set(p.node, (m = new Map()));
      m.set(p.index, k);
    });
    const sourced = (sources: SourceId[], properties: Record<string, PropertyValue>) => ({
      ...(sources.length ? { sources: sources.map((s) => ({ format: s.format, id: s.id })) } : {}),
      ...(Object.keys(properties).length ? { properties } : {}) });
    const partsOf = (n: ExportNode | undefined, list: ExportPart[]) => list.flatMap((p) => {
      const item = items.get(n)?.get(p.index);
      if (item === undefined) return [];
      const look = this.view.looks[p.look]!, part = this.scene.parts[look.part]!;
      return [{ name: placedName(this.scene, p.ref), matrix: Array.from(p.transform), item,
        ...(p.visible ? {} : { visible: false }), extras: { part: look.part, partName: part.name,
          ...(part.closed === undefined ? {}
          : { closed: part.closed }), ...sourced(part.sources, part.properties), ...partExtras(part, look.lod),
        placement: placementJson(p.ref, p.index) } }];
    });
    const node = (n: ExportNode): Record<string, unknown> => {
      const comp = this.scene.components[n.component]!;
      const parts = partsOf(n, n.parts);
      return { name: n.name, matrix: Array.from(n.transform), extras: {
        ...sourced(n.occurrence.sources, n.occurrence.properties),
        component: { index: n.component, name: comp.name, ...sourced(comp.sources, comp.properties) }, path: n.path,
        ...(comp.external ? { external: { uri: comp.external.uri,
          ...(comp.external.format ? { format: comp.external.format } : {}) } } : {}) },
      parts, children: n.children.map(node) };
    };
    return { ...sceneJson(this.scene), parts: partsOf(undefined,
      this.view.parts), roots: this.view.roots.map(node) };
  }

  private report(colorgroup: boolean): void {
    for (const [part, problems] of this.failedParts) {
      const p = this.scene.parts[part]!;
      const what = this.opts.nonManifold === 'surface' ? 'written as a surface object' : 'left out';
      // Said closed, its mesh is what's open (a gap the mesher left).
      const said = p.closed ? ', though the source says it\'s closed' : '';
      this.diagnostics.push({
        severity: 'warning',
        message: `part '${p.name}' is not a closed, oriented manifold (${problems.join(', ')})${said}; ${what}`,
        ...(p.sources[0] ? { source: p.sources[0] } : {}),
      });
    }
    if (this.hiddenLeftOut) {
      const n = this.hiddenLeftOut;
      this.diagnostics.push({ severity: 'warning',
        message: `${n} hidden part ${n === 1 ? 'instance' : 'instances'} left out (3MF has no visibility)` });
    }
    if (colorgroup) {
      const transparent = [...this.slots.keys()].filter(
        (m) => m !== undefined && this.scene.materials[m]!.opacity < 1).length;
      if (transparent) this.diagnostics.push(
        { severity: 'warning', message: `${transparent} transparent ${transparent === 1 ? 'material' : 'materials'} `
        + `written opaque (colorgroup colours are opaque)` });
    }
    let degenerate = 0, parts = 0;
    for (const s of this.solids.values()) if (s.degenerate) { degenerate += s.degenerate; parts++; }
    if (degenerate) this.diagnostics.push(
      { severity: 'info', message: `${degenerate} degenerate ${degenerate === 1 ? 'triangle' : 'triangles'} dropped `
      + `from ${parts} part ${parts === 1 ? 'mesh' : 'meshes'} (two corners at one position)` });
  }

  private solid(mesh: Mesh): Solid {
    let s = this.solids.get(mesh);
    if (s) return s;
    const { remap, positions } = weld(mesh.positions);
    const kept: number[] = [];
    let degenerate = 0;
    const ix = mesh.indices;
    for (let t = 0; t < ix.length; t += 3) {
      const a = remap[ix[t]!]!, b = remap[ix[t + 1]!]!, c = remap[ix[t + 2]!]!;
      if (a === b || b === c || c === a) degenerate++;
      else kept.push(a, b, c);
    }
    // Only the vertices a kept triangle uses.
    const used = new Int32Array(positions.length / 3).fill(-1);
    let n = 0;
    for (const v of kept) if (used[v]! < 0) used[v] = n++;
    const compact = new Float32Array(3 * n);
    for (let v = 0; v < used.length; v++) if (used[v]! >= 0) compact.set(positions.subarray(3 * v, 3 * v + 3),
      3 * used[v]!);
    for (let v = 0; v < remap.length; v++) remap[v] = used[remap[v]!]! < 0 ? 0xffffffff : used[remap[v]!]!;
    const triangles = Uint32Array.from(kept, (v) => used[v]!);
    s = { positions: compact, remap, triangles: triangles.length / 3, degenerate,
      problems: manifoldProblems(compact, triangles) };
    this.solids.set(mesh, s);
    return s;
  }

  /** Why a look's part can't be a `model` object: its mesh's problems, and the source saying it's open. */
  private problems(look: Look): string[] {
    const open = this.scene.parts[look.part]!.closed === false ? ['an open shell in the source'] : [];
    return [...open, ...this.solid(look.mesh).problems];
  }

  /** Whether a look has an object: triangles, and a closed manifold unless surfaces are written. */
  private usable(look: number): boolean {
    const l = this.view.looks[look]!;
    if (!l.groups.length) return false;
    if (!this.solid(l.mesh).triangles) return false;
    const problems = this.problems(l);
    if (problems.length) {
      this.failedParts.set(l.part, problems);
      return this.opts.nonManifold === 'surface';
    }
    return true;
  }

  private slot(material: number | undefined): number {
    let k = this.slots.get(material);
    if (k === undefined) this.slots.set(material, (k = this.slots.size));
    return k;
  }

  private materialGroup(colorgroup: boolean): string {
    const names = new Set<string>();
    const entries = [...this.slots.keys()].map((m) => {
      const source = m === undefined ? undefined : this.scene.materials[m];
      const c = source?.color ?? this.opts.defaultColor ?? [0.8, 0.8, 0.8];
      const rgb = `#${hex(c[0])}${hex(c[1])}${hex(c[2])}`;
      if (colorgroup) return `<m:color color="${rgb}"/>`;
      // Base names SHOULD be unique (core 5.1).
      const base = source?.name || (m === undefined ? 'default' : rgb);
      let name = base;
      for (let k = 2; names.has(name); k++) name = `${base} ${k}`;
      names.add(name);
      return `<base name="${xmlText(name)}" displaycolor="${rgb}${hex(source?.opacity ?? 1)}"/>`;
    });
    return colorgroup ? `<m:colorgroup id="1">${entries.join('')}</m:colorgroup>\n` : `<basematerials `
      + `id="1">${entries.join('')}</basematerials>\n`;
  }

  /** A look's mesh object, written on first use. */
  private object(index: number, model: ModelStream): void {
    if (this.lookObjects.has(index)) return;
    const look: Look = this.view.looks[index]!;
    const s = this.solid(look.mesh);
    const part = this.scene.parts[look.part]!;
    const id = this.nextId++;
    this.lookObjects.set(index, id);
    // The object's property is its largest group's; other triangles name theirs.
    const main = look.groups.reduce((a, g) => (g.count > a.count ? g : a));
    const slot = this.slot(main.material);
    const number = this.partNumbers.get(look.part);
    model.push(`<object id="${id}" type="${this.problems(look).length ? 'surface' : 'model'}" name="${
      xmlText(part.name)}"`
      + `${number ? ` partnumber="${xmlText(number)}"` : ''} pid="1" pindex="${slot}">${this.opts.extras
        ? `<metadatagroup><metadata name="cadio:faces">${JSON.stringify(this.faceRuns(look, s))}</metadata>`
          + '</metadatagroup>' : ''}<mesh><vertices>\n`);
    const p = s.positions;
    let text = '';
    for (let v = 0; v < p.length; v += 3) {
      text += `<vertex x="${float32Text(p[v]!)}" y="${float32Text(p[v + 1]!)}" z="${float32Text(p[v + 2]!)}"/>\n`;
      if (text.length >= PIECE) { model.push(text); text = ''; }
    }
    text += '</vertices><triangles>\n';
    for (const g of look.groups) {
      const k = this.slot(g.material);
      // pid as well as p1, though the object's is the same group: lib3mf 2.5.0 ignores a triangle's p1 without one.
      const property = k === slot ? '' : ` pid="1" p1="${k}"`;
      for (let t = g.start; t < g.start + g.count; t += 3) {
        const a = s.remap[look.indices[t]!]!, b = s.remap[look.indices[t + 1]!]!, c = s.remap[look.indices[t + 2]!]!;
        if (a === b || b === c || c === a) continue;
        text += `<triangle v1="${a}" v2="${b}" v3="${c}"${property}/>\n`;
        if (text.length >= PIECE) { model.push(text); text = ''; }
      }
    }
    model.push(`${text}</triangles></mesh></object>\n`);
  }

  /**
   * Our metadata: the written triangles' faces, in their order, as runs of [face source, count] (null: none), so
   * 3mf-import gives them back the faces 3MF can't hold.
   */
  private faceRuns(look: Look, s: Solid): [number | null, number][] {
    const faceAt = new Map<number, number | null>();
    for (const f of look.faces) for (let i = f.start; i < f.start + f.count; i += 3) faceAt.set(i, f.source);
    const runs: [number | null, number][] = [];
    for (const g of look.groups) {
      for (let t = g.start; t < g.start + g.count; t += 3) {
        const a = s.remap[look.indices[t]!]!, b = s.remap[look.indices[t + 1]!]!, c = s.remap[look.indices[t + 2]!]!;
        if (a === b || b === c || c === a) continue;
        const f = faceAt.get(t) ?? null, last = runs.at(-1);
        if (last && last[0] === f) last[1]++;
        else runs.push([f, 1]);
      }
    }
    return runs;
  }

  /** A components object for a node (assembly build), shared by identical subtrees; undefined if it has nothing. */
  private readonly assemblies = new Map<string, number>();
  private assembly(n: ExportNode, model: ModelStream): number | undefined {
    const children = n.children.flatMap((c) => {
      const id = this.assembly(c, model);
      return id === undefined ? [] : [component(id, this.between(c.transform))];
    });
    const written = n.parts.filter((p) => this.lookObjects.has(p.look) && (p.visible || this.opts.hidden === 'keep'));
    // (A placed product an assembly holds alone in its own object: else the assembly, an object of one mesh object,
    // reads back as a part placed, not an assembly placing one; cad-scene's leafParts.)
    const alone = written.length === 1 && !children.length && !!written[0]!.ref.product;
    const parts = [...written.map((p) => component(this.placedObject(p, model, alone)!, this.fromPart(p.transform))),
      ...children];
    if (!parts.length) return undefined;
    return this.components(n.name, parts, model);
  }

  /**
   * The model's unit (the source's, where 3MF has a name for it; else millimetres): a transform from a part's
   * coordinates to the scene's millimetres made one to the model's unit, and one between two frames in millimetres made
   * one between the same frames in the model's unit.
   */
  private get unit(): { name: string; mm: number } {
    return modelUnit(this.scene.sourceUnit);
  }
  private fromPart(m: Mat4): Mat4 {
    return this.unit.mm === 1 ? m : multiply(scaling(1 / this.unit.mm), m);
  }
  private between(m: Mat4): Mat4 {
    return this.unit.mm === 1 ? m : multiply(multiply(scaling(1 / this.unit.mm), m), scaling(this.unit.mm));
  }

  /** A components object, written once for each name and list of components. */
  private components(name: string, parts: string[], model: ModelStream): number {
    const body = `name="${xmlText(name)}"><components>\n${parts.join('')}</components></object>\n`;
    let id = this.assemblies.get(body);
    if (id === undefined) {
      this.assemblies.set(body, (id = this.nextId++));
      model.push(`<object id="${id}" ${body}`);
    }
    return id;
  }

  /**
   * What a placed part's component names (assembly build): its look's mesh object, or where the placement has a
   * name of its own (or `wrap`: a placed product its assembly holds alone), a components object of that name
   * holding it (a 3MF component has no name; 3mf-import reads such an object back as the part placed under that
   * name, cad-scene's leafParts).
   */
  private placedObject(p: ExportPart, model: ModelStream, wrap = false): number | undefined {
    const id = this.lookObjects.get(p.look);
    const name = placedName(this.scene, p.ref);
    if (id === undefined || (!wrap && name === this.scene.parts[this.view.looks[p.look]!.part]!.name)) return id;
    return this.components(name, [component(id, identity())], model);
  }
}

/** 3MF's units, in millimetres. */
const UNITS: Record<string, number> = { micron: 0.001, millimeter: 1, centimeter: 10, inch: 25.4, foot: 304.8,
  meter: 1000 };
/** The 3MF unit of a length in millimetres (to 1e-9 of it), else millimetres. */
export function modelUnit(mm: number | undefined): { name: string; mm: number } {
  const found = mm === undefined ? undefined : Object.entries(UNITS).find(([, v]) => Math.abs(v - mm) <= 1e-9 * v);
  return found ? { name: found[0], mm: found[1] } : { name: 'millimeter', mm: 1 };
}

/** A compressed zip entry, at the fixed time. */
function entry(zip: Zip, file: string): ZipDeflate {
  const e = new ZipDeflate(file, { level: 6 });
  e.mtime = MTIME;
  zip.add(e);
  return e;
}

function component(id: number, transform: Mat4): string {
  return `<component objectid="${id}"${isIdentity(transform) ? '' : ` transform="${transformText(transform)}"`}/>\n`;
}
