// Rigid placements (rigid.ts), against the scene before the pass: every placement a rotation after it, every placed
// part's mesh where it was in the world, its triangles facing out (turned over exactly where a mirror placed them), its
// normals the world's by the inverse transpose, B-rep vertices where they were, measures scaled; copies shared by equal
// stretches; a shear refused on a B-rep.

import assert from 'node:assert/strict';
import test from 'node:test';
import { BrepBuilder, rowCount } from 'cad-brep';
import { cube } from '../../cad-brep/test/models.ts';
import { describeStretched, identity, partInstances, rigidPart, rigidPlacements, stretchWords, type Mat4, type Mesh,
  type Part, type Scene } from '../src/index.ts';

const M = (l: number[], t = [0, 0, 0]): Mat4 => Float64Array.of(l[0]!, l[1]!, l[2]!, 0, l[3]!, l[4]!, l[5]!, 0, l[6]!,
  l[7]!, l[8]!, 0, t[0]!, t[1]!, t[2]!, 1);
const rot = (a: number): number[] => [Math.cos(a), Math.sin(a), 0, -Math.sin(a), Math.cos(a), 0, 0, 0, 1];
const scaled = (l: number[], s: number) => l.map((x) => x * s);
const MIRROR_X = [-1, 0, 0, 0, 1, 0, 0, 0, 1];
const I_3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];

/** A tetrahedron's mesh, facing out, with normals, a face per triangle, an edge and a point. */
function tetra(origin: [number, number, number]): Mesh {
  const p = [[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1]];
  const tris = [[0, 2, 1], [0, 1, 3], [0, 3, 2], [1, 2, 3]];
  const positions: number[] = [], normals: number[] = [], indices: number[] = [];
  tris.forEach((t) => {
    const [a, b, c] = t.map((i) => p[i]!) as [number[], number[], number[]];
    const u = b.map((x, k) => x - a[k]!), v = c.map((x, k) => x - a[k]!);
    const n = [u[1]! * v[2]! - u[2]! * v[1]!, u[2]! * v[0]! - u[0]! * v[2]!, u[0]! * v[1]! - u[1]! * v[0]!];
    const len = Math.hypot(...n);
    for (const q of [a, b, c]) { positions.push(...q); normals.push(...n.map((x) => x / len)); }
    indices.push(indices.length, indices.length + 1, indices.length + 2);
  });
  return { origin, positions: Float32Array.from(positions), normals: Float32Array.from(normals),
    indices: Uint32Array.from(indices), faces: tris.map((_, k) => ({ source: 10 + k, start: 3 * k, count: 3 })),
    edgePositions: Float32Array.of(0, 0, 0, 1, 0, 0), edges: [{ source: 1, start: 0, count: 2, kind: 'shared' }],
    points: Float32Array.of(0.5, 0.5, 0.5), pointSources: [7] };
}

const meshPart = (name: string): Part => ({ name, sources: [], properties: {}, origin: [3, 1, 2],
  lods: [{ mesh: tetra([3, 1, 2]), from: 'source' }] });
function brepPart(name: string): Part {
  const model = cube().finish();
  return { name, sources: [], properties: {}, origin: [0, 0, 0], brep: { model, format: 'step' }, lods: [],
    measures: { by: 'source', faces: new Map([[21, { area: 1, perimeter: 4, valid: true }]]) } };
}

/** Two parts in a component placed twice (plainly and mirrored, scaled and turned), with placements of their own. */
function scene(): Scene {
  return {
    unit: 'millimetre', parts: [meshPart('a'), brepPart('b')], materials: [], layers: [], overrides: [],
    properties: {}, diagnostics: [],
    components: [
      { name: 'top', sources: [], properties: {}, parts: [{ part: 0, transform: M(scaled(rot(0.3), 2), [1, 2, 3]) },
        { part: 1, transform: M(MIRROR_X, [0, 5, 0]) }], children: [{ component: 1, transform: M(rot(1), [9, 0, 0]),
        sources: [], properties: {} }, { component: 1, transform: M(scaled(MIRROR_X, 0.5), [0, 0, 9]), sources: [],
        properties: {} }] },
      { name: 'sub', sources: [], properties: {}, parts: [{ part: 0, transform: M(rot(-0.5), [0, 1, 0]) },
        { part: 1, transform: identity() }], children: [] },
    ],
    roots: [{ component: 0, transform: M(scaled(rot(0.2), 3), [1, 1, 1]), sources: [], properties: {} }],
    rootParts: [{ part: 0, transform: M(MIRROR_X, [-4, 0, 0]) }],
  };
}

const apply = (m: Mat4, p: ArrayLike<number>) => [0, 1, 2].map((i) => m[i]! * p[0]! + m[4 + i]! * p[1]!
  + m[8 + i]! * p[2]! + m[12 + i]!);
