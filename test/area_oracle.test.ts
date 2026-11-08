// The area oracle (corpus_checks/area_oracle.ts) on faces built here with areas known in closed form, oriented as
// Part 42 orients face bounds (the face on the left walking a loop, the face's normal up).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openModel, parseStep, Reader, type StepFile } from '../packages/step-parser/src/index.ts';
import { stepBrep } from '../packages/step-import/src/brep.ts';
import { AreaOracle, modelFaceArea, planeAngleUnit, trusted, type OracleResult } from '../corpus_checks/area_oracle.ts';

/** A Part 21 file built one instance at a time; each method returns the new instance's id. */
class Builder {
  lines: string[] = [];
  next = 1;
  add(text: string): number { const id = this.next++; this.lines.push(`#${id}=${text};`); return id; }
  r(x: number) { return Number.isInteger(x) ? `${x}.` : String(x); }
  pt(x: number, y: number, z: number) { return this.add(`CARTESIAN_POINT('',(${this.r(x)},${this.r(y)},${this.r(z)}))`); }
  dir(x: number, y: number, z: number) { return this.add(`DIRECTION('',(${this.r(x)},${this.r(y)},${this.r(z)}))`); }
  ax(o: [number, number, number], z?: [number, number, number], x?: [number, number, number]) {
    const p = this.pt(...o), zz = z ? `#${this.dir(...z)}` : '$', xx = x ? `#${this.dir(...x)}` : '$';
    return this.add(`AXIS2_PLACEMENT_3D('',#${p},${zz},${xx})`);
  }
  vtx(x: number, y: number, z: number) { return this.add(`VERTEX_POINT('',#${this.pt(x, y, z)})`); }
  line(a: [number, number, number], b: [number, number, number]) {
    const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], l = Math.hypot(...d);
    return this.add(`LINE('',#${this.pt(...a)},#${this.add(`VECTOR('',#${this.dir(d[0]! / l, d[1]! / l, d[2]! / l)},1.)`)})`);
  }
  circle(ax: number, r: number) { return this.add(`CIRCLE('',#${ax},${this.r(r)})`); }
  ellipse(ax: number, a: number, b: number) { return this.add(`ELLIPSE('',#${ax},${this.r(a)},${this.r(b)})`); }
  edge(v1: number, v2: number, curve: number, sense = true) {
    return this.add(`EDGE_CURVE('',#${v1},#${v2},#${curve},${sense ? '.T.' : '.F.'})`);
  }
  oe(edge: number, forward = true) { return this.add(`ORIENTED_EDGE('',*,*,#${edge},${forward ? '.T.' : '.F.'})`); }
  bound(oes: number[], forward = true, outer = false) {
    const loop = this.add(`EDGE_LOOP('',(${oes.map((x) => `#${x}`).join(',')}))`);
    return this.add(`${outer ? 'FACE_OUTER_BOUND' : 'FACE_BOUND'}('',#${loop},${forward ? '.T.' : '.F.'})`);
  }
  face(bounds: number[], surface: number, same = true, type = 'ADVANCED_FACE') {
    return this.add(`${type}('',(${bounds.map((x) => `#${x}`).join(',')}),#${surface},${same ? '.T.' : '.F.'})`);
  }
  /** A closed polygon of line edges through the points, in order. */
  polygon(ps: [number, number, number][]) {
    const vs = ps.map((p) => this.vtx(...p));
    return this.bound(ps.map((p, i) => this.oe(this.edge(vs[i]!, vs[(i + 1) % ps.length]!,
      this.line(p, ps[(i + 1) % ps.length]!)))));
  }
  /** A closed circle edge (one vertex) on an axis placement, as an oriented edge. */
  closedCircle(ax: number, r: number, at: [number, number, number], forward = true) {
    const v = this.vtx(...at);
    return this.oe(this.edge(v, v, this.circle(ax, r)), forward);
  }
  text(header = '') {
    return new TextEncoder().encode(`ISO-10303-21;HEADER;FILE_SCHEMA(('AUTOMOTIVE_DESIGN'));ENDSEC;DATA;\n${header}`
      + `${this.lines.join('\n')}\nENDSEC;END-ISO-10303-21;\n`);
  }
}

/**
 * The file's oracle on a face, after checking the model's (the face converted by step-import's stepBrep) agrees with
 * it wherever the file's computes one: the same area, error bound, perimeter, surface, flags and curves.
 */
async function areaOf(file: StepFile, face: number): Promise<OracleResult> {
  const r = new AreaOracle(file).faceArea(face);
  const model = await openModel(file);
  const q = model.resolve(face);
  if (q < 0) return r;
  const { brep } = stepBrep(new Reader(model), [q], { unit: 1, angle: planeAngleUnit(file) }, () => {});
  const m = modelFaceArea(brep, 0);
  // What the file's oracle can't compute the model's can't either (the same rules, on the same geometry).
  if (!r.ok) assert.ok(!m.ok, `the model's oracle computed what the file's didn't (${r.reason})`);
  else assert.equal(trusted(m), trusted(r), `trusted: model ${trusted(m)}, file ${trusted(r)}`);
  if (r.ok) {
    assert.ok(m.ok, `the model's oracle: ${!m.ok && m.reason}`);
    const tol = 1e-9 * Math.max(1, r.area);
    assert.ok(Math.abs(m.area - r.area) <= tol + r.error + m.error, `model ${m.area}, file ${r.area}`);
    assert.ok(Math.abs(m.perimeter - r.perimeter) <= 1e-9 * Math.max(1, r.perimeter), `perimeter ${m.perimeter}`);
    assert.deepEqual([m.surface, m.flags, m.curves], [r.surface, r.flags, r.curves]);
  }
  return r;
}
const area = (b: Builder, face: number): Promise<OracleResult> => areaOf(parseStep(b.text()), face);
function close(r: OracleResult, expected: number, tol = 1e-9) {
  assert.ok(r.ok, `unsupported: ${!r.ok && r.reason}`);
  assert.ok(Math.abs(r.area - expected) <= tol * Math.max(1, expected), `area ${r.area}, expected ${expected}`);
  assert.deepEqual(r.flags, []);
  assert.ok(trusted(r), `untrusted: error ${r.error}`);
}

test('a planar rectangle: area and perimeter', async () => {
  const b = new Builder();
  const f = b.face([b.polygon([[0, 0, 0], [2, 0, 0], [2, 3, 0], [0, 3, 0]])], b.add(`PLANE('',#${b.ax([0, 0, 0])})`));
  const r = await area(b, f);
  close(r, 6);
  assert.ok(r.ok && Math.abs(r.perimeter - 10) < 1e-9);
});

test('a plane with a circular hole, in either sense of the hole\'s edge and bound', async () => {
  for (const [edgeForward, boundForward] of [[false, true], [true, false]] as const) {
    const b = new Builder();
    const outer = b.polygon([[-5, -5, 0], [5, -5, 0], [5, 5, 0], [-5, 5, 0]]);
    // The hole runs clockwise seen from +z: the circle (counterclockwise) reversed by its edge or by its bound.
    const hole = b.bound([b.closedCircle(b.ax([0, 0, 0]), 2, [2, 0, 0], edgeForward)], boundForward);
    const f = b.face([outer, hole], b.add(`PLANE('',#${b.ax([0, 0, 0])})`));
    const r = await area(b, f);
    close(r, 100 - 4 * Math.PI);
    assert.ok(r.ok && Math.abs(r.perimeter - (40 + 4 * Math.PI)) < 1e-9, `perimeter ${r.ok && r.perimeter}`);
    assert.ok(r.ok && r.error > 0, 'a curved boundary has a nonzero error estimate');
  }
});

test('a face against its plane\'s normal (same_sense false) with its loops reversed accordingly', async () => {
  const b = new Builder();
  const f = b.face([b.polygon([[0, 0, 0], [0, 3, 0], [2, 3, 0], [2, 0, 0]])], b.add(`PLANE('',#${b.ax([0, 0, 0])})`), false);
  close(await area(b, f), 6);
});

test('loops against Part 42 are flagged, with the area\'s magnitude', async () => {
  const b = new Builder();
  const f = b.face([b.polygon([[0, 0, 0], [0, 3, 0], [2, 3, 0], [2, 0, 0]])], b.add(`PLANE('',#${b.ax([0, 0, 0])})`));
  const r = await area(b, f);
  assert.ok(r.ok);
  assert.deepEqual(r.flags, ['orientation']);
  assert.ok(Math.abs(r.area - 6) < 1e-9);
  assert.equal(trusted(r), false);
});

test('small quarter discs far from their plane\'s origin (no cancellation)', async () => {
  for (const [far, r] of [[1000, 1], [1e5, 0.01], [1e7, 0.01]] as const) {
    const b = new Builder();
    const c: [number, number, number] = [far, far, 0];
    const v0 = b.vtx(...c), v1 = b.vtx(far + r, far, 0), v2 = b.vtx(far, far + r, 0);
    const arc = b.edge(v1, v2, b.circle(b.ax(c), r));
    const f = b.face([b.bound([b.oe(b.edge(v0, v1, b.line(c, [far + r, far, 0]))), b.oe(arc),
      b.oe(b.edge(v2, v0, b.line([far, far + r, 0], c)))])], b.add(`PLANE('',#${b.ax([0, 0, 0])})`));
    close(await area(b, f), (Math.PI / 4) * r * r, 1e-6);
  }
});

test('a thin circular segment under a short arc, far from the plane\'s origin: trusted', async () => {
  // R 40, angle 0.1 about the top of a circle centred 1000 out along v: R^2 (theta - sin theta) / 2.
  const b = new Builder();
  const R = 40, th = 0.1, cy = 1000;
  const p = (t: number): [number, number, number] => [R * Math.cos(t), cy + R * Math.sin(t), 0];
  const t0 = Math.PI / 2 - th / 2, t1 = Math.PI / 2 + th / 2;
  const v0 = b.vtx(...p(t0)), v1 = b.vtx(...p(t1));
  const f = b.face([b.bound([b.oe(b.edge(v0, v1, b.circle(b.ax([0, cy, 0]), R))),
    b.oe(b.edge(v1, v0, b.line(p(t1), p(t0))))])], b.add(`PLANE('',#${b.ax([0, 0, 0])})`));
  close(await area(b, f), (R * R * (th - Math.sin(th))) / 2, 1e-7);
});

test('a quarter disc whose arc is a rational B-spline, and a full ellipse', async () => {
  const b = new Builder();
  const v0 = b.vtx(0, 0, 0), v1 = b.vtx(3, 0, 0), v2 = b.vtx(0, 3, 0);
  const cps = [b.pt(3, 0, 0), b.pt(3, 3, 0), b.pt(0, 3, 0)];
  const spline = b.add(`(BOUNDED_CURVE()B_SPLINE_CURVE(2,(${cps.map((x) => `#${x}`).join(',')}),.CIRCULAR_ARC.,.F.,.F.)`
    + `B_SPLINE_CURVE_WITH_KNOTS((3,3),(0.,1.),.UNSPECIFIED.)CURVE()GEOMETRIC_REPRESENTATION_ITEM()`
    + `RATIONAL_B_SPLINE_CURVE((1.,${Math.SQRT1_2},1.))REPRESENTATION_ITEM(''))`);
  const f = b.face([b.bound([b.oe(b.edge(v0, v1, b.line([0, 0, 0], [3, 0, 0]))), b.oe(b.edge(v1, v2, spline)),
    b.oe(b.edge(v2, v0, b.line([0, 3, 0], [0, 0, 0])))])], b.add(`PLANE('',#${b.ax([0, 0, 0])})`));
  const r = await area(b, f);
  close(r, (9 * Math.PI) / 4, 1e-8);
  assert.ok(r.ok && r.curves.includes('rational-bspline'));
  const g = b.face([b.bound([b.oe(b.edge(b.vtx(3, 0, 5), b.vtx(3, 0, 5), b.ellipse(b.ax([0, 0, 5]), 3, 2)))])],
    b.add(`PLANE('',#${b.ax([0, 0, 5])})`));
  close(await area(b, g), 6 * Math.PI, 1e-8);
});

test('a cylinder band bounded by two circles (loops winding the axis)', async () => {
  const b = new Builder();
  // Outward normal: the bottom circle runs with u, the top against it.
  const bottom = b.bound([b.closedCircle(b.ax([0, 0, 0]), 2, [2, 0, 0], true)]);
  const top = b.bound([b.closedCircle(b.ax([0, 0, 5]), 2, [2, 0, 5], false)]);
  close(await area(b, b.face([bottom, top], b.add(`CYLINDRICAL_SURFACE('',#${b.ax([0, 0, 0])},2.)`))), 20 * Math.PI);
});

test('a half cylinder bounded by two rulings and two half circles', async () => {
  const b = new Builder();
  const p = (x: number, z: number): [number, number, number] => [x, 0, z];
  const [a0, a1, b0, b1] = [b.vtx(...p(2, 0)), b.vtx(...p(-2, 0)), b.vtx(...p(2, 3)), b.vtx(...p(-2, 3))];
  const f = b.face([b.bound([
    b.oe(b.edge(a0, a1, b.circle(b.ax([0, 0, 0]), 2))), // u 0 -> pi at z 0
    b.oe(b.edge(a1, b1, b.line(p(-2, 0), p(-2, 3)))),
    b.oe(b.edge(b0, b1, b.circle(b.ax([0, 0, 3]), 2)), false), // u pi -> 0 at z 3
    b.oe(b.edge(b0, a0, b.line(p(2, 3), p(2, 0)))),
  ])], b.add(`CYLINDRICAL_SURFACE('',#${b.ax([0, 0, 0])},2.)`));
  close(await area(b, f), Math.PI * 2 * 3);
});

test('a cone frustum, with its semi-angle in degrees from the geometric context', async () => {
  const b = new Builder();
  // Radius 1 at z 0 to 2 at z 1 (45 degrees): pi (r1 + r2) times the slant height.
  const bottom = b.bound([b.closedCircle(b.ax([0, 0, 0]), 1, [1, 0, 0], true)]);
  const top = b.bound([b.closedCircle(b.ax([0, 0, 1]), 2, [2, 0, 1], false)]);
  const f = b.face([bottom, top], b.add(`CONICAL_SURFACE('',#${b.ax([0, 0, 0])},1.,45.)`));
  const deg = b.add(`PLANE_ANGLE_MEASURE_WITH_UNIT(PLANE_ANGLE_MEASURE(0.0174532925199433),#${b.add('(NAMED_UNIT(*)PLANE_ANGLE_UNIT()SI_UNIT($,.RADIAN.))')})`);
  const unit = b.add(`(CONVERSION_BASED_UNIT('DEGREE',#${deg})NAMED_UNIT(*)PLANE_ANGLE_UNIT())`);
  b.add(`(GEOMETRIC_REPRESENTATION_CONTEXT(3)GLOBAL_UNIT_ASSIGNED_CONTEXT((#${unit}))REPRESENTATION_CONTEXT('',''))`);
  const file = parseStep(b.text());
  assert.ok(Math.abs(planeAngleUnit(file) - Math.PI / 180) < 1e-15);
  close(await areaOf(file, f), 3 * Math.PI * Math.SQRT2, 1e-8);
});

test('the angle unit is the geometric context\'s, not a degree unit elsewhere in the file', async () => {
  const b = new Builder();
  const rad = b.add('(NAMED_UNIT(*)PLANE_ANGLE_UNIT()SI_UNIT($,.RADIAN.))');
  b.add(`(CONVERSION_BASED_UNIT('DEGREE',#${b.add(`PLANE_ANGLE_MEASURE_WITH_UNIT(PLANE_ANGLE_MEASURE(0.0174532925199433),#${rad})`)})NAMED_UNIT(*)PLANE_ANGLE_UNIT())`);
  const deg = b.next - 1;
  b.add(`(GLOBAL_UNIT_ASSIGNED_CONTEXT((#${deg}))REPRESENTATION_CONTEXT('',''))`);
  b.add(`(GEOMETRIC_REPRESENTATION_CONTEXT(3)GLOBAL_UNIT_ASSIGNED_CONTEXT((#${rad}))REPRESENTATION_CONTEXT('',''))`);
  assert.equal(planeAngleUnit(parseStep(b.text())), 1);
});

test('a cone through its apex: a seam ruling twice and a circle', async () => {
  const b = new Builder();
  // Apex at the origin (radius 0), semi-angle 0.5 rad, up to z 2: pi rho s.
  const a = 0.5, h = 2, rho = h * Math.tan(a);
  const apex = b.vtx(0, 0, 0), p = b.vtx(rho, 0, h);
  const ruling = b.edge(apex, p, b.line([0, 0, 0], [rho, 0, h]));
  const f = b.face([b.bound([b.oe(ruling), b.oe(b.edge(p, p, b.circle(b.ax([0, 0, h]), rho)), false), b.oe(ruling, false)])],
    b.add(`CONICAL_SURFACE('',#${b.ax([0, 0, 0])},0.,${a})`));
  close(await area(b, f), Math.PI * rho * (h / Math.cos(a)), 1e-8);
});

test('a cone bounded by a circle and a vertex loop at its apex', async () => {
  const b = new Builder();
  const a = 0.5, h = 2, rho = h * Math.tan(a);
  const apex = b.add(`FACE_BOUND('',#${b.add(`VERTEX_LOOP('',#${b.vtx(0, 0, 0)})`)},.T.)`);
  const f = b.face([b.bound([b.closedCircle(b.ax([0, 0, h]), rho, [rho, 0, h], false)]), apex],
    b.add(`CONICAL_SURFACE('',#${b.ax([0, 0, 0])},0.,${a})`));
  close(await area(b, f), Math.PI * rho * (h / Math.cos(a)), 1e-8);
});

test('a half cone through its apex (the drill point form)', async () => {
  const b = new Builder();
  // u from 0 (+x) to pi (-x) through +y. Counterclockwise in (u, v): apex -> q (the ruling at u pi), q -> p (the circle
  // against u), p -> apex (the ruling at u 0). Half of pi rho s.
  const a = 0.5, h = 2, rho = h * Math.tan(a);
  const apex = b.vtx(0, 0, 0), p = b.vtx(rho, 0, h), q = b.vtx(-rho, 0, h);
  const f = b.face([b.bound([b.oe(b.edge(apex, q, b.line([0, 0, 0], [-rho, 0, h]))),
    b.oe(b.edge(p, q, b.circle(b.ax([0, 0, h]), rho)), false),
    b.oe(b.edge(p, apex, b.line([rho, 0, h], [0, 0, 0])))])],
    b.add(`CONICAL_SURFACE('',#${b.ax([0, 0, 0])},0.,${a})`));
  close(await area(b, f), (Math.PI * rho * (h / Math.cos(a))) / 2, 1e-8);
});

test('a cone frustum beyond the apex (rho negative)', async () => {
  const b = new Builder();
  // Apex at the origin, z from -2 to -1: rho = z tan(a) < 0, the point at u at angle u + pi. With u, the circles run
  // counterclockwise about +z as on the other nappe.
  const a = 0.5, t = Math.tan(a);
  const bottom = b.bound([b.closedCircle(b.ax([0, 0, -2]), 2 * t, [2 * t, 0, -2], true)]);
  const top = b.bound([b.closedCircle(b.ax([0, 0, -1]), t, [t, 0, -1], false)]);
  const f = b.face([bottom, top], b.add(`CONICAL_SURFACE('',#${b.ax([0, 0, 0])},0.,${a})`));
  close(await area(b, f), (Math.PI * 3 * t) / Math.cos(a), 1e-8);
});

test('spheres: a hemisphere, a cap, and lunes through both poles', async () => {
  const R = 3;
  {
    const b = new Builder();
    const f = b.face([b.bound([b.closedCircle(b.ax([0, 0, 0]), R, [R, 0, 0], true)])],
      b.add(`SPHERICAL_SURFACE('',#${b.ax([0, 0, 0])},${R}.)`));
    close(await area(b, f), 2 * Math.PI * R * R); // northern: the equator runs with u
  }
  {
    const b = new Builder();
    const f = b.face([b.bound([b.closedCircle(b.ax([0, 0, 0]), R, [R, 0, 0], false)])],
      b.add(`SPHERICAL_SURFACE('',#${b.ax([0, 0, 0])},${R}.)`));
    close(await area(b, f), 2 * Math.PI * R * R); // southern
  }
  {
    const b = new Builder();
    const z = R * Math.sin(Math.PI / 3), rc = R * Math.cos(Math.PI / 3);
    const f = b.face([b.bound([b.closedCircle(b.ax([0, 0, z]), rc, [rc, 0, z], true)])],
      b.add(`SPHERICAL_SURFACE('',#${b.ax([0, 0, 0])},${R}.)`));
    close(await area(b, f), 2 * Math.PI * R * R * (1 - Math.sin(Math.PI / 3)), 1e-8); // the cap above 60 degrees
  }
  {
    const b = new Builder();
    const N = b.vtx(0, 0, R), S = b.vtx(0, 0, -R);
    // Meridians at u 0 (in the xz plane, N -> S through +x) and u pi/2 (yz plane, S -> N through +y).
    const m0 = b.edge(N, S, b.circle(b.ax([0, 0, 0], [0, -1, 0], [1, 0, 0]), R), false);
    const m1 = b.edge(S, N, b.circle(b.ax([0, 0, 0], [1, 0, 0], [0, 1, 0]), R), true);
    const f = b.face([b.bound([b.oe(m1), b.oe(m0)])], b.add(`SPHERICAL_SURFACE('',#${b.ax([0, 0, 0])},${R}.)`));
    close(await area(b, f), Math.PI * R * R, 1e-8); // 2 R^2 theta, theta pi/2
  }
  {
    const b = new Builder();
    const N = b.vtx(0, 0, R), S = b.vtx(0, 0, -R);
    // From u 0 to u 3 pi/2 (the yz plane through -y): wider than pi, so the jump in u at the south pole is taken the
    // short way, by 4 pi R^2 too little, and the area is right only modulo the sphere's.
    const m0 = b.edge(N, S, b.circle(b.ax([0, 0, 0], [0, -1, 0], [1, 0, 0]), R), false);
    const m1 = b.edge(S, N, b.circle(b.ax([0, 0, 0], [-1, 0, 0], [0, -1, 0]), R), true);
    const f = b.face([b.bound([b.oe(m1), b.oe(m0)])], b.add(`SPHERICAL_SURFACE('',#${b.ax([0, 0, 0])},${R}.)`));
    close(await area(b, f), 3 * Math.PI * R * R, 1e-8);
  }
});

test('tori: the outer half between two major circles, and a ring segment flagged', async () => {
  const R = 5, r = 1;
  {
    const b = new Builder();
    // v from -pi/2 (bottom major circle, radius R, z -r) to pi/2 (top): 2 pi r (pi R + 2 r).
    const bottom = b.bound([b.closedCircle(b.ax([0, 0, -r]), R, [R, 0, -r], true)]);
    const top = b.bound([b.closedCircle(b.ax([0, 0, r]), R, [R, 0, r], false)]);
    close(await area(b, b.face([bottom, top], b.add(`TOROIDAL_SURFACE('',#${b.ax([0, 0, 0])},${R}.,${r}.)`))),
      2 * Math.PI * r * (Math.PI * R + 2 * r), 1e-8);
  }
  {
    const b = new Builder();
    // Between minor circles at u 0 and u pi/2: the loops wind the minor circle, so the area isn't reliable.
    const c0 = b.bound([b.closedCircle(b.ax([R, 0, 0], [0, 1, 0], [1, 0, 0]), r, [R + r, 0, 0], true)]);
    const c1 = b.bound([b.closedCircle(b.ax([0, R, 0], [-1, 0, 0], [0, 1, 0]), r, [0, R + r, 0], false)]);
    const res = await area(b, b.face([c0, c1], b.add(`TOROIDAL_SURFACE('',#${b.ax([0, 0, 0])},${R}.,${r}.)`)));
    assert.ok(res.ok);
    assert.deepEqual(res.flags, ['minor-winding']);
    assert.equal(trusted(res), false);
  }
});

test('FACE_SURFACE as ADVANCED_FACE; unsupported surfaces, curves and tori say why', async () => {
  const b = new Builder();
  const fs = b.face([b.polygon([[0, 0, 0], [2, 0, 0], [2, 3, 0], [0, 3, 0]])], b.add(`PLANE('',#${b.ax([0, 0, 0])})`), true,
    'FACE_SURFACE');
  close(await area(b, fs), 6);
  const ext = b.face([b.polygon([[0, 0, 0], [1, 0, 0], [1, 1, 0]])],
    b.add(`SURFACE_OF_LINEAR_EXTRUSION('',#${b.line([0, 0, 0], [1, 0, 0])},#${b.add(`VECTOR('',#${b.dir(0, 0, 1)},1.)`)})`));
  const horn = b.face([b.bound([b.closedCircle(b.ax([0, 0, 0]), 2, [2, 0, 0])])],
    b.add(`TOROIDAL_SURFACE('',#${b.ax([0, 0, 0])},1.,2.)`));
  const v = b.vtx(1, 0, 0);
  const hyp = b.face([b.bound([b.oe(b.edge(v, v, b.add(`HYPERBOLA('',#${b.ax([0, 0, 0])},1.,1.)`)))])],
    b.add(`PLANE('',#${b.ax([0, 0, 0])})`));
  const o = new AreaOracle(parseStep(b.text()));
  assert.deepEqual(o.faceArea(ext), { ok: false, reason: 'SURFACE_OF_LINEAR_EXTRUSION' });
  assert.deepEqual(o.faceArea(horn), { ok: false, reason: 'degenerate torus' });
  assert.deepEqual(o.faceArea(hyp), { ok: false, reason: 'HYPERBOLA' });
  assert.deepEqual(o.faceArea(9999), { ok: false, reason: 'missing #9999' });
});

test('loops off their surface are flagged (each kind), slightly off are not', async () => {
  const off = async (b: Builder, f: number, expected: number) => {
    const r = await area(b, f);
    assert.ok(r.ok, !r.ok ? r.reason : '');
    assert.ok(Math.abs(r.offSurface - expected) <= 1e-9, `offSurface ${r.offSurface}, expected ${expected}`);
    return r;
  };
  {
    // A rectangle with a corner 0.02 off its plane: within OFF_SURFACE of the box's diagonal, trusted (the area
    // projected onto the plane).
    const b = new Builder();
    const f = b.face([b.polygon([[0, 0, 0], [2, 0, 0], [2, 3, 0.02], [0, 3, 0]])],
      b.add(`PLANE('',#${b.ax([0, 0, 0])})`));
    close(await off(b, f, 0.02 / Math.hypot(2, 3, 0.02)), 6);
  }
  const flagged = async (b: Builder, f: number, expected: number) => {
    const r = await off(b, f, expected);
    assert.ok(r.ok && r.flags.includes('off-surface'), `flags ${r.ok && r.flags}`);
    assert.equal(trusted(r), false);
  };
  {
    const b = new Builder();
    const f = b.face([b.polygon([[0, 0, 0], [2, 0, 0], [2, 3, 0.5], [0, 3, 0]])],
      b.add(`PLANE('',#${b.ax([0, 0, 0])})`));
    await flagged(b, f, 0.5 / Math.hypot(2, 3, 0.5));
  }
  // Circles of radii r0 (z 0) and r1 (z h) on a surface; their distance from it, over the box's diagonal.
  const band = async (surface: (b: Builder) => number, r0: number, r1: number, h: number, expected: number) => {
    const b = new Builder();
    const bottom = b.bound([b.closedCircle(b.ax([0, 0, 0]), r0, [r0, 0, 0], true)]);
    const top = b.bound([b.closedCircle(b.ax([0, 0, h]), r1, [r1, 0, h], false)]);
    const R = Math.max(r0, r1);
    await flagged(b, b.face([bottom, top], surface(b)), expected / Math.hypot(2 * R, 2 * R, h));
  };
  await band((b) => b.add(`CYLINDRICAL_SURFACE('',#${b.ax([0, 0, 0])},2.)`), 2, 2.5, 5, 0.5);
  // Radius 1 + z (45 degrees): the top circle 0.5 out at z 1 is 0.5 cos 45 from the cone.
  await band((b) => b.add(`CONICAL_SURFACE('',#${b.ax([0, 0, 0])},1.,${Math.PI / 4})`), 1, 2.5, 1,
    0.5 * Math.SQRT1_2);
  // The far nappe (apex at z 1): radius 1 at z 0 is on it, radius 2 at z -1 would be, 2.5 is 0.5 out.
  await band((b) => b.add(`CONICAL_SURFACE('',#${b.ax([0, 0, 2])},1.,${Math.PI / 4})`), 1, 2.5, -1,
    0.5 * Math.SQRT1_2);
  // A sphere of radius 3: circles of radius 3 at z 0 (on it) and at z 1 (sqrt 10 from the centre).
  await band((b) => b.add(`SPHERICAL_SURFACE('',#${b.ax([0, 0, 0])},3.)`), 3, 3, 1, Math.sqrt(10) - 3);
  // A torus (5, 1): the outer equator (radius 6, on it) and a circle of radius 6 at z 1.5 (off the tube).
  await band((b) => b.add(`TOROIDAL_SURFACE('',#${b.ax([0, 0, 0])},5.,1.)`), 6, 6, 1.5, Math.hypot(1, 1.5) - 1);
});

test('trusted: no flags and a small error estimate', async () => {
  const base = { ok: true as const, area: 10, perimeter: 1, surface: 'plane' as const, offSurface: 0, curves: [] };
  assert.equal(trusted({ ...base, error: 1e-6, flags: [] }), true);
  assert.equal(trusted({ ...base, error: 1e-4, flags: [] }), false);
  assert.equal(trusted({ ...base, error: 0, flags: ['no-loops'] }), false);
  assert.equal(trusted({ ok: false, reason: 'x' }), false);
});

test('a B-spline edge whose vertices run against its sense: unsupported by both oracles', async () => {
  const b = new Builder();
  const [p, q] = [b.pt(0, 0, 0), b.pt(2, 0, 0)];
  const spline = b.add(`B_SPLINE_CURVE_WITH_KNOTS('',1,(#${p},#${q}),.UNSPECIFIED.,.F.,.F.,(2,2),(0.,1.),.UNSPECIFIED.)`);
  const [va, vb, vc] = [b.vtx(0, 0, 0), b.vtx(2, 0, 0), b.vtx(1, 1, 0)];
  const loop = b.bound([b.oe(b.edge(va, vb, spline, false)), b.oe(b.edge(vb, vc, b.line([2, 0, 0], [1, 1, 0]))),
    b.oe(b.edge(vc, va, b.line([1, 1, 0], [0, 0, 0])))]);
  const f = b.face([loop], b.add(`PLANE('',#${b.ax([0, 0, 0])})`));
  assert.deepEqual(await area(b, f), { ok: false, reason: 'vertices against the curve\'s sense' });
});
