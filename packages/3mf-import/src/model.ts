// One 3MF model part (an XML document, given in pieces) read into its resources and build: property groups
// (basematerials, the Materials extension's colorgroup; other groups noted, so what uses them has no colour), objects
// (a mesh, made a scene mesh as soon as it's read so its raw arrays don't outlive it, or components) and build items,
// each with its metadata. Elements of extensions that aren't read are skipped, counted and said once a kind (the
// user, 2026-10-29; CLAUDE.md, "Decisions": 3MF import, decision 5).

import { identity, type Diagnostic, type Mat4, type Mesh, type Vec3 } from 'cad-scene';
import { buildMesh } from './mesh.ts';
import { Scopes, XmlTokenizer } from './xml.ts';

export const CORE = 'http://schemas.microsoft.com/3dmanufacturing/core/2015/02';
export const MATERIAL = 'http://schemas.microsoft.com/3dmanufacturing/material/2015/02';
export const PRODUCTION = 'http://schemas.microsoft.com/3dmanufacturing/production/2015/06';

/** The extensions this reader doesn't read, by namespace, for messages. */
const EXTENSIONS: Record<string, string> = {
  'http://schemas.microsoft.com/3dmanufacturing/beamlattice/2017/02': 'beam lattice extension',
  'http://schemas.microsoft.com/3dmanufacturing/beamlattice/balls/2020/07': 'beam lattice balls extension',
  'http://schemas.microsoft.com/3dmanufacturing/slice/2015/07': 'slice extension',
  'http://schemas.microsoft.com/3dmanufacturing/securecontent/2019/04': 'secure content extension',
  'http://schemas.microsoft.com/3dmanufacturing/displacement/2022/07': 'displacement extension',
  'http://schemas.microsoft.com/3dmanufacturing/volumetric/2022/01': 'volumetric extension',
  'http://schemas.microsoft.com/3dmanufacturing/booleanoperations/2023/07': 'boolean operations extension',
  'http://schemas.microsoft.com/3dmanufacturing/implicit/2023/12': 'implicit extension',
  'http://schemas.microsoft.com/3dmanufacturing/trianglesets/2021/07': 'triangle sets extension',
  [MATERIAL]: 'materials extension',
  [CORE]: 'core specification',
};
/** Namespaces read, as `requiredextensions` may name them. */
const READ = new Set([CORE, MATERIAL, PRODUCTION]);

/** Millimetres per unit, by the model's `unit`. */
export const UNITS: Record<string, number> = { micron: 0.001, millimeter: 1, centimeter: 10, inch: 25.4, foot: 304.8,
  meter: 1000 };

export interface PropertyGroup {
  /** basematerials, colorgroup, or another kind (texture2dgroup, compositematerials, ...), read as no colour. */
  kind: string;
  entries: { color: Vec3; opacity: number; name?: string }[];
}

export interface ComponentDef {
  objectid: number;
  /** In the file's unit, column-major. */
  transform: Mat4;
  /** The Production extension's model part holding the object. */
  path?: string;
  uuid?: string;
}

export interface ItemDef extends ComponentDef {
  partnumber?: string;
  metadata: Record<string, string>;
}

export interface ObjectDef {
  id: number;
  type: string;
  name?: string;
  partnumber?: string;
  uuid?: string;
  pid?: number;
  pindex?: number;
  metadata: Record<string, string>;
  /** A mesh object's mesh (absent if it has no triangles) and each face's property, [group, index] or none. */
  mesh?: { mesh: Mesh; faceProperties: ([number, number] | undefined)[] };
  /** A components object's components. */
  components?: ComponentDef[];
}

export interface ModelFile {
  path: string;
  /** Millimetres per unit. */
  unit: number;
  unitName: string;
  metadata: Record<string, string>;
  groups: Map<number, PropertyGroup>;
  objects: Map<number, ObjectDef>;
  build: ItemDef[];
  buildUuid?: string;
}

/** A colour as 3MF writes it, `#RRGGBB` or `#RRGGBBAA` (sRGB), or undefined. */
export function parseColor(s: string | undefined): { color: Vec3; opacity: number } | undefined {
  const m = /^#([0-9a-fA-F]{6})([0-9a-fA-F]{2})?$/.exec(s ?? '');
  if (!m) return undefined;
  const x = parseInt(m[1]!, 16);
  return { color: [((x >> 16) & 255) / 255, ((x >> 8) & 255) / 255, (x & 255) / 255],
    opacity: m[2] ? parseInt(m[2], 16) / 255 : 1 };
}

