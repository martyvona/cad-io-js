// truck's model reader (native/src/model.rs): models meshed from their rows, checked against the model's own geometry
// (cad-brep's evaluators): every mesh point on its face's surface, facing as the face does, every edge point on its
// edge's curve within the edge. Needs the built module (./build.sh); skipped without it.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { BrepBuilder, type BrepData, curveEvaluator, edgeParams, nearestParam, nearestParams, normalAt, openBrep,
  rowCount, surfaceEvaluator } from 'cad-brep';
import type { TessellationRequest, TessellationResult } from 'cad-scene';
import { box, MODELS } from '../../cad-brep/test/models.ts';
import { TruckTessellator } from '../src/index.ts';

const built = fs.existsSync(path.join(import.meta.dirname, '../dist/tess_truck.wasm'));
const skip = built ? false : 'tess-truck not built (run packages/tess-truck/build.sh)';
const XY = { origin: [0, 0, 0], axis: [0, 0, 1], xDir: [1, 0, 0] };

async function both() {
  const native = new TruckTessellator();
  await native.init();
  return { native };
}

const request = (b: BrepBuilder, linearDeflection = 0.05): TessellationRequest => ({ format: 'cad-brep',
  data: new Uint8Array(b.finish().buffer), origin: [0, 0, 0], linearDeflection, angularDeflection: 0.5,
  edges: true });

/** Per face id: triangles and mesh area. */
function faces(r: TessellationResult) {
  const out = new Map<number | null, [number, number]>();
  const p = r.positions, ix = r.indices;
  for (const f of r.faces) {
    let area = 0;
    for (let t = f.start; t < f.start + f.count; t += 3) {
      const [a, b, c] = [ix[t]! * 3, ix[t + 1]! * 3, ix[t + 2]! * 3];
      const u = [p[b]! - p[a]!, p[b + 1]! - p[a + 1]!, p[b + 2]! - p[a + 2]!];
      const v = [p[c]! - p[a]!, p[c + 1]! - p[a + 1]!, p[c + 2]! - p[a + 2]!];
      area += Math.hypot(u[1]! * v[2]! - u[2]! * v[1]!, u[2]! * v[0]! - u[0]! * v[2]!, u[0]! * v[1]! - u[1]! * v[0]!)
        / 2;
    }
    const x = out.get(f.entityId) ?? [0, 0];
    out.set(f.entityId, [x[0] + f.count / 3, x[1] + area]);
  }
  return out;
}

/**
 * The mesh against the model's geometry: each face's points on its surface (within 1e-5 of the part's size; the
 * points are single precision), each normal within 8 degrees of the surface's there, turned by the face's sense;
 * each edge's points on its curve within the edge's parameters, from its start vertex to its end. How many points it
 * checked (a surface without a closed form or finite ranges, an extrusion, isn't checked by points).
 */
