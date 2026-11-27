import assert from 'node:assert/strict';
import test from 'node:test';
import { analysisFor, BrepBuilder, type BrepData, PROVENANCE, validateBrep } from 'cad-brep';
import { Geometry, init } from 'cad-geom';
import { healPart } from '../src/index.ts';
import { trimOvershoots } from '../src/fix/overshoot.ts';

const module = await init();

interface Opts {
  pcurve?: 'none' | 'edge' | 'own' | 'snapped';
  extra?: 'none' | 'tight' | 'loose' | 'used';
  tolV?: number;
  lift?: number;
  shift?: number;
  tolE?: number;
  b?: 'line' | 'lens' | 'throughEnd';
}

/**
 * One face (id 1) on the plane z = 0, its loop A, B, C: A (id 11) along the x axis from (10, 0) toward V, on past
 * the origin to (-o, 0); B (id 12) from (0, -o) up the y axis to (0, 10), `lift` above the plane; C (id 13) from
 * there back to (10, 0). A and B cross at the origin and each runs o past it; V (id 21) is at (-o / 2, -o / 2), its
 * tolerance `tolV` (o by default, so both curves' ends are within it). A's and B's tolerance `tolE` (1e-3: their
 * p-curves' ends at their parameters then miss V, and the face API takes their own), the others' 1e-3, uncertainty
 * 1e-6.
 * `pcurve`: the uses' p-curves ((u, v) is (x, y)), none with a range: 'edge' lines at their edge's parameter, B's
 * from `shift` along u to (0, 10); 'own'
 * B-spline segments over [0, 1] (their own parameter); 'snapped' segments at their edge's
 * parameter that end at V's point, so the loop doesn't cross itself in (u, v). `extra`: an edge D (id 14) out of V
 * starting at (-3 o, -3 o), toward W = (-5, -5): 'tight', its tolerance 0.3 o, used by no face; 'loose', 5 o; 'used',
 * 5 o and used by face 2 (id 2) with G1 (id 15) from W to U = (-5, -3 o) and G2 (id 16) from U back along y = -3 o to
 * (-3 o, -3 o) at V, tolerance 5 o, D's use's p-curve a segment over [0, 1] from (-4 o, -4 o) to W. `b`: 'lens', B
 * a parabola from A's end (-o, 0) crossing A at the origin, so the two end together; 'throughEnd', B the line x = -o
 * from (-o, -o) to Q = (-o, 10), through A's end.
 */