/** A transform as 3MF writes it: 12 numbers, the first three columns of the row-vector matrix, then its translation. */
export function parseTransform(s: string): Mat4 | undefined {
  const x = s.trim().split(/\s+/).map(Number);
  if (x.length !== 12 || !x.every(Number.isFinite)) return undefined;
  return Float64Array.of(x[0]!, x[1]!, x[2]!, 0, x[3]!, x[4]!, x[5]!, 0, x[6]!, x[7]!, x[8]!, 0, x[9]!, x[10]!, x[11]!,
    1);
}

/** A growable typed array. */
class Grow<T extends Float64Array | Uint32Array> {
  a: T;
  n = 0;
  private readonly make: (n: number) => T;
  constructor(make: (n: number) => T) {
    this.make = make;
    this.a = make(1024);
  }
  push(x: number): void {
    if (this.n === this.a.length) {
      const b = this.make(2 * this.a.length);
      b.set(this.a);
      this.a = b;
    }
    this.a[this.n++] = x;
  }
  done(): T {
    return this.a.slice(0, this.n) as T;
  }
}

/** Our faces' runs ([source, count], ...) as a face per triangle, or undefined if they aren't `n` triangles'. */
function facesOf(text: string | undefined, n: number): (number | null)[] | undefined {
  if (text === undefined) return undefined;
  let runs: unknown;
  try { runs = JSON.parse(text); } catch { return undefined; }
  if (!Array.isArray(runs)) return undefined;
  const out: (number | null)[] = [];
  for (const r of runs) {
    if (!Array.isArray(r) || !(r[0] === null || Number.isInteger(r[0])) || !Number.isInteger(r[1]) || r[1] < 0
      || out.length + r[1] > n) return undefined;
    for (let k = 0; k < r[1]; k++) out.push(r[0]);
  }
  return out.length === n ? out : undefined;
}

const get = (attrs: string[], name: string): string | undefined => {
  for (let i = 0; i < attrs.length; i += 2) if (attrs[i] === name) return attrs[i + 1];
  return undefined;
};

/** A non-negative integer, or undefined. */
const index = (s: string | undefined): number | undefined => {
  if (s === undefined) return undefined;
  const x = +s;
  return Number.isInteger(x) && x >= 0 && s.trim() !== '' ? x : undefined;
};

/**
 * Reads a model part. `feed` hands its text over in pieces (calling the function it's given); problems go to
 * `diagnostics`, named by the part's path.
 */
