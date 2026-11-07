// A B-rep as JSON: every row decoded (types.ts), for tests, debugging and dumps. brepFromJson(brepToJson(d)) gives
// d's bytes again. Not an exchange format: brepFromJson throws on what the builder refuses.

import { BrepBuilder } from './builder.ts';
import { type BrepData, rowCount } from './data.ts';
import * as decode from './decode.ts';
import type { Body, Curve, Edge, Face, Item, PartInfo, Shell, Surface, Vertex } from './types.ts';

export interface BrepJson extends PartInfo {
  format: 'cad-brep';
  curves: Curve[];
  surfaces: Surface[];
  vertices: Vertex[];
  edges: Edge[];
  faces: Face[];
  shells: Shell[];
  bodies: Body[];
  items: Item[];
}

export function brepToJson(d: BrepData): BrepJson {
  const all = <T>(table: Parameters<typeof rowCount>[1], f: (d: BrepData, k: number) => T) =>
    Array.from({ length: rowCount(d, table) }, (_, k) => f(d, k));
  return { format: 'cad-brep', ...decode.part(d), curves: all('curve', decode.curve),
    surfaces: all('surface', decode.surface), vertices: all('vertex', decode.vertex), edges: all('edge', decode.edge),
    faces: all('face', decode.face), shells: all('shell', decode.shell), bodies: all('body', decode.body),
    items: all('item', decode.item) };
}

export function brepFromJson(j: BrepJson): BrepData {
  if (j.format !== 'cad-brep') throw new TypeError(`format ${JSON.stringify(j.format)}, not cad-brep`);
  const b = new BrepBuilder({ unit: j.unit, ...(j.uncertainty === undefined ? {} : { uncertainty: j.uncertainty }) });
  for (const c of j.curves) b.addCurve(c);
  for (const s of j.surfaces) b.addSurface(s);
  for (const v of j.vertices) b.addVertex(v);
  for (const e of j.edges) b.addEdge(e);
  for (const f of j.faces) b.addFace(f);
  for (const s of j.shells) b.addShell(s);
  for (const x of j.bodies) b.addBody(x);
  for (const i of j.items) b.addItem(i);
  return b.finish();
}
