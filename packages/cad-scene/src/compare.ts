// Whether two scenes draw the same (the user, 2026-10-29: the importers checked by reading back what the exporters
// wrote): their export views compared node for node in tree order, by what's drawn, not how the scene says it (a
// part's colours by part, reference or override; its origin in its transform or its mesh). Positions up to a
// tolerance (lossy compression).

import type { ExportNode, ExportView } from './export.ts';
import type { Mat4, Scene } from './scene.ts';
import { identity, multiply } from './walk.ts';

export interface CompareOptions {
  /** Millimetres two positions may differ by. Default 1e-4 (float32 positions through two products of transforms). */
  tolerance?: number;
  /** Hidden placements left out of the comparison (a format that omits them can't have them). Default false. */
  skipHidden?: boolean;
  /** At most this many differences listed. Default 50. */
  max?: number;
}

const matrixKey = (m: Mat4) => Array.from(m, (x) => x.toFixed(6)).join(',');
const apply = (m: Mat4, x: number, y: number, z: number): [number, number, number] => [
  m[0]! * x + m[4]! * y + m[8]! * z + m[12]!, m[1]! * x + m[5]! * y + m[9]! * z + m[13]!,
  m[2]! * x + m[6]! * y + m[10]! * z + m[14]!];

/** Each placed part, in tree order, with its node's path and its world transform. */
function placements(view: ExportView): { names: string; world: Mat4; look: number; visible: boolean }[] {
  const out: { names: string; world: Mat4; look: number; visible: boolean }[] = [];
  const walk = (n: ExportNode, parent: Mat4, names: string) => {
    const t = multiply(parent, n.transform);
    const here = `${names}/${n.name}`;
    for (const p of n.parts) out.push({ names: here, world: multiply(t, p.transform), look: p.look,
      visible: p.visible });
    for (const c of n.children) walk(c, t, here);
  };
  for (const r of view.roots) walk(r, identity(), '');
  return out;
}

/** Something drawn, in the world: what it is (face id and colour, or kind and source) and its points' coordinates. */
interface Drawn { meta: string; pts: number[]; triangle: boolean }

/** A placed part's triangles in the world, each with its face id, colour and opacity. */
function triangles(scene: Scene, view: ExportView, look: number, world: Mat4): Drawn[] {
  const l = view.looks[look]!;
  const p = l.mesh.positions;
  const faceAt = new Map<number, number | null>();
  for (const f of l.faces) for (let i = f.start; i < f.start + f.count; i += 3) faceAt.set(i, f.source);
  const out: Drawn[] = [];
  for (const g of l.groups) {
    const m = g.material === undefined ? undefined : scene.materials[g.material];
    const colour = m ? `${m.color.map((c) => Math.round(c * 255)).join(',')}@${Math.round(m.opacity * 255)}`
      : 'default';
    for (let i = g.start; i < g.start + g.count; i += 3) {
      const pts = [0, 1, 2].flatMap((k) => {
        const v = l.indices[i + k]!;
        return apply(world, p[3 * v]!, p[3 * v + 1]!, p[3 * v + 2]!);
      });
      out.push({ meta: `face ${faceAt.get(i) ?? '-'} ${colour}`, pts, triangle: true });
    }
  }
  return out;
}

/** A placed part's shared and free edges, curves and points in the world. */
function lines(view: ExportView, look: number, world: Mat4): Drawn[] {
  const l = view.looks[look]!, m = l.mesh;
  const at = (pos: Float32Array, i: number) => apply(world, pos[3 * i]!, pos[3 * i + 1]!, pos[3 * i + 2]!);
  const out: Drawn[] = [];
  const kept = new Set(['shared', 'free']);
  if (l.edges) for (const e of m.edges ?? []) {
    if (!kept.has(e.kind) || e.count < 2) continue;
    out.push({ meta: `edge ${e.source ?? '-'} ${e.kind}`, pts: Array.from({ length: e.count }, (_, k) =>
      at(m.edgePositions!, e.start + k)).flat(), triangle: false });
  }
  if (l.curves) {
    for (const c of m.curves ?? []) out.push({ meta: `curve ${c.source ?? '-'}`, pts: Array.from({ length: c.count },
      (_, k) => at(m.curvePositions!, c.start + k)).flat(), triangle: false });
    (m.pointSources ?? []).forEach((s, i) => out.push({ meta: `point ${s ?? '-'}`, pts: at(m.points!, i),
      triangle: false }));
  }
  return out;
}

