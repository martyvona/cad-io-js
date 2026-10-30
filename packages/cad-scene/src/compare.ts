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
  /** Triangles' face ids compared (false: only their colours, for a format without faces, as 3MF). Default true. */
  faceIds?: boolean;
  /** Edges, curves and points compared (false: left out, for a format without lines, as 3MF). Default true. */
  lines?: boolean;
}

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
function triangles(scene: Scene, view: ExportView, look: number, world: Mat4, faceIds: boolean): Drawn[] {
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
      out.push({ meta: `face ${faceIds ? faceAt.get(i) ?? '-' : '?'} ${colour}`, pts, triangle: true });
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
  // Every pair within the tolerance, by how far apart (the worse point), then paired nearest first: with items
  // smaller than the tolerance, the first one near isn't always the right one.
  const distance = (x: number[], y: number[]) => {
    if (x.length !== y.length) return Infinity;
    let worst = 0;
    for (let i = 0; i < x.length; i++) worst = Math.max(worst, Math.abs(x[i]! - y[i]!));
    return worst;
  };
  const pairs: { d: Drawn; e: Drawn; dist: number }[] = [];
  for (const d of a) {
    const c = centre(d).map((x) => Math.floor(x / cell));
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
      for (const e of grid.get(`${d.meta}|${c[0]! + dx},${c[1]! + dy},${c[2]! + dz}`) ?? []) {
        const dist = Math.min(...rotations(d).map((r) => distance(r, e.pts)));
        if (dist <= tolerance) pairs.push({ d, e, dist });
      }
    }
  }
  pairs.sort((x, y) => x.dist - y.dist);
  const used = new Set<Drawn>(), done = new Set<Drawn>();
  for (const { d, e } of pairs) {
    if (done.has(d) || used.has(e)) continue;
    done.add(d);
    used.add(e);
  }
  const left = a.filter((d) => !done.has(d));
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
  // Placements paired within each node (the names along the path), by where they're drawn: the centre of their
  // points in the world, nearest first (an importer may put a node's parts back in another order, and a format may
  // move a mesh's scale into its placement, as meshopt's quantization does).
  type P = ReturnType<typeof placements>[number] & { drawn: Drawn[]; lines: Drawn[]; centre: number[] };
  const of = (side: { scene: Scene; view: ExportView }): P[] => placements(side.view)
    .filter((p) => p.visible || !opts.skipHidden).map((p) => {
      const drawn = triangles(side.scene, side.view, p.look, p.world, opts.faceIds ?? true);
      const ls = opts.lines === false ? [] : lines(side.view, p.look, p.world);
      const all = [...drawn, ...ls].flatMap((d) => d.pts);
      const centre = [0, 1, 2].map((k) => {
        let sum = 0;
        for (let i = k; i < all.length; i += 3) sum += all[i]!;
        return all.length ? sum / (all.length / 3) : 0;
      });
      return { ...p, drawn, lines: ls, centre };
    });
  const pa = of(a), pb = of(b);
  if (pa.length !== pb.length) say(`${pa.length} placed parts against ${pb.length}`);
  const byNode = new Map<string, P[]>();
  for (const p of pb) byNode.set(p.names, [...byNode.get(p.names) ?? [], p]);
  const pairs: [P, P | undefined][] = [];
  const nodes = new Map<string, P[]>();
  for (const p of pa) nodes.set(p.names, [...nodes.get(p.names) ?? [], p]);
  for (const [names, list] of nodes) {
    const others = byNode.get(names) ?? [];
    const cand = list.flatMap((x) => others.map((y) => ({ x, y, d: Math.hypot(...x.centre.map((c, k) =>
      c - y.centre[k]!)) }))).sort((u, v) => u.d - v.d);
    const done = new Set<P>(), used = new Set<P>();
    for (const { x, y } of cand) if (!done.has(x) && !used.has(y)) { done.add(x); used.add(y); pairs.push([x, y]); }
    for (const x of list) if (!done.has(x)) pairs.push([x, undefined]);
    const extra = others.filter((y) => !used.has(y)).length;
    if (extra) say(`${names}: ${extra} placed parts more`);
  }
  for (const names of byNode.keys()) if (!nodes.has(names)) say(`${names}: ${byNode.get(names)!.length} placed parts `
    + 'only in the second');
  pairs.forEach(([x, y], i) => {
    if (out.length >= max) return;
    const where = `placement ${i} (${x.names})`;
    if (!y) { say(`${where}: missing`); return; }
    if (x.visible !== y.visible) say(`${where}: visible ${x.visible} against ${y.visible}`);
    const t = unmatched(x.drawn, y.drawn, tolerance);
    if (t.a.length || t.b.length) say(`${where}: ${x.drawn.length} triangles against ${y.drawn.length}; ` +
      `${t.a.length} and ${t.b.length} unmatched, first ${describe((t.a[0] ?? t.b[0])!)}`);
    const l = unmatched(x.lines, y.lines, tolerance);
    if (l.a.length || l.b.length) say(`${where}: ${x.lines.length} lines and points against ${y.lines.length}; ` +
      `${l.a.length} and ${l.b.length} unmatched, first ${describe((l.a[0] ?? l.b[0])!)}`);
  });
  return out;
}