function onModel(name: string, d: BrepData, r: TessellationResult): number {
  // Each face's way of facing (every use forward: the face's own).
  const signs = new Map<number, Set<number>>();
  for (let m = 0; m < rowCount(d, 'member'); m++) {
    const s = d.member.ref[m]!, first = d.shell.first[s]!;
    if (s >= rowCount(d, 'shell')) continue;
    for (let u = first; u < first + d.shell.count[s]!; u++) {
      const f = d.faceUse.face[u]!;
      if (!signs.has(f)) signs.set(f, new Set());
      signs.get(f)!.add(d.face.sameSense[f] ? 1 : -1);
    }
  }
  const byId = (ids: Uint32Array, id: number | null) => (id === null ? -1 : ids.indexOf(id));
  let size = 1;
  for (const x of r.positions) size = Math.max(size, Math.abs(x));
  let checked = 0;
  for (const f of r.faces) {
    const row = byId(d.face.id, f.entityId);
    if (row < 0) continue;
    const s = surfaceEvaluator(d, d.face.surface[row]!)!;
    for (let t = f.start; t < f.start + f.count; t++) {
      const v = r.indices[t]!, p = [0, 1, 2].map((k) => r.positions[3 * v + k]!);
      const uv = s.params?.(p) ?? nearestParams(s, p);
      if (!uv) continue;
      const q = s.point(uv[0], uv[1]);
      assert.ok(Math.hypot(...p.map((x, k) => x - q[k]!)) < 1e-5 * size, `${name}: face #${f.entityId} point ${p}`);
      const n = normalAt(s, uv[0], uv[1]);
      if (n) {
        const m = [0, 1, 2].map((k) => r.normals![3 * v + k]!);
        const both = signs.get(row)!.size === 2, raw = m[0]! * n[0]! + m[1]! * n[1]! + m[2]! * n[2]!;
        const dot = both ? Math.abs(raw) : raw * [...signs.get(row)!][0]!;
        assert.ok(dot > Math.cos(8 * Math.PI / 180), `${name}: face #${f.entityId} normal ${m} against ${n}`);
      }
      checked++;
    }
  }
  for (const e of r.edges ?? []) {
    const row = byId(d.edge.id, e.entityId);
    if (row < 0 || d.edge.curve[row]! < 0) continue;
    const c = curveEvaluator(d, d.edge.curve[row]!)!;
    const range = edgeParams(d, row, c);
    if (!range) continue;
    // (Its points from its start to its end, where it has both.)
    const [a, z] = [d.edge.start[row]!, d.edge.end[row]!];
    if (a >= 0 && z >= 0 && e.count >= 2) {
      for (const [k, vtx] of [[e.start, a], [e.start + e.count - 1, z]] as const) {
        const want = Array.from(d.vertex.point.subarray(3 * vtx, 3 * vtx + 3));
        const got = [0, 1, 2].map((j) => r.edgePositions![3 * k + j]!);
        assert.ok(Math.hypot(...got.map((x, j) => x - want[j]!)) < 1e-5 * size,
          `${name}: edge #${e.entityId} from ${got}, not its vertex ${want}`);
      }
    }
    const lo = Math.min(...range), hi = Math.max(...range), slack = 1e-6 * Math.max(1, hi - lo);
    for (let k = e.start; k < e.start + e.count; k++) {
      const p = [0, 1, 2].map((j) => r.edgePositions![3 * k + j]!);
      const t = nearestParam(c, p, [lo - slack, hi + slack]);
      const q = c.point(t);
      assert.ok(Math.hypot(...p.map((x, j) => x - q[j]!)) < 1e-5 * size, `${name}: edge #${e.entityId} point ${p}`);
      checked++;
    }
  }
  return checked;
}

/** A model meshed and checked against its geometry (`onModel`), needing none of truck's fixes; the result. */
async function alike(name: string, b: BrepBuilder, linearDeflection = 0.01) {
  const { native } = await both();
  const d = b.finish();
  const r = await native.tessellate({ ...request(new BrepBuilder(), linearDeflection),
    data: new Uint8Array(d.buffer) });
  assert.ok(r.faces.length > 0, name);
  assert.ok(onModel(name, d, r) > 0, `${name}: nothing checked`);
  assert.deepEqual(r.diagnostics.filter((x) => /reversed/.test(x.message)), [], name);
  return r;
}

test('the test models it meshes on their geometry, facing as their faces do, needing none of truck\'s fixes', { skip },
  async () => {
    for (const name of ['cube', 'withVoid', 'seamCylinder', 'everyKind', 'reversedUses', 'withoutIds'] as const) {
      await alike(name, MODELS[name](), 0.05);
    }
  });

/** A sheet of one face on `surface`, bounded by one loop of `edges` (curve, start, end, sense, used reversed). */
function sheet(b: BrepBuilder, surface: number, edges: [number, number[], number[], boolean, boolean?][], id = 1) {
  const vs = new Map<string, number>();
  const vertex = (p: number[]) => {
    const k = p.join();
    if (!vs.has(k)) vs.set(k, b.addVertex({ point: p }));
    return vs.get(k)!;
  };
  const coedges = edges.map(([curve, p, q, sameSense, reversed], j) => ({ edge: b.addEdge({ curve, start: vertex(p),
    end: vertex(q), sameSense, id: 100 * id + j }),
  orientation: reversed ? 'reversed' as const : 'forward' as const }));
  const face = b.addFace({ surface, sameSense: true, id, loops: [{ kind: 'edge', bound: 'outer', sense: true,
    coedges }] });
  const shell = b.addShell({ kind: 'open', faces: [{ face, sense: true }] });
  b.addItem({ kind: 'body', ref: b.addBody({ kind: 'sheet', members: [{ ref: shell, sense: true }] }) });
}

