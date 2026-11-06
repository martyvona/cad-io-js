// A part's measures (Measures) and its level's settings in our extras, as the exporters write them with a part's node
// (glTF `extras`, three.js `userData`, 3MF's `cadio:tree`) and the importers read them back (kept, exported and used
// instead of measuring again; docs/claude/scene-formats.md). None of the three formats has a place of its own for a
// face's area. As JSON:
//
//   measures: { by: string, faces: { "<face source id>": [area, perimeter, valid (1 or 0)] } }  the part's units
//   level: { linearDeflection?, angularDeflection?, backend? }   the exported level's (Lod), mm and radians
//   unit: the part's unit in mm, when it isn't 1: its vertices are written in it, as the scene has them
//   box: [[x, y, z], [x, y, z]]   the exported mesh's box (Mesh.box), in its coordinates, where the format has no
//                                 slot for it (glTF has: its accessors' min and max)
//
// and at the root, with the scene's properties, the model's sphere (Scene.bounds), in millimetres:
//
//   bounds: { center: [x, y, z], radius }
//
// and with a placed part, its part reference's own (placementJson):
//
//   placement: { index, name?, sources?, properties?, product?: { name, sources?, properties? } }
//
// so a level read back is judged as it was made (faceFailures needs its deflection in the part's units).

import type { Lod, Measures, Part, PartRef, Properties, Scene, SceneBounds, SourceId } from './scene.ts';

type Json = Record<string, unknown>;
const obj = (v: unknown): Json | undefined => (v && typeof v === 'object' && !Array.isArray(v) ? v as Json
  : undefined);

/** A part's measures as our extras' JSON. */
export function measuresJson(m: Measures): Json {
  return { by: m.by, faces: Object.fromEntries([...m.faces].map(([id, f]) => [String(id),
    [f.area, f.perimeter, f.valid ? 1 : 0]])) };
}

/** Measures from our extras' JSON; undefined if it isn't that (entries that aren't are left out). */
export function measuresFrom(j: unknown): Measures | undefined {
  const o = j && typeof j === 'object' && !Array.isArray(j) ? j as Json : undefined;
  const faces = o?.faces && typeof o.faces === 'object' && !Array.isArray(o.faces) ? o.faces as Json : undefined;
  if (!o || typeof o.by !== 'string' || !faces) return undefined;
  const out: Measures = { by: o.by, faces: new Map() };
  for (const [id, v] of Object.entries(faces)) {
    if (!/^\d+$/.test(id) || !Array.isArray(v) || v.length !== 3 || !v.every((x) => typeof x === 'number')) continue;
    out.faces.set(Number(id), { area: v[0]!, perimeter: v[1]!, valid: v[2] === 1 });
  }
  return out;
}

/** A level's settings as our extras' JSON (those it has). */
export function levelJson(l: Lod): Json {
  return { ...(l.linearDeflection !== undefined ? { linearDeflection: l.linearDeflection } : {}),
    ...(l.angularDeflection !== undefined ? { angularDeflection: l.angularDeflection } : {}),
    ...(l.backend !== undefined ? { backend: l.backend } : {}) };
}

/** A level's settings from our extras' JSON: those that are there and of the right type. */
export function levelFrom(j: unknown): Pick<Lod, 'linearDeflection' | 'angularDeflection' | 'backend'> {
  const o = j && typeof j === 'object' && !Array.isArray(j) ? j as Json : {};
  const n = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) && x > 0 ? x : undefined);
  const lin = n(o.linearDeflection), ang = n(o.angularDeflection);
  return { ...(lin !== undefined ? { linearDeflection: lin } : {}),
    ...(ang !== undefined ? { angularDeflection: ang } : {}),
    ...(typeof o.backend === 'string' ? { backend: o.backend } : {}) };
}

/**
 * What our extras say of a part beyond its node's own: its measures, its level's settings and its unit, where it has
 * them (the importers read them back with measuresFrom, levelFrom and unitFrom).
 */