export function readModel(path: string, feed: (piece: (s: string) => void) => void, creaseAngle: number,
  diagnostics: Diagnostic[]): ModelFile {
  const file: ModelFile = { path, unit: 1, unitName: 'millimeter', metadata: {}, groups: new Map(),
    objects: new Map(), build: [] };
  const say = (severity: Diagnostic['severity'], message: string, id?: number) => diagnostics.push({ severity,
    message: `${path}: ${message}`, ...(id !== undefined ? { source: { format: '3mf', id } } : {}) });
  const scopes = new Scopes();
  const skipped = new Map<string, number>();
  const stack: string[] = []; // the open elements' local names, for the ones read (prefixed with their namespace)
  let skipDepth = 0; // inside an element that isn't read
  let sawModel = false;
  let group: PropertyGroup | undefined;
  let object: ObjectDef | undefined;
  let metadata: { into: Record<string, string>; name: string; text: string } | undefined;
  // A mesh being read.
  let vertices: Grow<Float64Array> | undefined, triangles: Grow<Uint32Array>, properties: Grow<Uint32Array>;
  let propertyKeys: Map<string, number>, propertyList: ([number, number] | undefined)[];
  let bad = { vertices: 0, triangles: 0, gradients: 0 };
  const xmlProblems: string[] = [];

  /** An attribute of the element's own (unprefixed), or a prefixed one in a namespace. */
  const attr = (attrs: string[], local: string, uri?: string): string | undefined => {
    if (!uri) return get(attrs, local);
    for (let i = 0; i < attrs.length; i += 2) {
      const n = attrs[i]!;
      if (n.endsWith(`:${local}`) && scopes.resolve(n, true).uri === uri) return attrs[i + 1];
    }
    return undefined;
  };
  const transformOf = (attrs: string[], what: string, id?: number): Mat4 => {
    const t = attr(attrs, 'transform');
    if (t === undefined) return identity();
    const m = parseTransform(t);
    if (!m) say('warning', `${what}'s transform isn't 12 numbers (${JSON.stringify(t.slice(0, 80))}): the identity`,
      id);
    return m ?? identity();
  };
  const componentOf = (attrs: string[], what: string): ComponentDef | undefined => {
    const objectid = index(attr(attrs, 'objectid'));
    if (objectid === undefined) { say('warning', `a ${what} without a valid objectid: skipped`); return undefined; }
    const c: ComponentDef = { objectid, transform: transformOf(attrs, `the ${what} of object ${objectid}`, objectid) };
    const p = attr(attrs, 'path', PRODUCTION), uuid = attr(attrs, 'UUID', PRODUCTION);
    if (p !== undefined) c.path = p;
    if (uuid !== undefined) c.uuid = uuid;
    return c;
  };

  const start = (name: string, attrs: string[], empty: boolean) => {
    scopes.push(attrs);
    if (skipDepth) { skipDepth++; if (empty) end(name); return; }
    const { uri, local } = scopes.resolve(name);
    const key = uri === CORE ? local : uri === MATERIAL ? `m:${local}` : `{${uri}}${local}`;
    const parent = stack[stack.length - 1];
    let read = true;
    switch (key) {
      case 'model':
        read = parent === undefined;
        if (read) {
          sawModel = true;
          const u = attr(attrs, 'unit') ?? 'millimeter';
          if (UNITS[u] === undefined) say('warning', `unknown unit '${u}': read as millimetres`);
          else { file.unit = UNITS[u]; file.unitName = u; }
          const required = (attr(attrs, 'requiredextensions') ?? '').split(/\s+/).filter((p) => p);
          for (const p of required) {
            const ns = scopes.uri(p);
            if (!ns || !READ.has(ns)) say('warning', `the file requires the ${EXTENSIONS[ns ?? ''] ?? `extension ${ns
              ?? `'${p}' (an undeclared prefix)`}`}, which isn't read: read without it`);
          }
        }
        break;
      case 'metadata':
        read = parent === 'model' || parent === 'metadatagroup';
        if (read) {
          const into = parent === 'model' ? file.metadata : object && stack.includes('object') ? object.metadata
            : file.build[file.build.length - 1]?.metadata;
          metadata = { into: into ?? {}, name: attr(attrs, 'name') ?? '', text: '' };
        }
        break;
      case 'metadatagroup': read = parent === 'object' || parent === 'item'; break;
      case 'resources': case 'build': read = parent === 'model'; break;
      case 'basematerials': case 'm:colorgroup':
        read = parent === 'resources';
        if (read) {
          const id = index(attr(attrs, 'id'));
          group = { kind: key === 'basematerials' ? 'basematerials' : 'colorgroup', entries: [] };
          if (id === undefined) say('warning', `a ${local} without a valid id: skipped`);
          else file.groups.set(id, group);
        }
        break;
      case 'base': case 'm:color': {
        read = !!group && (parent === 'basematerials' || parent === 'm:colorgroup');
        if (read) {
          const text = attr(attrs, key === 'base' ? 'displaycolor' : 'color');
          const c = parseColor(text);
          if (!c) say('warning', `a ${local} whose colour isn't #RRGGBB or #RRGGBBAA (${JSON.stringify(text)}): `
            + 'grey');
          const name = attr(attrs, 'name');
          group!.entries.push({ ...(c ?? { color: [0.5, 0.5, 0.5], opacity: 1 }), ...(name ? { name } : {}) });
        }
        break;
      }
      case 'object': {
        read = parent === 'resources';
        if (!read) break;
        const id = index(attr(attrs, 'id'));
        object = { id: id ?? -1, type: attr(attrs, 'type') ?? 'model', metadata: {} };
        for (const k of ['name', 'partnumber'] as const) {
          const v = attr(attrs, k);
          if (v !== undefined && v !== '') object[k] = v;
        }
        const uuid = attr(attrs, 'UUID', PRODUCTION);
        if (uuid) object.uuid = uuid;
        const pid = index(attr(attrs, 'pid')), pindex = index(attr(attrs, 'pindex'));
        if (pid !== undefined) { object.pid = pid; object.pindex = pindex ?? 0; }
        if (id === undefined) say('warning', 'an object without a valid id: skipped');
        else if (file.objects.has(id)) say('warning', `object ${id} defined twice: the first kept`, id);
        else file.objects.set(id, object);
        for (let i = 0; i < attrs.length; i += 2) {
          const n = attrs[i]!;
          if (!n.includes(':') || n.startsWith('xmlns')) continue;
          const ns = scopes.resolve(n, true).uri;
          if (ns && !READ.has(ns)) skipped.set(`{${ns}}@${n.slice(n.indexOf(':') + 1)}`, (skipped.get(
            `{${ns}}@${n.slice(n.indexOf(':') + 1)}`) ?? 0) + 1);
        }
        break;
      }
      case 'mesh':
        read = parent === 'object' && !!object;
        if (read) {
          vertices = new Grow((n) => new Float64Array(n));
          triangles = new Grow((n) => new Uint32Array(n));
          properties = new Grow((n) => new Uint32Array(n));
          propertyKeys = new Map();
          propertyList = [];
          bad = { vertices: 0, triangles: 0, gradients: 0 };
        }
        break;
      case 'vertices': case 'triangles': read = parent === 'mesh'; break;
      case 'vertex': {
        read = parent === 'vertices';
        if (!read) break;
        const x = Number(attr(attrs, 'x')), y = Number(attr(attrs, 'y')), z = Number(attr(attrs, 'z'));
        const ok = Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z) && attrs.length >= 6;
        if (!ok) bad.vertices++;
        vertices!.push(ok ? x : 0); vertices!.push(ok ? y : 0); vertices!.push(ok ? z : 0);
        break;
      }
      case 'triangle': {
        read = parent === 'triangles';
        if (!read) break;
        const a = index(attr(attrs, 'v1')), b = index(attr(attrs, 'v2')), c = index(attr(attrs, 'v3'));
        if (a === undefined || b === undefined || c === undefined || a === b || b === c || c === a) {
          bad.triangles++;
          break;
        }
        const pid = attrs.length > 6 ? index(attr(attrs, 'pid')) ?? object!.pid : object!.pid;
        const p1 = attrs.length > 6 ? index(attr(attrs, 'p1')) : undefined;
        const at = pid === undefined ? undefined : p1 ?? object!.pindex ?? 0;
        if (attrs.length > 6) {
          const p2 = index(attr(attrs, 'p2')), p3 = index(attr(attrs, 'p3'));
          if ((p2 !== undefined && p2 !== at) || (p3 !== undefined && p3 !== at)) bad.gradients++;
        }
        const k = pid === undefined ? '' : `${pid}:${at}`;
        let p = propertyKeys.get(k);
        if (p === undefined) {
          propertyKeys.set(k, (p = propertyList.length));
          propertyList.push(pid === undefined ? undefined : [pid, at!]);
        }
        triangles.push(a); triangles.push(b); triangles.push(c);
        properties.push(p);
        break;
      }
      case 'components':
        read = parent === 'object' && !!object;
        if (read) object!.components = [];
        break;
      case 'component': {
        read = parent === 'components' && !!object?.components;
        const c = read ? componentOf(attrs, 'component') : undefined;
        if (c) object!.components!.push(c);
        break;
      }
      case 'item': {
        read = parent === 'build';
        const c = read ? componentOf(attrs, 'build item') : undefined;
        if (c) {
          const pn = attr(attrs, 'partnumber');
          file.build.push({ ...c, ...(pn ? { partnumber: pn } : {}), metadata: {} });
        }
        break;
      }
      default:
        // Other property groups (textures, composites, multiproperties): what uses them has no colour.
        if (uri === MATERIAL && parent === 'resources') {
          const id = index(attr(attrs, 'id'));
          if (id !== undefined) file.groups.set(id, { kind: local, entries: [] });
        }
        read = false;
    }
    if (key === 'build' && read) {
      const u = attr(attrs, 'UUID', PRODUCTION);
      if (u) file.buildUuid = u;
    }
    if (!read) {
      const k = `{${uri}}${local}`;
      skipped.set(k, (skipped.get(k) ?? 0) + 1);
      skipDepth = 1;
    } else stack.push(key);
    if (empty) end(name);
  };

  const end = (_name: string) => {
    scopes.pop();
    if (skipDepth) { skipDepth--; return; }
    const key = stack.pop();
    if (key === 'metadata' && metadata) {
      if (metadata.name) metadata.into[metadata.name] = metadata.text;
      metadata = undefined;
    } else if (key === 'basematerials' || key === 'm:colorgroup') group = undefined;
    else if (key === 'mesh' && object && vertices) {
      const v = vertices.done(), t = triangles.done(), p = properties.done();
      const n = v.length / 3;
      // Triangles naming vertices that aren't there are dropped.
      let out = 0;
      for (let i = 0; i < t.length; i += 3) {
        if (t[i]! >= n || t[i + 1]! >= n || t[i + 2]! >= n) { bad.triangles++; continue; }
        t[out] = t[i]!; t[out + 1] = t[i + 1]!; t[out + 2] = t[i + 2]!;
        p[out / 3] = p[i / 3]!;
        out += 3;
      }
      const id = object.id;
      if (bad.vertices) say('warning', `object ${id}: ${bad.vertices} vertices without three numbers, put at 0`, id);
      if (bad.triangles) say('warning', `object ${id}: ${bad.triangles} triangles without three distinct vertices `
        + 'of the mesh: left out', id);
      if (bad.gradients) say('info', `object ${id}: ${bad.gradients} triangles with a property per corner: each `
        + 'given its first corner\'s', id);
      if (out) {
        // Our files' faces (export-3mf's `cadio:faces`, with extras): each triangle's face and colour its key.
        const runs = facesOf(object.metadata['cadio:faces'], out / 3);
        if (object.metadata['cadio:faces'] !== undefined && !runs) say('warning', `object ${id}: our faces `
          + '(cadio:faces) don\'t match its triangles: faces by colour', id);
        let keys = p.subarray(0, out / 3), sourceOf: ((k: number) => number | null) | undefined;
        let colourOf = (k: number) => k;
        if (runs) {
          const combined = new Map<string, number>(), list: [number | null, number][] = [];
          keys = new Uint32Array(out / 3);
          for (let i = 0; i < keys.length; i++) {
            const key = `${runs[i]}|${p[i]}`;
            let k = combined.get(key);
            if (k === undefined) { combined.set(key, (k = list.length)); list.push([runs[i]!, p[i]!]); }
            keys[i] = k;
          }
          sourceOf = (k) => list[k]![0];
          colourOf = (k) => list[k]![1];
        }
        const { mesh, faceProperties } = buildMesh({ vertices: v, triangles: t.subarray(0, out), properties: keys },
          creaseAngle);
        if (sourceOf) mesh.faces.forEach((f, k) => { f.source = sourceOf(faceProperties[k]!); });
        object.mesh = { mesh, faceProperties: faceProperties.map((k) => propertyList[colourOf(k)]) };
      }
      vertices = undefined;
    } else if (key === 'object') object = undefined;
  };

  const tokenizer = new XmlTokenizer({
    start, end,
    text: (s) => { if (metadata) metadata.text += s; },
    wantText: () => metadata !== undefined,
    problem: (m) => { if (xmlProblems.length < 10) xmlProblems.push(m); else if (xmlProblems.length === 10)
      xmlProblems.push('...'); },
  });
  feed((s) => tokenizer.feed(s));
  tokenizer.end();
  for (const m of xmlProblems) say('warning', m);
  if (!sawModel) say('error', 'no 3MF model in it (its root element isn\'t a core <model>)');

  for (const [k, count] of skipped) {
    const [, ns, local] = /^\{(.*)\}(.*)$/.exec(k)!;
    const what = EXTENSIONS[ns!] ? `the ${EXTENSIONS[ns!]}` : ns === 'undefined' ? 'no namespace' : `namespace ${ns}`;
    const textures = ns === MATERIAL && /^texture2d/.test(local!);
    say('warning', textures ? `textures are not supported: ignored (${count} ${local} ${count === 1 ? 'element'
      : 'elements'})` : local!.startsWith('@') ? `${count} ${count === 1 ? 'object' : 'objects'} with ${what}'s `
      + `${local!.slice(1)} attribute: only its mesh read`
      : `${count} <${local}> ${count === 1 ? 'element' : 'elements'} of ${what} not read`);
  }
  return file;
}
