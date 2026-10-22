// A 3MF read back with lib3mf (the 3MF Consortium's reader, as WASM) into plain objects, for the tests and the
// corpus check: an independent reading of what export-3mf wrote.
import lib3mf from '@3mfconsortium/lib3mf';

export interface Read3mf {
  /** lib3mf's warnings (strict mode turns them into errors). */
  warnings: string[];
  unit: number;
  meshes: Map<number, {
    name: string; partNumber: string; type: number; manifold: boolean;
    positions: number[]; triangles: number[];
    /** Per triangle: its property group's id and its first property id. */
    properties: [number, number][];
    /** The object's default property: group id and property id. */
    property?: [number, number];
  }>;
  components: Map<number, { name: string; components: { object: number; transform?: number[] }[] }>;
  items: { object: number; transform?: number[]; partNumber: string; metadata: { name: string; namespace: string; value: string }[] }[];
  /** Colours by group id, then property id: [r, g, b, a] 0–255, and base names. */
  colors: Map<number, Map<number, { color: number[]; name?: string }>>;
}

// lib3mf's module, loaded once.
let module: Promise<any> | undefined; // eslint-disable-line @typescript-eslint/no-explicit-any

/** 3MF object types as lib3mf numbers them. */
export const OBJECT_TYPE = { other: 0, model: 1, support: 2, solidsupport: 3, surface: 4 } as const;

/** Reads a 3MF; throws lib3mf's error if it refuses the file. `full: false` skips vertices and triangles. */
export async function read3mf(bytes: Uint8Array, { strict = true, full = true } = {}): Promise<Read3mf> {
  const M = await (module ??= lib3mf());
  // Every Embind object lib3mf hands out, freed at the end (Embind warns of those left to the garbage collector).
  const owned: any[] = []; // eslint-disable-line @typescript-eslint/no-explicit-any
  const own = <T>(x: T): T => { owned.push(x); return x; };
  try {
    return readModel(M, own, bytes, strict, full);
  } finally {
    for (const x of owned.reverse()) x?.delete?.();
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function readModel(M: any, own: <T>(x: T) => T, bytes: Uint8Array, strict: boolean, full: boolean): Read3mf {
  const wrapper = own(new M.CWrapper());
  const model = own(wrapper.CreateModel());
  const reader = own(model.QueryReader('3mf'));
  reader.SetStrictModeActive(strict);
  M.FS.writeFile('/in.3mf', bytes);
  try {
    reader.ReadFromFile('/in.3mf');
  } finally {
    M.FS.unlink('/in.3mf');
  }
  const transform = (t: any) => { own(t); return [0, 1, 2, 3].flatMap((r) => [0, 1, 2].map((c) => t[`get_Fields_${r}_${c}`]())); }; // eslint-disable-line @typescript-eslint/no-explicit-any
  const out: Read3mf = { warnings: [], unit: model.GetUnit().value, meshes: new Map(), components: new Map(), items: [], colors: new Map() };
  for (let i = 0; i < reader.GetWarningCount(); i++) out.warnings.push(JSON.stringify(reader.GetWarning(i)));

  const meshes = own(model.GetMeshObjects());
  while (meshes.MoveNext()) {
    const o = own(meshes.GetCurrentMeshObject());
    const positions: number[] = [], triangles: number[] = [], properties: [number, number][] = [];
    if (full) {
      for (let v = 0; v < o.GetVertexCount(); v++) {
        const p = o.GetVertex(v);
        positions.push(p.get_Coordinates0(), p.get_Coordinates1(), p.get_Coordinates2());
        p.delete();
      }
      for (let t = 0; t < o.GetTriangleCount(); t++) {
        const tri = o.GetTriangle(t);
        triangles.push(tri.get_Indices0(), tri.get_Indices1(), tri.get_Indices2());
        tri.delete();
        const p = o.GetTriangleProperties(t).Property;
        properties.push([p.get_ResourceID(), p.get_PropertyIDs0()]);
        p.delete();
      }
    }
    const level = o.GetObjectLevelProperty();
    out.meshes.set(o.GetResourceID(), {
      name: o.GetName(), partNumber: o.GetPartNumber(), type: o.GetType().value, manifold: o.IsManifoldAndOriented(),
      positions, triangles, properties, ...(level.return ? { property: [level.UniqueResourceID, level.PropertyID] as [number, number] } : {}),
    });
  }
  const comps = own(model.GetComponentsObjects());
  while (comps.MoveNext()) {
    const o = own(comps.GetCurrentComponentsObject());
    const components = [];
    for (let k = 0; k < o.GetComponentCount(); k++) {
      const c = own(o.GetComponent(k));
      components.push({ object: c.GetObjectResourceID(), ...(c.HasTransform() ? { transform: transform(c.GetTransform()) } : {}) });
    }
    out.components.set(o.GetResourceID(), { name: o.GetName(), components });
  }
  const items = own(model.GetBuildItems());
  while (items.MoveNext()) {
    const it = own(items.GetCurrent());
    const group = own(it.GetMetaDataGroup());
    const metadata = [];
    for (let k = 0; k < group.GetMetaDataCount(); k++) {
      const m = own(group.GetMetaData(k));
      metadata.push({ name: m.GetName(), namespace: m.GetNameSpace(), value: m.GetValue() });
    }
    out.items.push({ object: it.GetObjectResourceID(), ...(it.HasObjectTransform() ? { transform: transform(it.GetObjectTransform()) } : {}), partNumber: it.GetPartNumber(), metadata });
  }
  // Property ids count from 1 in each group.
  const rgba = (c: any) => { own(c); return [c.get_Red(), c.get_Green(), c.get_Blue(), c.get_Alpha()]; }; // eslint-disable-line @typescript-eslint/no-explicit-any
  const bases = own(model.GetBaseMaterialGroups());
  while (bases.MoveNext()) {
    const g = own(bases.GetCurrentBaseMaterialGroup());
    const m = new Map<number, { color: number[]; name?: string }>();
    for (let id = 1; id <= g.GetCount(); id++) m.set(id, { color: rgba(g.GetDisplayColor(id)), name: g.GetName(id) });
    out.colors.set(g.GetResourceID(), m);
  }
  const groups = own(model.GetColorGroups());
  while (groups.MoveNext()) {
    const g = own(groups.GetCurrentColorGroup());
    const m = new Map<number, { color: number[] }>();
    for (let id = 1; id <= g.GetCount(); id++) m.set(id, { color: rgba(g.GetColor(id)) });
    out.colors.set(g.GetResourceID(), m);
  }
  return out;
}
