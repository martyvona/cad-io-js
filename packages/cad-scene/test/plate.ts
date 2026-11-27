// The bulge tests' plate (bulge.test.ts, records.test.ts): a square face with a round hole, and its mesh.
import { type BrepData, BrepBuilder } from 'cad-brep';
import type { Mesh } from '../src/index.ts';

export const N = 16, R = 5;
export const XY = { origin: [0, 0, 0], axis: [0, 0, 1], xDir: [1, 0, 0] };

/** Body `b` a sheet of `faces` (`copies` sheets of them, each its own shell using them). */
export function sheet(b: BrepBuilder, faces: number[], copies = 1): BrepData {
  for (let k = 0; k < copies; k++) b.addItem({ kind: 'body', ref: b.addBody({ kind: 'sheet', members: [{
    ref: b.addShell({ kind: 'open', faces: faces.map((face) => ({ face, sense: true })) }), sense: true }] }) });
  return b.finish();
}

/**
 * Face 10: the square [-10, 10]^2 on z = 0 with a hole of radius `radius` at the origin (its edge the whole circle),
 * used by `uses` shells.
 */
export function plate(radius = R, uses = 1): BrepData {
  const b = new BrepBuilder();
  const c = [[-10, -10], [10, -10], [10, 10], [-10, 10]].map(([x, y]) => b.addVertex({ point: [x!, y!, 0] }));
  const at = [[-10, -10], [10, -10], [10, 10], [-10, 10]];
  const sides = [0, 1, 2, 3].map((k) => b.addEdge({ curve: b.addCurve({ kind: 'line', point: [...at[k]!, 0],
    direction: [(at[(k + 1) % 4]![0]! - at[k]![0]!) / 20, (at[(k + 1) % 4]![1]! - at[k]![1]!) / 20, 0],
    magnitude: 1 }),
  start: c[k]!, end: c[(k + 1) % 4]!, sameSense: true, id: 1 + k }));
  const v = b.addVertex({ point: [radius, 0, 0] });
  const hole = b.addEdge({ curve: b.addCurve({ kind: 'circle', position: XY, radius }), start: v, end: v,
    sameSense: true, id: 5 });
  const face = b.addFace({ surface: b.addSurface({ kind: 'plane', position: XY }), sameSense: true, id: 10, loops: [
    { kind: 'edge', bound: 'outer', sense: true, coedges: sides.map((edge) => ({ edge, orientation: 'forward' })) },
    { kind: 'edge', bound: 'inner', sense: true, coedges: [{ edge: hole, orientation: 'reversed' }] }] });
  return sheet(b, [face], uses);
}

/**
 * The plate's mesh: the hole's polygon of `n` sides (corners on its circle, of radius `radius`) joined to the points
 * where the same rays meet the square (its corners among them, at 45 degrees), a quad per ray step in two triangles,
 * under `source`; positions minus `origin`.
 */
export function plateMesh(origin: [number, number, number] = [0, 0, 0], source = 10, n = N, radius = R): Mesh {
  const pos: number[] = [], ix: number[] = [];
  for (let k = 0; k < n; k++) {
    const a = 2 * Math.PI * k / n, c = Math.cos(a), s = Math.sin(a), out = 10 / Math.max(Math.abs(c), Math.abs(s));
    pos.push(radius * c - origin[0], radius * s - origin[1], -origin[2], out * c - origin[0], out * s - origin[1],
      -origin[2]);
  }
  for (let k = 0; k < n; k++) {
    const h = 2 * k, o = 2 * k + 1, h1 = 2 * ((k + 1) % n), o1 = h1 + 1;
    ix.push(h, o, o1, h, o1, h1);
  }
  return { origin, positions: Float32Array.from(pos), indices: Uint32Array.from(ix),
    faces: [{ source, start: 0, count: ix.length }] };
}