const linear = (m: Mat4, p: ArrayLike<number>) => [0, 1, 2].map((i) => m[i]! * p[0]! + m[4 + i]! * p[1]!
  + m[8 + i]! * p[2]!);
const det = (m: Mat4) => m[0]! * (m[5]! * m[10]! - m[6]! * m[9]!) - m[4]! * (m[1]! * m[10]! - m[2]! * m[9]!)
  + m[8]! * (m[1]! * m[6]! - m[2]! * m[5]!);
const near = (a: ArrayLike<number>, b: ArrayLike<number>, tol: number) =>
  Array.from(a).every((x, i) => Math.abs(x - b[i]!) <= tol);
const unit = (v: number[]) => { const n = Math.hypot(...v); return v.map((x) => x / n); };
const cross = (a: number[], b: number[]) => [a[1]! * b[2]! - a[2]! * b[1]!, a[2]! * b[0]! - a[0]! * b[2]!,
  a[0]! * b[1]! - a[1]! * b[0]!];

/** Each placed part's world: its mesh's points and normals, triangles' winding normals, B-rep vertices, the part. */
function world(s: Scene) {
  return [...partInstances(s)].map((pi) => {
    const part = s.parts[pi.part]!, t = pi.transform, mesh = part.lods[0]?.mesh;
    const pts: number[][] = [], normals: number[][] = [], winding: number[][] = [];
    if (mesh) {
      const P = (i: number) => apply(t, [0, 1, 2].map((c) => mesh.origin[c]! + mesh.positions[3 * i + c]!));
      for (let i = 0; i < mesh.positions.length / 3; i++) pts.push(P(i));
      // Normals by the world map's inverse transpose (for a rotation, the rotation).
      const inv = invert3(t);
      for (let i = 0; i < mesh.normals!.length / 3; i++) {
        const n = mesh.normals!.subarray(3 * i, 3 * i + 3);
        normals.push(unit([0, 1, 2].map((r) => inv[3 * r]! * n[0]! + inv[3 * r + 1]! * n[1]!
          + inv[3 * r + 2]! * n[2]!)));
      }
      for (let k = 0; k < mesh.indices.length; k += 3) {
        const [a, b, c] = [0, 1, 2].map((j) => P(mesh.indices[k + j]!)) as [number[], number[], number[]];
        winding.push(unit(cross(b.map((x, j) => x - a[j]!), c.map((x, j) => x - a[j]!))));
      }
    }
    // (By id: a baked copy's rows are in the order the copier reached them.)
    const brep: number[][] = [];
    const d = part.brep?.model;
    const order = d ? [...Array(rowCount(d, 'vertex')).keys()].sort((x, y) => d.vertex.id[x]! - d.vertex.id[y]!) : [];
    for (const v of order) brep.push(apply(t, d!.vertex.point.subarray(3 * v, 3 * v + 3)));
    return { path: pi.path.join('/'), pts, normals, winding, brep, det: det(t), part, transform: t };
  });
}
/** A 3 x 3 inverse, row-major (rows of the inverse), of a Mat4's linear part. */
function invert3(m: Mat4): number[] {
  const a = [m[0]!, m[4]!, m[8]!, m[1]!, m[5]!, m[9]!, m[2]!, m[6]!, m[10]!];
  const d = a[0]! * (a[4]! * a[8]! - a[5]! * a[7]!) - a[1]! * (a[3]! * a[8]! - a[5]! * a[6]!) + a[2]! * (a[3]! * a[7]!
    - a[4]! * a[6]!);
  const inv = [a[4]! * a[8]! - a[5]! * a[7]!, a[2]! * a[7]! - a[1]! * a[8]!, a[1]! * a[5]! - a[2]! * a[4]!,
    a[5]! * a[6]! - a[3]! * a[8]!, a[0]! * a[8]! - a[2]! * a[6]!, a[2]! * a[3]! - a[0]! * a[5]!,
    a[3]! * a[7]! - a[4]! * a[6]!, a[1]! * a[6]! - a[0]! * a[7]!, a[0]! * a[4]! - a[1]! * a[3]!].map((x) => x / d);
  // Transposed: the inverse transpose's rows are the inverse's columns.
  return [inv[0]!, inv[3]!, inv[6]!, inv[1]!, inv[4]!, inv[7]!, inv[2]!, inv[5]!, inv[8]!];
}