export function partExtras(part: Part, lod: Lod | undefined, opts: { box?: boolean } = {}): Json {
  const box = (opts.box ?? true) ? lod?.mesh.box : undefined;
  return { ...(part.measures ? { measures: measuresJson(part.measures) } : {}),
    ...(box ? { box: [box.min, box.max] } : {}),
    ...(lod && Object.keys(levelJson(lod)).length ? { level: levelJson(lod) } : {}),
    ...(part.unit !== 1 ? { unit: part.unit } : {}) };
}

/** A part's unit from our extras: a positive number, else 1 (millimetres). */
export const unitFrom = (j: unknown) => (typeof j === 'number' && Number.isFinite(j) && j > 0 ? j : 1);

/** The model's sphere as our root extras' JSON, where the scene has one. */
/**
 * What our extras say of the whole scene (glTF's scene, three.js's root object, 3MF's `cadio:tree`): its frame
 * (millimetres, Z up; for 3MF the nodes', its model in the source's unit), its properties, the source's unit and its
 * sphere.
 */
export function sceneJson(scene: Scene): Json {
  return { unit: 'millimetre', up: 'z', ...(Object.keys(scene.properties).length ? { properties: scene.properties }
    : {}), ...(scene.sourceUnit !== undefined ? { sourceUnit: scene.sourceUnit } : {}), ...boundsJson(scene) };
}

export function boundsJson(scene: Scene): Json {
  const b = scene.bounds;
  return b ? { bounds: { center: [...b.center], radius: b.radius } } : {};
}

/** The model's sphere from our root extras' JSON (`from: 'source'`); undefined if it isn't one. */
export function boundsFrom(j: unknown): SceneBounds | undefined {
  const o = j && typeof j === 'object' && !Array.isArray(j) ? j as Json : undefined;
  const c = o?.center, r = o?.radius;
  const finite = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
  if (!Array.isArray(c) || c.length !== 3 || !c.every(finite) || !finite(r) || r < 0) return undefined;
  return { center: [c[0]!, c[1]!, c[2]!], radius: r, from: 'source' };
}

/**
 * A placed part's own data in our extras (a leaf product's placement is a part reference): its index among its
 * component's part references, its name, sources and properties, and its product's.
 */
export function placementJson(ref: PartRef, index: number): Json {
  const sourced = (sources: SourceId[] | undefined, properties: Properties | undefined): Json => ({
    ...(sources?.length ? { sources: sources.map((s) => ({ format: s.format, id: s.id })) } : {}),
    ...(properties && Object.keys(properties).length ? { properties } : {}) });
  return { index, ...(ref.name !== undefined ? { name: ref.name } : {}), ...sourced(ref.sources, ref.properties),
    ...(ref.product ? { product: { name: ref.product.name, ...sourced(ref.product.sources,
      ref.product.properties) } } : {}) };
}

/** A placement's data from our extras (placementJson): its index, and what a part reference carries. */
export function placementFrom(j: unknown): { index?: number } & Pick<PartRef, 'name' | 'sources' | 'properties' |
  'product'> {
  const o = obj(j);
  if (!o) return {};
  const sourcesOf = (v: unknown): SourceId[] => (Array.isArray(v) ? v.flatMap((s) => {
    const x = obj(s);
    return x && typeof x.format === 'string' && typeof x.id === 'number' ? [{ format: x.format, id: x.id }] : [];
  }) : []);
  const props = (v: unknown): Properties => (obj(v) ?? {}) as Properties;
  const out: ReturnType<typeof placementFrom> = {};
  if (typeof o.index === 'number' && Number.isInteger(o.index) && o.index >= 0) out.index = o.index;
  if (typeof o.name === 'string') out.name = o.name;
  const sources = sourcesOf(o.sources);
  if (sources.length) out.sources = sources;
  if (obj(o.properties)) out.properties = props(o.properties);
  const p = obj(o.product);
  if (p) out.product = { name: typeof p.name === 'string' ? p.name : '', sources: sourcesOf(p.sources),
    properties: props(p.properties) };
  return out;
}
