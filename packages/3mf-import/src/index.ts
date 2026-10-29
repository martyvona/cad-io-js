// 3MF (core specification, the Materials extension's colours, the Production extension's model parts) to the scene
// model (the user, 2026-10-29; CLAUDE.md, "Decisions": 3MF import), read by our own zip and XML readers in pieces.
// The scene is built directly, as 3MF already separates definitions from uses: mesh objects are parts (one level
// from the source), components objects components, and the build's items the root's placements; a build of one
// components object is the root itself, else one root component holds the items. Vertices stay in their model
// part's unit (the part's `unit`), and transforms carry the conversion to millimetres; a transform is in the unit of
// the model part it's written in, and an object in another model part (the Production extension) is converted from
// that part's unit first (the extension doesn't say; each part's `unit` is honoured).
//
//   faces and normals: mesh.ts (a face per colour; normals by a crease angle).
//   closed: `type="model"` true (3MF requires a closed manifold), `surface` false, other types unknown.
//   colours: basematerials (with alpha) and colorgroup, sRGB; other property groups (textures, composites,
//     multiproperties) are noted, and what uses them has no colour of its own.
//   properties: an object's or item's type, part number, Production UUID and metadata (by name as written).

import { identity, multiply, scaling, type Component, type Diagnostic, type Mat4, type Material, type Occurrence,
  type Part, type PartRef, type Properties, type Scene, type SourceId } from 'cad-scene';
import { readModel, type ItemDef, type ModelFile, type ObjectDef } from './model.ts';
import { XmlTokenizer } from './xml.ts';
import { entryText, inflateEntry, partKey, readZip, type ZipEntry } from './zip.ts';

export interface ThreeMfImportOptions {
  /** Edges between triangles whose normals differ by more than this (radians) shade sharp. Default 30 degrees. */
  creaseAngle?: number;
}

export interface ThreeMfImport {
  scene: Scene;
  diagnostics: Diagnostic[];
}

export const DEFAULT_CREASE_ANGLE = Math.PI / 6;
const MODEL_RELATIONSHIP = 'http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel';
const DEFAULT_ROOT = '3D/3dmodel.model';