test('rigid placements: every placement a rotation, every placed part where it was, facing out', () => {
  const s = scene(), before = world(s);
  rigidPlacements(s);
  const after = world(s);
  assert.equal(after.length, before.length);
  for (const t of [...s.components.flatMap((c) => [...c.parts, ...c.children]), ...s.roots, ...s.rootParts!]) {
    const l = linear(t.transform, [1, 0, 0]).concat(linear(t.transform, [0, 1, 0]), linear(t.transform, [0, 0, 1]));
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) {
        const dot = l[3 * i]! * l[3 * j]! + l[3 * i + 1]! * l[3 * j + 1]! + l[3 * i + 2]! * l[3 * j + 2]!;
        assert.ok(Math.abs(dot - (i === j ? 1 : 0)) < 1e-12, `a rigid placement: ${Array.from(t.transform)}`);
      }
    }
    assert.ok(det(t.transform) > 0, 'no mirror left');
  }
  before.forEach((b, k) => {
    const a = after[k]!;
    assert.equal(a.path, b.path);
    assert.ok(a.pts.every((p, i) => near(p, b.pts[i]!, 1e-5)), `${b.path}: mesh points`);
    assert.ok(a.brep.every((p, i) => near(p, b.brep[i]!, 1e-9)), `${b.path}: B-rep vertices`);
    assert.equal(a.brep.length, b.brep.length);
    // Normals: the world's by the inverse transpose, the same before and after.
    assert.ok(a.normals.every((n, i) => near(n, b.normals[i]!, 1e-6)), `${b.path}: normals`);
    // Triangles: turned over exactly where a mirror placed them, so the copy's face out as the original's did.
    const sign = b.det < 0 ? -1 : 1;
    assert.ok(a.winding.every((n, i) => near(n, b.winding[i]!.map((x) => x * sign), 1e-6)), `${b.path}: winding`);
    if (b.part.measures && a.part.measures) {
      const s2 = Math.abs(det(b.transform)) ** (2 / 3);
      assert.ok(Math.abs(a.part.measures.faces.get(21)!.area - s2) < 1e-9, `${b.path}: area`);
    }
  });
});

test('copies: one per part and distinct stretch, components copied per stretch, each saying what it copies', () => {
  const s = scene();
  rigidPlacements(s);
  // The component 'sub' reached plainly (turned only) and mirrored at half size: one copy; parts 'a' and 'b' copied
  // for each distinct stretch reaching them.
  // 'top' scaled by 3 in place; in it 'sub' turned (scaled by 3, in place) and mirrored at half size (a copy).
  assert.deepEqual(s.components.map((c) => c.name), ['top', 'sub', 'sub']);
  const copies = s.parts.slice(2);
  assert.ok(copies.length > 0 && copies.every((p) => p.stretched?.of === (p.name === 'a' ? 0 : 1)));
  const stretches = new Set(copies.map((p) => `${p.name}:${Array.from(p.stretched!.stretch).map((x) =>
    x.toFixed(9))}`));
  assert.equal(stretches.size, copies.length, 'no two copies for one stretch');
  // The same scene twice: the same result (deterministic).
  const t = scene();
  rigidPlacements(t);
  assert.deepEqual(t.parts.map((p) => p.stretched && Array.from(p.stretched.stretch)), s.parts.map((p) =>
    p.stretched && Array.from(p.stretched.stretch)));
  assert.match(s.diagnostics.map((d) => d.message).join(), /placements mirrored, scaled or sheared: their stretches /);
});

test('a shear on a B-rep part: an error, its exact geometry left out; on a mesh, baked exactly', () => {
  const s = scene();
  const shear = M([1, 0, 0, 0.5, 1, 0, 0, 0, 1], [0, 0, 0]);
  s.rootParts = [{ part: 1, transform: shear }, { part: 0, transform: shear }];
  s.roots = [];
  const before = world(s);
  rigidPlacements(s);
  const after = world(s);
  const b = s.parts[s.rootParts[0]!.part]!;
  assert.equal(b.brep, undefined);
  assert.ok(s.diagnostics.some((d) => d.severity === 'error' && /sheared or scaled unevenly/.test(d.message)));
  assert.ok(after[1]!.pts.every((p, i) => near(p, before[1]!.pts[i]!, 1e-5)), 'the mesh where it was');
  assert.ok(after[1]!.normals.every((n, i) => near(n, before[1]!.normals[i]!, 1e-6)), 'normals');
});

test('placements rigid to the data\'s precision are left as they are; no copies', () => {
  const s = scene();
  const nearly = M(rot(0.4).map((x, i) => x + (i === 0 ? 3e-7 : 0)), [5, 5, 5]);
  s.roots = [{ component: 1, transform: nearly, sources: [], properties: {} }];
  s.rootParts = [];
  s.components[0]!.parts = [];
  s.components[0]!.children = [];
  s.components[1]!.parts = [{ part: 0, transform: nearly }];
  rigidPlacements(s);
  assert.deepEqual(Array.from(s.roots[0]!.transform), Array.from(nearly));
  assert.equal(s.parts.length, 2);
  assert.deepEqual(s.diagnostics, []);
});