/** A triangle's corners from each of its three (the same triangle whatever corner it's written from). */
const rotations = (d: Drawn) => (d.triangle ? [0, 1, 2].map((r) => [...d.pts.slice(3 * r), ...d.pts.slice(0, 3 * r)])
  : [d.pts]);

/**
 * What's drawn in one list and not the other: each item matched to one of the same kind whose points all lie within
 * the tolerance (a spatial hash of their centres, so no grid boundary splits two that are close).
 */
function unmatched(a: Drawn[], b: Drawn[], tolerance: number): { a: Drawn[]; b: Drawn[] } {
  const cell = 2 * tolerance;
  const centre = (d: Drawn) => [0, 1, 2].map((k) => {
    let s = 0;
    for (let i = k; i < d.pts.length; i += 3) s += d.pts[i]!;
    return s / (d.pts.length / 3);
  });
  const cellKey = (c: number[]) => c.map((x) => Math.floor(x / cell)).join(',');
  const grid = new Map<string, Drawn[]>();
  for (const d of b) {
    const k = `${d.meta}|${cellKey(centre(d))}`;
    let list = grid.get(k);
    if (!list) grid.set(k, (list = []));
    list.push(d);
  }
  const used = new Set<Drawn>();
  const near = (x: number[], y: number[]) => x.length === y.length &&
    x.every((v, i) => Math.abs(v - y[i]!) <= tolerance);
  const left: Drawn[] = [];
  for (const d of a) {
    const c = centre(d).map((x) => Math.floor(x / cell));
    let found: Drawn | undefined;
    for (let dx = -1; dx <= 1 && !found; dx++) for (let dy = -1; dy <= 1 && !found; dy++) {
      for (let dz = -1; dz <= 1 && !found; dz++) {
        for (const e of grid.get(`${d.meta}|${c[0]! + dx},${c[1]! + dy},${c[2]! + dz}`) ?? []) {
          if (!used.has(e) && rotations(d).some((r) => near(r, e.pts))) { found = e; break; }
        }
      }
    }
    if (found) used.add(found);
    else left.push(d);
  }
  return { a: left, b: b.filter((d) => !used.has(d)) };
}

const describe = (d: Drawn) => `${d.meta} at ${d.pts.slice(0, 9).map((x) => x.toFixed(4)).join(',')}`;

/** Differences in what two scenes' export views draw; none if they draw the same. */
export function viewDifferences(a: { scene: Scene; view: ExportView }, b: { scene: Scene; view: ExportView },
  opts: CompareOptions = {}): string[] {
  const max = opts.max ?? 50;
  const tolerance = opts.tolerance || 1e-4;
  const out: string[] = [];
  const say = (s: string) => { if (out.length < max) out.push(s); };
  // (In tree order, and within a node by world transform: an importer may put a node's parts back in another order.)
  const sorted = (v: ExportView) => placements(v).filter((p) => p.visible || !opts.skipHidden)
    .map((p, i) => ({ p, i, key: p.names })).sort((x, y) =>
    (x.key < y.key ? -1 : x.key > y.key ? 1 : 0) || (matrixKey(x.p.world) < matrixKey(y.p.world) ? -1
      : matrixKey(x.p.world) > matrixKey(y.p.world) ? 1 : x.i - y.i)).map((x) => x.p);
  const pa = sorted(a.view), pb = sorted(b.view);
  if (pa.length !== pb.length) say(`${pa.length} placed parts against ${pb.length}`);
  for (let i = 0; i < Math.min(pa.length, pb.length) && out.length < max; i++) {
    const x = pa[i]!, y = pb[i]!;
    const where = `placement ${i} (${x.names})`;
    if (x.names !== y.names) say(`${where}: in ${y.names}`);
    if (x.visible !== y.visible) say(`${where}: visible ${x.visible} against ${y.visible}`);
    const ta = triangles(a.scene, a.view, x.look, x.world), tb = triangles(b.scene, b.view, y.look, y.world);
    const t = unmatched(ta, tb, tolerance);
    if (t.a.length || t.b.length) say(`${where}: ${ta.length} triangles against ${tb.length}; ${t.a.length} and ` +
      `${t.b.length} unmatched, first ${describe((t.a[0] ?? t.b[0])!)}`);
    const la = lines(a.view, x.look, x.world), lb = lines(b.view, y.look, y.world);
    const l = unmatched(la, lb, tolerance);
    if (l.a.length || l.b.length) say(`${where}: ${la.length} lines and points against ${lb.length}; ${l.a.length} ` +
      `and ${l.b.length} unmatched, first ${describe((l.a[0] ?? l.b[0])!)}`);
  }
  return out;
}
