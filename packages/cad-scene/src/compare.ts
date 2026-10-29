// Whether two scenes draw the same (the user, 2026-10-29: the importers checked by reading back what the exporters
// wrote): their export views compared node for node in tree order, by what's drawn, not how the scene says it (a
// part's colours by part, reference or override; its origin in its transform or its mesh). Positions up to a
// tolerance (lossy compression).

import type { ExportNode, ExportView } from './export.ts';
import type { Mat4, Scene } from './scene.ts';
import { identity, multiply } from './walk.ts';

export interface CompareOptions {
  /** Millimetres two positions may differ by (0: as float32 rounding of the transforms allows). */
  tolerance?: number;
  /** At most this many differences listed. Default 50. */
  max?: number;
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

/** A placed part's triangles in the world, as sorted keys: corners rounded to the grid, face id, colour, opacity. */
function triangles(scene: Scene, view: ExportView, look: number, world: Mat4, grid: number): string[] {
  const l = view.looks[look]!;
  const p = l.mesh.positions;
  const faceAt = new Map<number, number | null>();
  for (const f of l.faces) for (let i = f.start; i < f.start + f.count; i += 3) faceAt.set(i, f.source);
  const out: string[] = [];
  for (const g of l.groups) {
    const m = g.material === undefined ? undefined : scene.materials[g.material];
    const colour = m ? `${m.color.map((c) => Math.round(c * 255)).join(',')}@${Math.round(m.opacity * 255)}`
      : 'default';
    for (let i = g.start; i < g.start + g.count; i += 3) {
      const corners = [0, 1, 2].map((k) => {
        const v = l.indices[i + k]!;
        return apply(world, p[3 * v]!, p[3 * v + 1]!, p[3 * v + 2]!).map((x) => Math.round(x / grid)).join(',');
      });
      // (Rotated so the smallest corner is first: the same triangle, the same key, whatever corner it starts at.)
      const r = corners.indexOf([...corners].sort()[0]!);
      out.push(`${[...corners.slice(r), ...corners.slice(0, r)].join(' ')} face ${faceAt.get(i) ?? '-'} ${colour}`);
    }
  }
  return out.sort();
}

/** A placed part's lines and points in the world, as sorted keys. */
function lines(view: ExportView, look: number, world: Mat4, grid: number): string[] {
  const l = view.looks[look]!, m = l.mesh;
  const key = (pos: Float32Array, i: number) => apply(world, pos[3 * i]!, pos[3 * i + 1]!, pos[3 * i + 2]!)
    .map((x) => Math.round(x / grid)).join(',');
  const out: string[] = [];
  const kept = new Set(['shared', 'free']);
  if (l.edges) for (const e of m.edges ?? []) {
    if (!kept.has(e.kind) || e.count < 2) continue;
    out.push(`edge ${e.source ?? '-'} ${e.kind}: ${Array.from({ length: e.count }, (_, k) => key(m.edgePositions!,
      e.start + k)).join(' ')}`);
  }
  if (l.curves) {
    for (const c of m.curves ?? []) out.push(`curve ${c.source ?? '-'}: ${Array.from({ length: c.count }, (_, k) =>
      key(m.curvePositions!, c.start + k)).join(' ')}`);
    (m.pointSources ?? []).forEach((s, i) => out.push(`point ${s ?? '-'}: ${key(m.points!, i)}`));
  }
  return out.sort();
}

/** Differences in what two scenes' export views draw; none if they draw the same. */
export function viewDifferences(a: { scene: Scene; view: ExportView }, b: { scene: Scene; view: ExportView },
  opts: CompareOptions = {}): string[] {
  const max = opts.max ?? 50;
  // (A grid of the tolerance, or a micrometre: float32 positions through two different products of transforms.)
  const grid = opts.tolerance || 1e-3;
  const out: string[] = [];
  const say = (s: string) => { if (out.length < max) out.push(s); };
  const pa = placements(a.view), pb = placements(b.view);
  if (pa.length !== pb.length) say(`${pa.length} placed parts against ${pb.length}`);
  for (let i = 0; i < Math.min(pa.length, pb.length) && out.length < max; i++) {
    const x = pa[i]!, y = pb[i]!;
    const where = `placement ${i} (${x.names})`;
    if (x.names !== y.names) say(`${where}: in ${y.names}`);
    if (x.visible !== y.visible) say(`${where}: visible ${x.visible} against ${y.visible}`);
    const ta = triangles(a.scene, a.view, x.look, x.world, grid);
    const tb = triangles(b.scene, b.view, y.look, y.world, grid);
    if (ta.join('\n') !== tb.join('\n')) {
      const sb = new Set(tb);
      const first = ta.find((t) => !sb.has(t)) ?? tb.find((t) => !new Set(ta).has(t));
      say(`${where}: ${ta.length} triangles against ${tb.length}; first differing: ${first}`);
    }
    const la = lines(a.view, x.look, x.world, grid), lb = lines(b.view, y.look, y.world, grid);
    if (la.join('\n') !== lb.join('\n')) {
      const first = la.find((t) => !lb.includes(t)) ?? lb.find((t) => !la.includes(t));
      say(`${where}: ${la.length} lines and points against ${lb.length}; first differing: ${first?.slice(0, 200)}`);
    }
  }
  return out;
}
