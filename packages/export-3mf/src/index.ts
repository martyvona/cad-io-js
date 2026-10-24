// Scene model -> 3MF (core specification 1.4.0), zipped with fflate. See README.md,
// "`stepconv`" (what each format holds), and CLAUDE.md, "Decisions" and "JavaScript, Node and the libraries" (lib3mf).
//
//   meshes: each part mesh's vertices welded by position, exactly (OCCT gives a shared edge's nodes the same
//     coordinates on both faces, and welding within a tolerance merges distinct vertices: the step 5 survey), and the
//     triangles welding made degenerate dropped; then a mesh object per look, its triangles' properties its groups'
//     materials. Vertices are in the part's unit, relative to its origin, as the scene has them; the transforms
//     scale and place them (`unit="millimeter"`). A mesh that isn't a closed, oriented manifold of positive volume
//     (what a `model` object must be) is left out with a warning, or written as a `surface` object (CLAUDE.md,
//     "Decisions").
//   build: an item per placed part at its world transform, its path in the instance tree as its part number and, on
//     request (`extras`), its names in our metadata (decided by the user, 2026-10-21; extras 2026-10-24); or
//     (`build: 'assembly'`) one item, an object whose components follow the instance tree, identical subtrees
//     shared.
//   colours: one basematerials group (sRGB displaycolor with alpha), or (`colors: 'colorgroup'`) the Materials and
//     Properties extension's colorgroup (opaque), declared but not required (decided by the user, 2026-10-21).
//
// Hidden part instances are left out (3MF has no visibility), or with `hidden: 'keep'` written as ordinary parts.
// The model part is written and compressed in pieces, so its size isn't bound by the longest string V8 allows.

import { Zip, ZipDeflate, strToU8 } from 'fflate';
import { identity, manifoldProblems, multiply, weld, type Diagnostic, type ExportNode, type ExportView, type Look,
  type Mat4, type Mesh, type Scene, type Vec3 } from 'cad-scene';

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
  /** Our metadata: each item's path of names (`cadio:path`). Default false: other systems don't read it. */
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
  return new Writer(scene, view, opts).write();
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

  write(): ThreeMfResult {
    const chunks: Uint8Array[] = [];
    const zip = new Zip((err, data) => {
      if (err) throw err;
      chunks.push(data);
    });
    for (const [file, text] of [['[Content_Types].xml', CONTENT_TYPES], ['_rels/.rels', RELS]] as const) {
      entry(zip, file).push(strToU8(text), true);
    }

    // What gets written: the placed parts (with their world transforms) whose looks have an object.
    const placed: { node: ExportNode; names: string[]; index: number; look: number; world: Mat4 }[] = [];
    const walk = (n: ExportNode, parent: Mat4, above: string[]) => {
      const t = multiply(parent, n.transform);
      const names = [...above, n.name];
      const props = this.scene.components[n.component]!.properties;
      n.parts.forEach((p, index) => {
        const part = this.view.looks[p.look]!.part;
        if (typeof props.partNumber === 'string' && !this.partNumbers.has(part)) this.partNumbers.set(part,
          props.partNumber);
        if (!p.visible && this.opts.hidden !== 'keep') { this.hiddenLeftOut++; return; }
        if (this.usable(p.look)) placed.push({ node: n, names, index, look: p.look, world: multiply(t, p.transform) });
      });
      for (const c of n.children) walk(c, t, names);
    };
    for (const r of this.view.roots) walk(r, identity(), []);

    const colorgroup = this.opts.colors === 'colorgroup';
    const extras = this.opts.extras ?? false;
    const model = new ModelStream(zip);
    model.push(`<?xml version="1.0" encoding="UTF-8"?>\n<model unit="millimeter" xml:lang="und" xmlns="${CORE}"`
      + `${colorgroup ? ` xmlns:m="${MATERIAL}"` : ''}${extras ? ` xmlns:cadio="${METADATA_NAMESPACE}"` : ''}>\n`);
    if (this.opts.name) model.push(`<metadata name="Title">${xmlText(this.opts.name, true)}</metadata>\n`);
    model.push('<metadata name="Application">cad-io-js export-3mf</metadata>\n<resources>\n');

    // Material slots first (the group comes before the objects that use it), then the objects.
    for (const p of placed) for (const g of this.view.looks[p.look]!.groups) this.slot(g.material);
    if (this.slots.size) model.push(this.materialGroup(colorgroup));
    for (const p of placed) this.object(p.look, model);
    const items: string[] = [];
    if (this.opts.build === 'assembly') {
      const roots = this.view.roots.map((r) => ({ id: this.assembly(r, model), transform: r.transform })).filter(
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
        const names = [...p.names, this.scene.parts[this.view.looks[p.look]!.part]!.name];
        const transform = isIdentity(p.world) ? '' : ` transform="${transformText(p.world)}"`;
        items.push(`<item objectid="${this.lookObjects.get(p.look)}"${transform}`
          + ` partnumber="${xmlText(`${p.node.path.join('.')}:${p.index}`)}"${extras ? `><metadatagroup><metadata `
            + `name="cadio:path">${xmlText(names.join(' / '), true)}</metadata></metadatagroup></item>` : '/>'}\n`);
      }
    }
    model.push('</resources>\n<build>\n');
    for (const i of items) model.push(i);
    model.push('</build>\n</model>\n');
    model.flush(true);
    zip.end();

    this.report(colorgroup);
    return { chunks, diagnostics: this.diagnostics };
  }

  private report(colorgroup: boolean): void {
    for (const [part, problems] of this.failedParts) {
      const p = this.scene.parts[part]!;
      const what = this.opts.nonManifold === 'surface' ? 'written as a surface object' : 'left out';
      this.diagnostics.push({
        severity: 'warning',
        message: `part '${p.name}' is not a closed, oriented manifold (${problems.join(', ')}); ${what}`,
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

  /** Whether a look has an object: triangles, and a closed manifold unless surfaces are written. */
  private usable(look: number): boolean {
    const l = this.view.looks[look]!;
    if (!l.groups.length) return false;
    const s = this.solid(l.mesh);
    if (!s.triangles) return false;
    if (s.problems.length) {
      this.failedParts.set(l.part, s.problems);
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
    model.push(`<object id="${id}" type="${s.problems.length ? 'surface' : 'model'}" name="${xmlText(part.name)}"`
      + `${number ? ` partnumber="${xmlText(number)}"` : ''} pid="1" pindex="${slot}"><mesh><vertices>\n`);
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

  /** A components object for a node (assembly build), shared by identical subtrees; undefined if it has nothing. */
  private readonly assemblies = new Map<string, number>();
  private assembly(n: ExportNode, model: ModelStream): number | undefined {
    const parts: string[] = [];
    for (const p of n.parts) {
      const id = this.lookObjects.get(p.look);
      if (id !== undefined && (p.visible || this.opts.hidden === 'keep')) parts.push(component(id, p.transform));
    }
    for (const c of n.children) {
      const id = this.assembly(c, model);
      if (id !== undefined) parts.push(component(id, c.transform));
    }
    if (!parts.length) return undefined;
    const body = `name="${xmlText(n.name)}"><components>\n${parts.join('')}</components></object>\n`;
    let id = this.assemblies.get(body);
    if (id === undefined) {
      this.assemblies.set(body, (id = this.nextId++));
      model.push(`<object id="${id}" ${body}`);
    }
    return id;
  }
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