test('the polar decomposition: a rotation times a stretch, the mirror in the stretch', () => {
  const r = rot(0.7), k = [2, 0.3, 0, 0.3, 1, 0, 0, 0, -1.5];
  const a = Array.from({ length: 9 }, (_, i) => {
    const row = i % 3, col = (i - row) / 3;
    return r[row]! * k[3 * col]! + r[3 + row]! * k[3 * col + 1]! + r[6 + row]! * k[3 * col + 2]!;
  });
  const split = rigidPart(a)!;
  assert.ok(near(split.rotation, r, 1e-12), `${split.rotation}`);
  assert.ok(near(split.stretch, k, 1e-12), `${split.stretch}`);
  assert.equal(rigidPart([1, 0, 0, 0, 0, 0, 0, 0, 1]), undefined);
});

test('a component containing itself (a cycle) ends the walk', () => {
  const s = scene();
  s.components[1]!.children = [{ component: 1, transform: M(MIRROR_X), sources: [], properties: {} }];
  rigidPlacements(s);
  // 'sub' and its mirrored copy (whose child, mirrored again, is 'sub' itself), and 'top' scaled.
  assert.ok(s.components.length < 20, `${s.components.length}`);
  assert.ok([...partInstances(s)].length > 0);
});

test('a part placed at one stretch only: stretched in place, said so (no copy); an even scale only a conversion',
  () => {
  for (const [what, l, said] of [['mirror', MIRROR_X, true], ['even scale', scaled(rot(0.1), 3), false]] as const) {
    const s = scene();
    s.components = [];
    s.roots = [];
    s.rootParts = [{ part: 0, transform: M(l, [1, 2, 3]) }, { part: 0, transform: M(l, [7, 8, 9]) }];
    const before = world(s);
    rigidPlacements(s);
    assert.equal(s.parts.length, 2, what);
    assert.equal(s.rootParts.every((r) => r.part === 0), true, what);
    assert.equal(s.parts[0]!.stretched !== undefined, said, what);
    assert.equal(s.parts[0]!.stretched?.of, undefined, what);
    const after = world(s);
    assert.ok(after.every((a, k) => a.pts.every((p, i) => near(p, before[k]!.pts[i]!, 1e-5))), what);
    assert.deepEqual(s.diagnostics, [], `${what}: no copies, nothing said`);
  }
});

test('stretched parts in words: by kind, a part counted under each that applies', () => {
  const s = scene();
  rigidPlacements(s);
  // Copies: mirrored at half the root's scale (scaled too), scaled by the root, mirrored; the words per kind.
  const said = describeStretched(s);
  assert.match(said, /^\d+ mirrored, \d+ scaled$/);
  assert.deepEqual(stretchWords(M(scaled(MIRROR_X, 2))), ['mirrored', 'scaled']);
  // (A shear keeping its axes' lengths: y tilted towards x.)
  assert.deepEqual(stretchWords(M([1, 0, 0, 0.6, 0.8, 0, 0, 0, 1])), ['sheared']);
  assert.deepEqual(stretchWords(M([1, 0, 0, 0, 3, 0, 0, 0, 1])), ['scaled unevenly']);
  assert.equal(describeStretched({ ...s, parts: [] }), '');
});

test('a stretch handed down composes before the child\'s turn; part origins stretched; components no root reaches '
  + 'made rigid; close stretches kept apart', () => {
  const s = scene();
  // A root mirrored and scaled unevenly over a child turned 30 degrees (they don't commute), and close scales.
  s.components = [
    { name: 'outer', sources: [], properties: {}, parts: [], children: [{ component: 1,
      transform: M(rot(Math.PI / 6), [2, 3, 4]), sources: [], properties: {} }] },
    { name: 'inner', sources: [], properties: {}, parts: [{ part: 0, transform: M(rot(-0.25), [1, 0, 0]) },
      { part: 0, transform: M(scaled(I_3, 1.21)) }, { part: 0, transform: M(scaled(I_3, 1.24), [9, 0, 0]) }],
      children: [] },
    { name: 'loose', sources: [], properties: {}, parts: [{ part: 1, transform: M(MIRROR_X) }], children: [] },
  ];
  s.roots = [{ component: 0, transform: M([-2, 0, 0, 0, 1, 0, 0, 0, 0.5], [5, 5, 5]), sources: [], properties: {} }];
  s.rootParts = [];
  const before = world(s), origins = before.map((b) => apply(b.transform, b.part.origin));
  rigidPlacements(s);
  const after = world(s);
  after.forEach((a, k) => {
    assert.ok(a.pts.every((p, i) => near(p, before[k]!.pts[i]!, 1e-5)), `${a.path}: mesh points`);
    assert.ok(near(apply(a.transform, a.part.origin), origins[k]!, 1e-9), `${a.path}: the part's origin`);
  });
  // The component no root reaches: rigid too.
  const loose = s.components.find((c) => c.name === 'loose')!;
  assert.ok(det(loose.parts[0]!.transform) > 0);
});