const line = (b: BrepBuilder, p: number[], q: number[]) => {
  const d = q.map((x, k) => x - p[k]!), n = Math.hypot(...d);
  return b.addCurve({ kind: 'line', point: p, direction: d.map((x) => x / n), magnitude: n });
};
const at = (z: number) => ({ origin: [0, 0, z], axis: [0, 0, 1], xDir: [1, 0, 0] });

test('kinds the test models lack, on their geometry and of the right areas: an ellipse with an edge against its '
  + 'curve, a cone, a rational arc, a B-spline surface of 3 x 2 poles, an extrusion, a '
  + 'revolution', { skip }, async () => {
  const area = (r: TessellationResult) => faces(r).get(1)![1];
  const near = (x: number, want: number, rel: number, what: string) => assert.ok(Math.abs(x - want) < rel * want,
    `${what}: ${x}, not ${want}`);
  {
    // An ellipse (a = 2, b = 1) as one closed edge against its curve (clockwise), used reversed (counter-clockwise).
    const b = new BrepBuilder();
    const e = b.addCurve({ kind: 'ellipse', position: XY, semiAxis1: 2, semiAxis2: 1 });
    sheet(b, b.addSurface({ kind: 'plane', position: XY }), [[e, [2, 0, 0], [2, 0, 0], false, true]]);
    near(area(await alike('ellipse', b)), 2 * Math.PI, 0.01, 'ellipse');
  }
  {
    // A frustum of a cone (radius 1 at z = 0, semi-angle 30 degrees) up to z = 1, bounded by its circles and a seam.
    const b = new BrepBuilder();
    const t = Math.tan(Math.PI / 6), R = 1 + t;
    const cone = b.addSurface({ kind: 'cone', position: XY, radius: 1, semiAngle: Math.PI / 6 });
    const low = b.addCurve({ kind: 'circle', position: at(0), radius: 1 });
    const high = b.addCurve({ kind: 'circle', position: at(1), radius: R });
    const seam = line(b, [1, 0, 0], [R, 0, 1]);
    sheet(b, cone, [[low, [1, 0, 0], [1, 0, 0], true], [seam, [1, 0, 0], [R, 0, 1], true],
      [high, [R, 0, 1], [R, 0, 1], false], [seam, [R, 0, 1], [1, 0, 0], false]]);
    near(area(await alike('cone', b)), Math.PI * (1 + R) / Math.cos(Math.PI / 6), 0.01, 'cone');
  }
  {
    // A quarter disc bounded by a rational quadratic arc (exactly the circle).
    const b = new BrepBuilder();
    const arc = b.addCurve({ kind: 'bspline', degree: 2, knots: [0, 1], multiplicities: [3, 3],
      poles: [[1, 0, 0], [1, 1, 0], [0, 1, 0]], weights: [1, Math.SQRT1_2, 1], closed: false, selfIntersect: false,
      form: 'circular_arc' });
    sheet(b, b.addSurface({ kind: 'plane', position: XY }), [[line(b, [0, 0, 0], [1, 0, 0]), [0, 0, 0], [1, 0, 0],
      true], [arc, [1, 0, 0], [0, 1, 0], true], [line(b, [0, 1, 0], [0, 0, 0]), [0, 1, 0], [0, 0, 0], true]]);
    near(area(await alike('rational arc', b)), Math.PI / 4, 0.01, 'rational arc');
  }
  {
    // A bilinear B-spline surface of 3 x 2 poles, folded along x = 1; its u boundaries polylines.
    const b = new BrepBuilder();
    const pole = (i: number, j: number) => [i, j, i === 1 ? 0.5 : 0];
    const s = b.addSurface({ kind: 'bspline', uDegree: 1, vDegree: 1, uKnots: [0, 1, 2], vKnots: [0, 1],
      uMultiplicities: [2, 1, 2], vMultiplicities: [2, 2], poles: [0, 1, 2].map((i) => [0, 1].map((j) => pole(i, j))),
      uClosed: false, vClosed: false, selfIntersect: false, form: 'unspecified' });
    const poly = (j: number) => b.addCurve({ kind: 'polyline', points: [0, 1, 2].map((i) => pole(i, j)) });
    sheet(b, s, [[poly(0), pole(0, 0), pole(2, 0), true], [line(b, pole(2, 0), pole(2, 1)), pole(2, 0), pole(2, 1),
      true], [poly(1), pole(2, 1), pole(0, 1), false], [line(b, pole(0, 1), pole(0, 0)), pole(0, 1), pole(0, 0),
      true]]);
    near(area(await alike('B-spline surface', b)), 2 * Math.hypot(1, 0.5), 1e-6, 'B-spline surface');
  }
  {
    // A square on a plane facing -z (the face against its surface), its loop clockwise about +z; and a triangle whose
    // loop runs against its bound (three edges, so their order matters, not only their directions).
    const b = new BrepBuilder();
    const down = b.addSurface({ kind: 'plane', position: XY });
    const sq = [[0, 0, 0], [0, 1, 0], [1, 1, 0], [1, 0, 0]];
    const edges = sq.map((p, j): [number, number[], number[], boolean] => [line(b, p, sq[(j + 1) % 4]!), p,
      sq[(j + 1) % 4]!, true]);
    const vs = new Map<string, number>();
    const vertex = (p: number[]) => {
      if (!vs.has(p.join())) vs.set(p.join(), b.addVertex({ point: p }));
      return vs.get(p.join())!;
    };
    const coedges = edges.map(([curve, p, q]) => ({ edge: b.addEdge({ curve, start: vertex(p), end: vertex(q),
      sameSense: true }), orientation: 'forward' as const }));
    const face = b.addFace({ surface: down, sameSense: false, id: 1, loops: [{ kind: 'edge', bound: 'outer',
      sense: true, coedges }] });
    const tri = [[3, 0, 0], [3, 1, 0], [4, 0, 0]];
    const tcoedges = tri.map((p, j) => ({ edge: b.addEdge({ curve: line(b, p, tri[(j + 1) % 3]!), start: vertex(p),
      end: vertex(tri[(j + 1) % 3]!), sameSense: true }), orientation: 'forward' as const }));
    const tface = b.addFace({ surface: b.addSurface({ kind: 'plane', position: XY }), sameSense: true, id: 2,
      loops: [{ kind: 'edge', bound: 'outer', sense: false, coedges: tcoedges }] });
    const shell = b.addShell({ kind: 'open', faces: [{ face, sense: true }, { face: tface, sense: true }] });
    b.addItem({ kind: 'body', ref: b.addBody({ kind: 'sheet', members: [{ ref: shell, sense: true }] }) });
    const r = await alike('against their surface and bound', b);
    // Both facing as their faces do: the square -z, the triangle +z (the loop clockwise, turned by its bound).
    const nz = (id: number) => r.normals![3 * r.indices[r.faces.find((x) => x.entityId === id)!.start]! + 2];
    assert.deepEqual([nz(1), nz(2)], [-1, 1]);
  }
  {
    // A quarter of a cylinder of radius 1 and height 1 as a rational B-spline surface (quadratic arcs in u, exact).
    const b = new BrepBuilder();
    const w = Math.SQRT1_2, arc = [[1, 0], [1, 1], [0, 1]];
    const s = b.addSurface({ kind: 'bspline', uDegree: 2, vDegree: 1, uKnots: [0, 1], vKnots: [0, 1],
      uMultiplicities: [3, 3], vMultiplicities: [2, 2], poles: arc.map(([x, y]) => [0, 1].map((z) => [x!, y!, z])),
      weights: [[1, 1], [w, w], [1, 1]], uClosed: false, vClosed: false, selfIntersect: false, form: 'unspecified' });
    const [c0, c1] = [0, 1].map((z) => b.addCurve({ kind: 'circle', position: at(z), radius: 1 }));
    sheet(b, s, [[c0!, [1, 0, 0], [0, 1, 0], true], [line(b, [0, 1, 0], [0, 1, 1]), [0, 1, 0], [0, 1, 1], true],
      [c1!, [0, 1, 1], [1, 0, 1], false], [line(b, [1, 0, 1], [1, 0, 0]), [1, 0, 1], [1, 0, 0], true]]);
    near(area(await alike('rational B-spline surface', b)), Math.PI / 2, 0.01, 'rational B-spline surface');
  }
  {
    // A cylinder about a tilted axis, its placement's directions orthonormal only to rounding (as a file's are).
    const b = new BrepBuilder();
    const z = [1, 2, 3].map((x) => x / Math.hypot(1, 2, 3)), x0 = [3, 0, -1].map((x) => x / Math.hypot(3, 0, -1));
    const position = { origin: [0.1, 0.2, 0.3], axis: z, xDir: x0 };
    const y = [z[1]! * x0[2]! - z[2]! * x0[1]!, z[2]! * x0[0]! - z[0]! * x0[2]!, z[0]! * x0[1]! - z[1]! * x0[0]!];
    const p = (u: number, v: number) => [0, 1, 2].map((k) => position.origin[k]! + Math.cos(u) * x0[k]!
      + Math.sin(u) * y[k]! + v * z[k]!);
    const [c0, c1] = [0, 1].map((v) => b.addCurve({ kind: 'circle', position: { ...position,
      origin: p(0, v).map((c, k) => c - x0[k]!) }, radius: 1 }));
    sheet(b, b.addSurface({ kind: 'cylinder', position, radius: 1 }), [[c0!, p(0, 0), p(Math.PI / 2, 0), true],
      [line(b, p(Math.PI / 2, 0), p(Math.PI / 2, 1)), p(Math.PI / 2, 0), p(Math.PI / 2, 1), true],
      [c1!, p(Math.PI / 2, 1), p(0, 1), false], [line(b, p(0, 1), p(0, 0)), p(0, 1), p(0, 0), true]]);
    near(area(await alike('tilted cylinder', b)), Math.PI / 2, 0.01, 'tilted cylinder');
  }
  {
    // A unit square on z = 0 whose last edge has no 3D curve, only a p-curve: a line in the plane's parameters (its u
    // and v are x and y), the edge running against it.
    const b = new BrepBuilder();
    const plane = b.addSurface({ kind: 'plane', position: XY });
    const sq = [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0]];
    const vs = sq.map((point) => b.addVertex({ point }));
    const es = sq.slice(0, 3).map((p, j) => b.addEdge({ curve: line(b, p, sq[j + 1]!), start: vs[j]!, end: vs[j + 1]!,
      sameSense: true, id: 10 + j }));
    // (The edge against its p-curve, which runs from (0, 0) up to (0, 1).)
    es.push(b.addEdge({ start: vs[3]!, end: vs[0]!, sameSense: false, id: 13 }));
    const p2 = b.addCurve({ kind: 'line', point: [0, 0], direction: [0, 1], magnitude: 1 });
    const face = b.addFace({ surface: plane, sameSense: true, id: 1, loops: [{ kind: 'edge', bound: 'outer',
      sense: true, coedges: es.map((edge, j) => ({ edge, orientation: 'forward' as const,
        ...(j === 3 ? { pcurve: p2 } : {}) })) }] });
    const shell = b.addShell({ kind: 'open', faces: [{ face, sense: true }] });
    b.addItem({ kind: 'body', ref: b.addBody({ kind: 'sheet', members: [{ ref: shell, sense: true }] }) });
    const r = await alike('p-curve-only edge', b);
    near(area(r), 1, 1e-9, 'p-curve-only edge');
    assert.ok(r.edges!.some((e) => e.entityId === 13 && e.count >= 2), 'the edge drawn');
  }
  for (const kind of ['extrusion', 'revolution'] as const) {
    // A quarter of a cylinder of radius 1 and height 2: a circle extruded by 2 along z, or a line of length 2
    // revolved about z; bounded by quarter arcs at z = 0 and 2 and the lines between them.
    const b = new BrepBuilder();
    const surface = kind === 'extrusion'
      ? b.addSurface({ kind, curve: b.addCurve({ kind: 'circle', position: XY, radius: 1 }), direction: [0, 0, 1],
        magnitude: 2 })
      : b.addSurface({ kind, curve: line(b, [1, 0, 0], [1, 0, 2]), axisOrigin: [0, 0, 0], axisDirection: [0, 0, 1] });
    const [c0, c2] = [0, 2].map((z) => b.addCurve({ kind: 'circle', position: at(z), radius: 1 }));
    sheet(b, surface, [[c0!, [1, 0, 0], [0, 1, 0], true], [line(b, [0, 1, 0], [0, 1, 2]), [0, 1, 0], [0, 1, 2], true],
      [c2!, [0, 1, 2], [1, 0, 2], false], [line(b, [1, 0, 2], [1, 0, 0]), [1, 0, 2], [1, 0, 0], true]]);
    near(area(await alike(kind, b)), Math.PI, 0.01, kind);
  }
});