/** Reads a 3MF package. Problems in the file are diagnostics. */
export function import3mf(input: Uint8Array, opts: ThreeMfImportOptions = {}): ThreeMfImport {
  const diagnostics: Diagnostic[] = [];
  const scene: Scene = { unit: 'millimetre', components: [], roots: [], parts: [], materials: [], layers: [],
    overrides: [], properties: { format: '3mf' }, diagnostics };
  const warn = (message: string, source?: SourceId) => diagnostics.push({ severity: 'warning', message,
    ...(source ? { source } : {}) });
  const fail = (message: string) => {
    diagnostics.push({ severity: 'error', message });
    return { scene, diagnostics };
  };

  let zip: Map<string, ZipEntry>;
  try {
    zip = readZip(input);
  } catch (e) {
    return fail(`not a 3MF package: ${(e as Error).message}`);
  }
  const rootPath = rootModel(input, zip, warn);
  const crease = opts.creaseAngle ?? DEFAULT_CREASE_ANGLE;
  const files = new Map<string, ModelFile | undefined>();
  const load = (path: string): ModelFile | undefined => {
    const key = partKey(path);
    if (files.has(key)) return files.get(key);
    const e = zip.get(key);
    let file: ModelFile | undefined;
    if (!e) warn(`model part ${path} is not in the package`);
    else {
      try {
        const decoder = new TextDecoder();
        file = readModel(e.name, (piece) => {
          inflateEntry(input, e, (bytes) => piece(decoder.decode(bytes, { stream: true })));
          piece(decoder.decode());
        }, crease, diagnostics);
      } catch (err) {
        warn(`model part ${path} could not be read: ${(err as Error).message}`);
      }
    }
    files.set(key, file);
    return file;
  };
  const root = load(rootPath);
  if (!root) return fail(`no model: the package's model part ${rootPath} could not be read`);

  const sourceOf = (f: ModelFile, id: number): SourceId => ({ format: f === root ? '3mf' : `3mf:/${f.path}`, id });
  const propertiesOf = (o: { type?: string; partnumber?: string; uuid?: string; metadata: Record<string, string> }):
    Properties => ({ ...(o.type !== undefined ? { type: o.type } : {}),
      ...(o.partnumber !== undefined ? { partNumber: o.partnumber } : {}), ...(o.uuid ? { uuid: o.uuid } : {}),
      ...(Object.keys(o.metadata).length ? { metadata: o.metadata } : {}) });

  // Scene materials, one per property group entry used.
  const materials = new Map<string, number | undefined>();
  const material = (f: ModelFile, pid: number, at: number, by: SourceId): number | undefined => {
    const key = `${f.path}#${pid}:${at}`;
    if (materials.has(key)) return materials.get(key);
    const g = f.groups.get(pid);
    let m: number | undefined;
    if (!g) warn(`${f.path}: property group ${pid} isn't defined: no colour`, by);
    else if (g.kind !== 'basematerials' && g.kind !== 'colorgroup') {
      if (![...materials.keys()].some((k) => k.startsWith(`${f.path}#${pid}:`))) warn(`${f.path}: colours from `
        + `${g.kind} ${pid} aren't read: no colour`, by);
    } else if (!g.entries[at]) warn(`${f.path}: property group ${pid} has no entry ${at}: no colour`, by);
    else {
      const e = g.entries[at];
      const made: Material = { color: e.color, opacity: e.opacity, sources: [sourceOf(f, pid)],
        ...(e.name ? { name: e.name } : {}) };
      m = scene.materials.push(made) - 1;
    }
    materials.set(key, m);
    return m;
  };

  const parts = new Map<ObjectDef, number>();
  const part = (f: ModelFile, o: ObjectDef): number => {
    let k = parts.get(o);
    if (k !== undefined) return k;
    const src = sourceOf(f, o.id);
    if (!o.mesh) warn(`${f.path}: object ${o.id} has no triangles`, src);
    const own = o.pid !== undefined ? material(f, o.pid, o.pindex ?? 0, src) : undefined;
    const faceMaterials = (o.mesh?.faceProperties ?? []).flatMap((p, face) => {
      const m = p ? material(f, p[0], p[1], src) : undefined;
      return m !== undefined && m !== own ? [{ face, material: m }] : [];
    });
    const p: Part = { name: o.name ?? `object ${o.id}`, sources: [src], properties: propertiesOf(o), unit: f.unit,
      origin: o.mesh ? [...o.mesh.mesh.origin] : [0, 0, 0], lods: o.mesh ? [{ mesh: o.mesh.mesh, from: 'source' }] : [],
      ...(own !== undefined ? { material: own } : {}), ...(faceMaterials.length ? { faceMaterials } : {}),
      ...(o.type === 'model' ? { closed: true } : o.type === 'surface' ? { closed: false } : {}) };
    parts.set(o, (k = scene.parts.push(p) - 1));
    return k;
  };

  /** What a component or item refers to: its model part and object, or undefined (said). */
  const target = (f: ModelFile, c: { objectid: number; path?: string }, what: string, src?: SourceId) => {
    let tf: ModelFile | undefined = f;
    if (c.path !== undefined) {
      if (f !== root) {
        warn(`${f.path}: a ${what} referring to another model part (${c.path}), which only the root model may `
          + 'do: skipped', src);
        return undefined;
      }
      tf = load(c.path);
      if (!tf) return undefined;
    }
    const o = tf.objects.get(c.objectid);
    if (!o) {
      warn(`${tf.path}: a ${what} refers to object ${c.objectid}, which isn't defined: skipped`, src);
      return undefined;
    }
    return { file: tf, object: o };
  };
  /** A part's placement: from its numbers (unit `ut`) to the referring part's unit, through M, to millimetres. */
  const toParent = (m: Mat4, ur: number, ut: number) => multiply(multiply(scaling(ur), m), scaling(ut / ur));

  const components = new Map<ObjectDef, number>();
  const building = new Set<ObjectDef>();
  const component = (f: ModelFile, o: ObjectDef): number | undefined => {
    const src = sourceOf(f, o.id);
    if (building.has(o)) { warn(`${f.path}: object ${o.id} contains itself: the inner use skipped`, src); return; }
    const done = components.get(o);
    if (done !== undefined) return done;
    building.add(o);
    const comp: Component = { name: o.name ?? `object ${o.id}`, sources: [src], properties: propertiesOf(o),
      parts: [], children: [] };
    const index = scene.components.push(comp) - 1;
    components.set(o, index);
    for (const c of o.components!) {
      const t = target(f, c, 'component', src);
      if (!t) continue;
      if (t.object.components) {
        const child = component(t.file, t.object);
        if (child !== undefined) comp.children.push(occurrence(child, t, c.transform, f.unit, c.uuid));
      } else comp.parts.push({ part: part(t.file, t.object), transform: toParent(c.transform, f.unit, t.file.unit) });
    }
    building.delete(o);
    return index;
  };
  const occurrence = (child: number, t: { file: ModelFile; object: ObjectDef }, m: Mat4, ur: number,
    uuid: string | undefined, item?: ItemDef): Occurrence => ({ component: child,
    transform: multiply(multiply(scaling(ur), m), scaling(1 / ur)), ...(t.object.name ? { name: t.object.name } : {}),
    sources: [sourceOf(t.file, t.object.id)], properties: item ? propertiesOf(item) : uuid ? { uuid } : {} });

  // The build: one components item is the root; anything else, a root component holding the items.
  const items = root.build.flatMap((item) => {
    const t = target(root, item, 'build item');
    return t ? [{ item, ...t }] : [];
  });
  if (items.length === 1 && items[0]!.object.components) {
    const { item, file, object } = items[0]!;
    const c = component(file, object);
    if (c !== undefined) scene.roots.push(occurrence(c, { file, object }, item.transform, root.unit, item.uuid, item));
  } else if (items.length) {
    const top: Component = { name: root.metadata.Title || 'build', sources: [], properties: {}, parts: [],
      children: [] };
    const index = scene.components.push(top) - 1;
    for (const { item, file, object } of items) {
      if (object.components) {
        const c = component(file, object);
        if (c !== undefined) top.children.push(occurrence(c, { file, object }, item.transform, root.unit, item.uuid,
          item));
      } else {
        const ref: PartRef = { part: part(file, object), transform: toParent(item.transform, root.unit, file.unit) };
        top.parts.push(ref);
      }
    }
    scene.roots.push({ component: index, transform: identity(), sources: [], properties: {} });
  } else warn('the build has no items: nothing to show');

  scene.properties = { format: '3mf', unit: root.unitName,
    ...(Object.keys(root.metadata).length ? { metadata: root.metadata } : {}),
    ...(root.buildUuid ? { uuid: root.buildUuid } : {}) };
  return { scene, diagnostics };
}

/** The root model part's path, by the package's relationships (else the usual path, said). */
function rootModel(input: Uint8Array, zip: Map<string, ZipEntry>, warn: (m: string) => void): string {
  const rels = zip.get(partKey('_rels/.rels'));
  let found: string | undefined;
  if (rels) {
    try {
      new XmlTokenizer({
        start: (name, attrs) => {
          if (found || name.replace(/^.*:/, '') !== 'Relationship') return;
          let type: string | undefined, targetPath: string | undefined;
          for (let i = 0; i < attrs.length; i += 2) {
            if (attrs[i] === 'Type') type = attrs[i + 1];
            if (attrs[i] === 'Target') targetPath = attrs[i + 1];
          }
          if (type === MODEL_RELATIONSHIP && targetPath) found = targetPath;
        },
        end: () => {}, problem: () => {},
      }).feed(entryText(input, rels));
    } catch (e) {
      warn(`the package's relationships could not be read: ${(e as Error).message}`);
    }
  }
  if (!found) warn(`the package's relationships name no 3D model: ${DEFAULT_ROOT} read`);
  return found ?? DEFAULT_ROOT;
}