function overshoot(o: number,
  { pcurve = 'none', extra = 'none', tolV = o, lift = 0, shift = 0, tolE = 1e-3, b: bKind = 'line' }: Opts = {}):
  BrepData {
  const b = new BrepBuilder({ uncertainty: 1e-6 });
  const plane = b.addSurface({ kind: 'plane', position: { origin: [0, 0, 0], axis: [0, 0, 1], xDir: [1, 0, 0] } });
  const V = b.addVertex({ point: [-o / 2, -o / 2, 0], tolerance: tolV, id: 21 });
  const qx = bKind === 'throughEnd' ? -o : 0;
  const P0 = b.addVertex({ point: [10, 0, 0] }), Q = b.addVertex({ point: [qx, 10, 0] });
  const line = (p: number[], d: number[]) => ({ kind: 'line' as const, point: p, direction: d, magnitude: 1 });
  const seg = (p: number[], q: number[], t = 1) => b.addCurve({ kind: 'bspline', degree: 1, knots: [0, t],
    multiplicities: [2, 2], poles: [p, q], closed: false, selfIntersect: false, form: 'unspecified' });
  const A = b.addEdge({ curve: b.addCurve(line([10, 0, 0], [-1, 0, 0])), start: P0, end: V, sameSense: true,
    range: [0, 10 + o], tolerance: tolE, id: 11 });
  // (The lens's B: a parabola from A's end through the origin at its parameter 0.1, to (0, 10).)
  const B = bKind === 'lens' ? b.addEdge({ curve: b.addCurve({ kind: 'bspline', degree: 2, knots: [0, 1],
    multiplicities: [3, 3], poles: [[-o, 0, 0], [4.5 * o, -1 / 1.8, 0], [0, 10, 0]], closed: false,
    selfIntersect: false, form: 'unspecified' }), start: V, end: Q, sameSense: true, range: [0, 1], tolerance: tolE,
    id: 12 })
    : b.addEdge({ curve: b.addCurve(line([qx, -o, lift], [0, 1, 0])), start: V, end: Q, sameSense: true,
      range: [0, 10 + o], tolerance: tolE, id: 12 });
  const lc = Math.hypot(10 - qx, 10);
  const C = b.addEdge({ curve: b.addCurve(line([qx, 10, 0], [(10 - qx) / lc, -10 / lc, 0])), start: Q, end: P0,
    sameSense: true, range: [0, lc], tolerance: 1e-3, id: 13 });
  const use = (edge: number, pc: number) => ({ edge, orientation: 'forward' as const, ...(pc >= 0 ? { pcurve: pc }
    : {}) });
  const faces: { face: number; sense: boolean }[] = [];
  if (extra !== 'none') {
    const W = b.addVertex({ point: [-5, -5, 0] }), t = extra === 'tight' ? 0.3 * o : 5 * o;
    const D = b.addEdge({ curve: b.addCurve(line([-3 * o, -3 * o, 0], [-Math.SQRT1_2, -Math.SQRT1_2, 0])), start: V,
      end: W, sameSense: true, range: [0, (5 - 3 * o) * Math.SQRT2], tolerance: t, id: 14 });
    if (extra === 'used') {
      const U = b.addVertex({ point: [-5, -3 * o, 0] });
      const G1 = b.addEdge({ curve: b.addCurve(line([-5, -5, 0], [0, 1, 0])), start: W, end: U, sameSense: true,
        range: [0, 5 - 3 * o], tolerance: 1e-3, id: 15 });
      const G2 = b.addEdge({ curve: b.addCurve(line([-5, -3 * o, 0], [1, 0, 0])), start: U, end: V, sameSense: true,
        range: [0, 5 - 3 * o], tolerance: t, id: 16 });
      faces.push({ face: b.addFace({ surface: plane, sameSense: true, id: 2, loops: [{ kind: 'edge', bound: 'outer',
        coedges: [use(D, seg([-4 * o, -4 * o], [-5, -5])), use(G1, -1), use(G2, -1)] }] }), sense: true });
    }
  }
  const pcA = pcurve === 'edge' ? b.addCurve(line([10, 0], [-1, 0])) : pcurve === 'own' ? seg([10, 0], [-o, 0])
    : pcurve === 'snapped' ? seg([10, 0], [-o / 2, -o / 2], 10 + o) : -1;
  const pcB = pcurve === 'edge' ? b.addCurve(line([shift, -o], [-shift / Math.hypot(shift, 10 + o),
    (10 + o) / Math.hypot(shift, 10 + o)])) : pcurve === 'own' ? seg([0, -o], [0, 10])
    : pcurve === 'snapped' ? seg([-o / 2, -o / 2], [0, 10], 10 + o) : -1;
  faces.unshift({ face: b.addFace({ surface: plane, sameSense: true, id: 1,
    loops: [{ kind: 'edge', bound: 'outer', coedges: [use(A, pcA), use(B, pcB), use(C, -1)] }] }), sense: true });
  b.addItem({ kind: 'body', ref: b.addBody({ kind: 'sheet', members: [{ ref: b.addShell({ kind: 'open', faces }),
    sense: true }] }) });
  return b.finish();
}

const errors = (d: BrepData) => validateBrep(d).filter((x) => x.severity === 'error').map((x) => x.message);
const row = (xs: ArrayLike<number>, id: number) => Array.from(xs).indexOf(id);
const near = (a: number, b: number, eps: number, what: string) => assert.ok(Math.abs(a - b) <= eps, `${what}: ${a}`);

test('trimOvershoot: two bare edges crossing near their vertex trimmed at the crossing, the vertex moved there', () => {
  const d = overshoot(0.2);
  assert.deepEqual(errors(d), []);
  const r = trimOvershoots(module, d)!;
  assert.ok(r, 'found');
  assert.equal(r.trimmed.length, 1);
  assert.equal(r.ungated, 1);
  const t = r.trimmed[0]!;
  assert.deepEqual([t.vertex, t.face, ...t.edges], [21, 1, 11, 12]);
  near(t.moved, 0.1 * Math.SQRT2, 1e-9, 'moved');
  near(t.tails[0], 0.2, 1e-9, 'tail A'), near(t.tails[1], 0.2, 1e-9, 'tail B');
  near(t.tolBefore, 0.2, 0, 'tolerance before');
  // Both curves end at the origin: the tolerance is what's left, under the uncertainty.
  assert.ok(t.tolAfter < 1e-6, `tolerance after ${t.tolAfter}`);
  const m = r.model, v = row(m.vertex.id, 21), a = row(m.edge.id, 11), b = row(m.edge.id, 12);
  for (let k = 0; k < 3; k++) near(m.vertex.point[3 * v + k]!, 0, 1e-9, `vertex ${k}`);
  near(m.vertex.tolerance[v]!, t.tolAfter, 0, 'the vertex row\'s tolerance');
  // A ends at the origin (its parameter 10), B starts there (its parameter 0.2); rows unchanged.
  assert.deepEqual([m.edge.range[2 * a], m.edge.range[2 * b + 1]], [0, 10.2]);
  near(m.edge.range[2 * a + 1]!, 10, 1e-9, 'A\'s end'), near(m.edge.range[2 * b]!, 0.2, 1e-9, 'B\'s start');
  assert.deepEqual(r.edges.sort(), [a, b].sort());
  assert.deepEqual(r.dropped, []);
  for (const tb of ['vertex', 'edge', 'coedge', 'loop', 'face'] as const) {
    assert.equal(m[tb].id.length, d[tb].id.length, tb);
  }
  assert.deepEqual(errors(m), []);
  // The given model untouched.
  near(d.vertex.point[3 * v]!, -0.1, 0, 'given vertex');
  assert.equal(d.edge.range[2 * a + 1], 10.2);
});