test('a face bounded by its surface alone meshed over its natural bounds; a vertex loop\'s face and a wire left out, '
  + 'said; poly loops meshed (edge loops in the model)', { skip }, async () => {
  const { native } = await both();
  const s = await native.tessellate(request(MODELS.spheres(), 0.002));
  // The whole sphere (no loops: no id), radius 1: its area 4 pi, less what the sag of 0.002 takes off (under 1 %).
  const whole = faces(s).get(null)!;
  assert.ok(whole[0] > 0 && whole[1] < 4 * Math.PI && whole[1] > 0.99 * 4 * Math.PI, String(whole));
  assert.match(s.diagnostics.map((d) => d.message).join('\n'), /1 faces truck can't convert \(left out\): \(no id\)/);
  const f = await native.tessellate(request(MODELS.facetedAndWire()));
  const said = f.diagnostics.map((d) => d.message).join('\n');
  assert.doesNotMatch(said, /can't convert/);
  assert.match(said, /representation items truck doesn't mesh: a wire body #0/);
  // The tetrahedron's faces (three right triangles and one of side sqrt 2), without ids. (The square, against its
  // plane with its loop counter-clockwise about the plane's normal, so clockwise about its own: a hole in an unbounded
  // face, nothing meshed.)
  const all = faces(f).get(null)!;
  assert.ok(Math.abs(all[1] - (1.5 + Math.sqrt(3) / 2)) < 1e-6, String(all));
});

test('kinds truck has no geometry for leave their faces out, said; items not bodies skipped',
  { skip }, async () => {
    const { native } = await both();
    // A square whose first edge's curve is an offset (truck has no offset curve; a trimmed one the builder unwraps),
    // beside a box.
    const b = new BrepBuilder();
    const c = [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0]];
    const vs = c.map((point) => b.addVertex({ point }));
    const line = (p: number[], q: number[]) => b.addCurve({ kind: 'line', point: p, direction: [q[0]! - p[0]!,
      q[1]! - p[1]!, 0].map((x) => x / Math.hypot(q[0]! - p[0]!, q[1]! - p[1]!)), magnitude: 1 });
    const offset = b.addCurve({ kind: 'offset', basis: line(c[0]!, c[1]!), distance: 0, selfIntersect: false,
      refDirection: [0, 0, 1] });
    const es = c.map((p, j) => b.addEdge({ curve: j === 0 ? offset : line(p, c[(j + 1) % 4]!), start: vs[j]!,
      end: vs[(j + 1) % 4]!, sameSense: true, id: 70 + j }));
    const face = b.addFace({ surface: b.addSurface({ kind: 'plane', position: XY }), sameSense: true, id: 80,
      loops: [{ kind: 'edge', bound: 'outer', sense: true, coedges: es.map((edge) => ({ edge,
        orientation: 'forward' as const })) }] });
    const shell = b.addShell({ kind: 'open', faces: [{ face, sense: true }] });
    b.addItem({ kind: 'body', ref: b.addBody({ kind: 'sheet', members: [{ ref: shell, sense: true }] }) });
    const solid = b.addBody({ kind: 'solid', members: [{ ref: box(b, [1, 1, 1], [5, 0, 0], 100), sense: true }] });
    b.addItem({ kind: 'body', ref: solid });
    b.addItem({ kind: 'curve', ref: line([0, 0, 0], [0, 0, 1]), id: 90 });
    b.addItem({ kind: 'point', point: [9, 0, 0], id: 91 });
    const r = await native.tessellate(request(b));
    assert.deepEqual([...faces(r).keys()].sort(), [121, 122, 123, 124, 125, 126]);
    const said = r.diagnostics.map((d) => d.message);
    assert.ok(said.includes('1 faces truck can\'t convert (left out): #80'), said.join('\n'));
    assert.ok(said.includes('1 edges truck can\'t convert: #70'), said.join('\n'));
    assert.ok(said.includes('representation items truck doesn\'t mesh: a curve #90, a point #91'),
      said.join('\n'));
  });

test('ids up to 2^32 - 1 as they are, a face or edge without one as null', { skip }, async () => {
  const { native } = await both();
  const b = new BrepBuilder();
  const base = 2 ** 32 - 30;
  b.addItem({ kind: 'body', ref: b.addBody({ kind: 'solid', members: [{ ref: box(b, [1, 1, 1], [0, 0, 0], base),
    sense: true }] }) });
  const d = openBrep(b.finish().buffer.slice(0));
  d.face.id[0] = 0;
  d.edge.id[0] = 0;
  const r = await native.tessellate({ ...request(new BrepBuilder()), data: new Uint8Array(d.buffer) });
  assert.deepEqual([...faces(r).keys()].sort(), [null, ...[22, 23, 24, 25, 26].map((k) => base + k)].sort());
  assert.deepEqual([...new Set(r.edges!.map((e) => e.entityId))].sort(),
    [null, ...Array.from({ length: 11 }, (_, k) => base + 10 + k)].sort());
});

test('a buffer that isn\'t a model is refused with an error', { skip }, async () => {
  const { native } = await both();
  const r = await native.tessellate({ ...request(MODELS.cube()), data: new Uint8Array(64) });
  assert.deepEqual([r.indices.length, r.diagnostics.map((d) => [d.severity, d.message])],
    [0, [['error', 'truck: not a cad-brep buffer of this format (CBR6)']]]);
});

test('parabola and hyperbola edges on their curves (truck-stepio converts both wrongly), their '
  + 'faces of the right area', { skip }, async () => {
  const { native } = await both();
  // On z = 0: the parabola y^2 = 4 f x (f = 1), and the hyperbola x^2 - y^2 = 1, each from t = -1 to 1, closed by
  // the chord between its ends.
  const cases = [
    { curve: { kind: 'parabola' as const, position: XY, focalDist: 1 }, at: (t: number) => [t * t, 2 * t],
      on: (x: number, y: number) => y * y - 4 * x, area: 8 / 3 },
    { curve: { kind: 'hyperbola' as const, position: XY, semiAxis: 1, semiImagAxis: 1 },
      at: (t: number) => [Math.cosh(t), Math.sinh(t)], on: (x: number, y: number) => x * x - y * y - 1,
      // The chord at x = cosh 1, less the area under x = sqrt(1 + y^2) between the ends.
      area: 2 * Math.sinh(1) * Math.cosh(1) - (Math.sinh(1) * Math.cosh(1) + Math.asinh(Math.sinh(1))) },
  ];
  for (const k of cases) {
    const b = new BrepBuilder();
    const [p, q] = [k.at(-1), k.at(1)].map((x) => b.addVertex({ point: [x[0]!, x[1]!, 0] }));
    const chord = b.addCurve({ kind: 'line', point: [...k.at(1), 0], direction: [0, -1, 0], magnitude: 1 });
    const arc = b.addEdge({ curve: b.addCurve(k.curve), start: p!, end: q!, sameSense: true, id: 1 });
    const back = b.addEdge({ curve: chord, start: q!, end: p!, sameSense: true, id: 2 });
    const face = b.addFace({ surface: b.addSurface({ kind: 'plane', position: XY }), sameSense: true, id: 3,
      // (The arc then the chord run clockwise about +z: the bound against them.)
      loops: [{ kind: 'edge', bound: 'outer', sense: false, coedges: [{ edge: arc, orientation: 'forward' },
        { edge: back, orientation: 'forward' }] }] });
    const shell = b.addShell({ kind: 'open', faces: [{ face, sense: true }] });
    b.addItem({ kind: 'body', ref: b.addBody({ kind: 'sheet', members: [{ ref: shell, sense: true }] }) });
    const r = await native.tessellate(request(b, 0.001));
    const e = r.edges!.find((x) => x.entityId === 1)!;
    assert.ok(e.count > 4, k.curve.kind);
    for (let j = e.start; j < e.start + e.count; j++) {
      const [x, y] = [r.edgePositions![3 * j]!, r.edgePositions![3 * j + 1]!];
      assert.ok(Math.abs(k.on(x, y)) < 1e-5, `${k.curve.kind}: (${x}, ${y}) off the curve`);
    }
    const [tris, area] = faces(r).get(3)!;
    assert.ok(tris > 0 && Math.abs(area - k.area) < 0.01 * k.area, `${k.curve.kind}: area ${area}, not ${k.area}`);
  }
});