test('trimOvershoot: uses\' p-curves trimmed with their edges, at the edge\'s parameter (their tolerance reaching '
  + 'the vertex) and at their own', () => {
  for (const kind of ['edge', 'own'] as const) {
    const d = overshoot(0.2, { pcurve: kind, ...(kind === 'edge' ? { tolE: 0.2 } : {}) });
    const r = trimOvershoots(module, d)!;
    assert.equal(r?.trimmed.length, 1, kind);
    assert.deepEqual(r.dropped, [], kind);
    const m = r.model, g = new Geometry(module, new Uint8Array(m.buffer));
    try {
      const a = row(m.edge.id, 11), b = row(m.edge.id, 12);
      const ca = row(m.coedge.edge, a), cb = row(m.coedge.edge, b);
      const want = kind === 'edge' ? [[0, 10], [0.2, 10.2]] : [[0, 10 / 10.2], [0.2 / 10.2, 1]];
      for (const [c, w] of [[ca, want[0]!], [cb, want[1]!]] as const) {
        near(m.coedge.range[2 * c]!, w[0]!, 1e-9, `${kind} ${c} start`);
        near(m.coedge.range[2 * c + 1]!, w[1]!, 1e-9, `${kind} ${c} end`);
      }
      // The face API's (u, v) at the uses' ends at the vertex: the origin.
      const pa = g.evalCoedge(ca, [m.coedge.range[2 * ca + 1]!], 0);
      const pb = g.evalCoedge(cb, [m.coedge.range[2 * cb]!], 0);
      for (const p of [pa, pb]) {
        assert.equal(p.status, 'ok');
        near(Math.hypot(p.values[0]!, p.values[1]!), 0, 1e-7, `${kind} (u, v) at the vertex`);
      }
    } finally {
      g.dispose();
    }
    assert.deepEqual(errors(m), [], kind);
  }
});

test('trimOvershoot: a loop not in trouble (p-curves meeting at the vertex in (u, v)) left, counted ungated', () => {
  const r = trimOvershoots(module, overshoot(0.2, { pcurve: 'snapped' }))!;
  assert.ok(r, 'a candidate');
  assert.equal(r.trimmed.length, 0);
  assert.equal(r.ungated, 1);
});

test('trimOvershoot: one edge through the other\'s end (a T) trimmed alone, to that end', () => {
  const r = trimOvershoots(module, overshoot(0.2, { b: 'throughEnd' }))!;
  assert.equal(r?.trimmed.length, 1);
  const t = r.trimmed[0]!, m = r.model, v = row(m.vertex.id, 21), a = row(m.edge.id, 11), b = row(m.edge.id, 12);
  assert.ok(t.tails[0] < 1e-9, `A's tail ${t.tails[0]}`);
  near(t.tails[1], 0.2, 1e-9, 'B\'s tail');
  near(m.vertex.point[3 * v]!, -0.2, 1e-9, 'x'), near(m.vertex.point[3 * v + 1]!, 0, 1e-9, 'y');
  near(m.edge.range[2 * a + 1]!, 10.2, 1e-9, 'A\'s end');
  near(m.edge.range[2 * b]!, 0.2, 1e-9, 'B\'s start');
});

test('trimOvershoot: none where the tails are within the uncertainty, the curves end together, the crossing is '
  + 'past the vertex\'s tolerance, or another edge at the vertex ends past its own of it', () => {
  assert.equal(trimOvershoots(module, overshoot(5e-7)), undefined, 'tails within');
  // Each tail 8e-7, under the uncertainty, their ends 1.13e-6 apart, past it.
  assert.equal(trimOvershoots(module, overshoot(8e-7)), undefined, 'tails within, ends apart');
  // A lens: the curves end together at A's end, having crossed at the origin.
  assert.equal(trimOvershoots(module, overshoot(0.2, { b: 'lens' })), undefined, 'a lens');

  // The crossing 0.141 from V, its tolerance 0.15 (each end 0.141 from it): a control, then 0.13.
  assert.equal(trimOvershoots(module, overshoot(0.2, { tolV: 0.15 }))?.trimmed.length, 1, 'control');
  assert.equal(trimOvershoots(module, overshoot(0.2, { tolV: 0.13 })), undefined, 'past V\'s tolerance');
  // D starts 0.85 from the crossing, its tolerance 0.06.
  assert.equal(trimOvershoots(module, overshoot(0.2, { extra: 'tight' })), undefined, 'another edge');
  // B 0.01 above A where they'd cross.
  assert.equal(trimOvershoots(module, overshoot(0.2, { lift: 0.01 })), undefined, 'apart');
});

test('trimOvershoot: the vertex\'s tolerance over every end there: another edge\'s, its use\'s, a trimmed use\'s',
  () => {
    // D starts 3 o sqrt 2 from the crossing, within its tolerance 5 o.
    const o = 0.2, loose = trimOvershoots(module, overshoot(o, { extra: 'loose' }))!;
    assert.equal(loose?.trimmed.length, 1);
    near(loose.trimmed[0]!.tolAfter, 1.1 * 3 * o * Math.SQRT2, 1e-9, 'D\'s end');
    // D's use's p-curve starts at (-4 o, -4 o).
    const used = trimOvershoots(module, overshoot(o, { extra: 'used' }))!;
    assert.equal(used?.trimmed.length, 1);
    near(used.trimmed[0]!.tolAfter, 1.1 * 4 * o * Math.SQRT2, 1e-9, 'D\'s use\'s end');
    // B's p-curve from 5e-4 along u to (0, 10), at its edge's parameter (its tolerance reaching V): trimmed at B's
    // new start, o along it.
    const s = 5e-4, shifted = trimOvershoots(module, overshoot(o, { pcurve: 'edge', shift: s, tolE: o }))!;
    assert.equal(shifted?.trimmed.length, 1);
    assert.deepEqual(shifted.dropped, []);
    const L = Math.hypot(s, 10 + o), end = [s - s * o / L, -o + (10 + o) * o / L];
    near(shifted.trimmed[0]!.tolAfter, 1.1 * Math.hypot(end[0]!, end[1]!), 1e-12, 'B\'s use\'s end');
  });

test('healPart\'s trimOvershoot: said, off by its switch, the source model kept and healing again from it',
  async () => {
    const d = overshoot(0.2);
    const r = await healPart(d, {}, module);
    const said = r.diagnostics.filter((x) => x.message.startsWith('trimOvershoot'));
    assert.equal(said.length, 1);
    assert.match(said[0]!.message, /^trimOvershoot: 1 pair of consecutive edges crossing near their vertex trimmed/);
    assert.match(said[0]!.message, /face #1's #11 and #12 at #21 \(moved 0\.141 mm/);
    assert.ok(r.changed);
    const v = row(r.model.vertex.id, 21);
    near(r.model.vertex.point[3 * v]!, 0, 1e-9, 'moved');
    const a = await analysisFor(r.model, r.analysis!);
    assert.deepEqual(new Uint8Array(a.source.model), new Uint8Array(d.buffer), 'the source model kept');
    // The trimmed edges' ranges healing's; C's as given.
    const rangeFrom = (id: number) => a.edge.rangeFrom[row(r.model.edge.id, id)];
    assert.deepEqual([rangeFrom(11), rangeFrom(12), rangeFrom(13)], [PROVENANCE.healed, PROVENANCE.healed,
      PROVENANCE.given]);
    const off = await healPart(d, { fixes: { trimOvershoot: false } }, module);
    assert.equal(off.diagnostics.filter((x) => x.message.startsWith('trimOvershoot')).length, 0);
    near(off.model.vertex.point[3 * v]!, -0.1, 0, 'not moved');
    // Healing the healed model again: as it is with the same options; from the source with the fix off.
    const again = await healPart(r.model, {}, module, undefined, r.analysis);
    assert.equal(again.changed, false);
    const back = await healPart(r.model, { fixes: { trimOvershoot: false } }, module, undefined, r.analysis);
    near(back.model.vertex.point[3 * v]!, -0.1, 0, 'the source\'s vertex back');
    assert.equal(back.model.edge.range[2 * row(back.model.edge.id, 11) + 1], 10.2);
  });
