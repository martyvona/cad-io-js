// Point classification on built solids (cad-brep's test models): RayShellSide and the Oracle's classify, shellSide
// and nesting against how each was built. A box with a box-shaped void: the outer shell's faces outside, the void's
// inside (facing into the void), the void nested in the outer; a box built inside out and used as built: inside; one
// built inside out and used reversed: outside; two lumps side by side in one solid: neither holds the other; two
// crossing: nesting can't tell; a face's loops against its sense: unknown where a ray meets it; a cone reaching its
// apex as a pole. With checkSecondRay a second ray agrees.
// Skipped where the module isn't built (build.sh module).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { BrepBuilder, type BrepData } from 'cad-brep';
import { box, MODELS } from '../../cad-brep/test/models.ts';
import { init, Oracle } from '../src/index.ts';
import { RayShellSide } from '../src/shell-side.ts';

const pkg = path.join(import.meta.dirname, '..');
const built = fs.existsSync(path.join(pkg, 'dist/cad_oracle.wasm'));
const skip = built ? false : 'cad-oracle\'s module not built (run packages/cad-oracle/build.sh module)';

/** Each shell's faces (rows), from the model's shell and face-use tables. */
function shellFaces(d: BrepData): number[][] {
  const out: number[][] = [];
  for (let s = 0; s < d.shell.kind.length; s++) {
    const first = d.shell.first[s]!, count = d.shell.count[s]!;
    out.push(Array.from(d.faceUse.face.subarray(first, first + count)));
  }
  return out;
}

/** Every face's side of its shell, by shell. */
function sides(ss: RayShellSide, d: BrepData, eps: number): string[][] {
  return shellFaces(d).map((faces, s) => faces.map((f) => ss.side(d, s, f, eps).side));
}

test('withVoid: the outer shell faces out, the void into the void, the void nested in the outer', { skip },
  async () => {
  const d = MODELS.withVoid().finish();
  using ss = new RayShellSide(await init());
  const s = sides(ss, d, 1e-3);
  assert.deepEqual(s, [Array(6).fill('outside'), Array(6).fill('inside')]);
  using o = new Oracle(await init(), d.buffer);
  assert.deepEqual(o.nesting(0), [-1, 0]);
  // The void's middle is inside the void's shell and inside the outer's; a point between them inside the outer only.
  assert.equal(o.classify(1, [1.5, 1.5, 1.5]).side, 'inside');
  assert.equal(o.classify(0, [1.5, 1.5, 1.5]).side, 'inside');
  assert.equal(o.classify(1, [3, 3, 3]).side, 'outside');
  assert.equal(o.classify(0, [3, 3, 3]).side, 'inside');
  assert.equal(o.classify(0, [9, 9, 9]).side, 'outside');
});

test('a box inside out as built: inside; built inside out and used reversed: outside', { skip }, async () => {
  using ss = new RayShellSide(await init());
  {
    const b = new BrepBuilder();
    const shell = box(b, [1, 2, 3], [0, 0, 0], 0, () => true, true);
    b.addItem({ kind: 'body', ref: b.addBody({ kind: 'solid', members: [{ ref: shell, sense: true }] }) });
    assert.deepEqual(sides(ss, b.finish(), 1e-3), [Array(6).fill('inside')]);
  }
  assert.deepEqual(sides(ss, MODELS.reversedUses().finish(), 1e-3), [Array(6).fill('outside'),
    Array(6).fill('outside')]);
});

test('two lumps side by side in one solid: neither holds the other', { skip }, async () => {
  const b = new BrepBuilder();
  const one = box(b, [1, 1, 1]), two = box(b, [1, 1, 1], [3, 0, 0], 100);
  b.addItem({ kind: 'body', ref: b.addBody({ kind: 'solid', members: [{ ref: one, sense: true },
    { ref: two, sense: true }] }) });
  using o = new Oracle(await init(), b.finish().buffer);
  assert.deepEqual(o.nesting(0), [-1, -1]);
});

test('two lumps crossing in one solid: neither held nor apart, -2 for both', { skip }, async () => {
  // A 2 x 2 x 2 box and a 2 x 1 x 1 one from x 1 to 3 through its side: each has faces inside the other (the long
  // one's end at x 1, the cube's side at x 2) and outside it, so neither holds the other and nesting can't tell.
  const b = new BrepBuilder();
  const one = box(b, [2, 2, 2]), two = box(b, [2, 1, 1], [1, 0.5, 0.5], 100);
  b.addItem({ kind: 'body', ref: b.addBody({ kind: 'solid', members: [{ ref: one, sense: true },
    { ref: two, sense: true }] }) });
  using o = new Oracle(await init(), b.finish().buffer);
  assert.deepEqual(o.nesting(0), [-2, -2]);
});

test('a box inside another touching three of its faces: points on it, so nesting can\'t tell, -2', { skip },
  async () => {
    // The unit box in the corner of a 2 x 2 x 2 one: its faces at x, y, z = 0 lie on the outer's, their points on it,
    // the other three inside. Held needs every point inside; a touch (not a manifold void) is left untold.
    const b = new BrepBuilder();
    const outer = box(b, [2, 2, 2]), inner = box(b, [1, 1, 1], [0, 0, 0], 100);
    b.addItem({ kind: 'body', ref: b.addBody({ kind: 'solid', members: [{ ref: outer, sense: true },
      { ref: inner, sense: false }] }) });
    using o = new Oracle(await init(), b.finish().buffer);
    assert.deepEqual(o.nesting(0), [-1, -2]);
  });

test('checkSecondRay: a second ray agrees; the evidence names the point and the ray', { skip }, async () => {
  const d = MODELS.cube().finish();
  using ss = new RayShellSide(await init(), { checkSecondRay: true });
  const r = ss.side(d, 0, 0, 1e-3);
  assert.equal(r.side, 'outside');
  assert.equal(r.evidence?.classified.checked, true);
  assert.ok(r.evidence?.classified.ray && r.evidence.classified.ray.crossings % 2 === 0);
  assert.ok(Math.abs(r.evidence!.eps - 1e-3) < 1e-15);
  using o = new Oracle(await init(), d.buffer, { checkSecondRay: true });
  const c = o.classify(0, [0.5, 0.5, 0.5]);
  assert.equal(c.side, 'inside');
  assert.ok(c.checked && c.ray!.crossings % 2 === 1);
  // Without a shell: unknown, said why.
  assert.equal(o.classify(7, [0, 0, 0]).side, 'unknown');
});

test('a face with its loops against its sense: unknown where a ray meets it or it\'s the face, said why; known where '
  + 'none does', { skip }, async () => {
  // The cube with one face's sense turned in the buffer, its loop left: the face's measure is flagged orientation, and
  // a ray through its plane would count its complement. The rays' first direction is (-0.81, -0.51, 0.28).
  const why = 'a face the rays meet has its loops against its sense';
  const turned = (f: number) => {
    const d = MODELS.cube().finish();
    d.face.sameSense[f] = 0;
    return d;
  };
  // The bottom turned: its own side unknown; every other face's ray climbs away from it.
  const d = turned(0);
  using o = new Oracle(await init(), d.buffer);
  assert.ok(o.face(0).flags.includes('orientation'));
  assert.equal(o.shellSide(0, 0, 1e-3).why, why);
  for (const f of [1, 2, 3, 4, 5]) assert.equal(o.shellSide(0, f, 1e-3).side, 'outside', `face ${f}`);
  // y = 0 turned: the ray from beside x = 1 crosses it within its square, unknown; the one from above the top
  // meets its plane only beyond its box (x -0.3), outside.
  const e = turned(2);
  using p = new Oracle(await init(), e.buffer);
  const r = p.shellSide(0, 5, 1e-3);
  assert.equal(r.side, 'unknown');
  assert.equal(r.why, why);
  assert.equal(p.shellSide(0, 1, 1e-3).side, 'outside');
  // The same cube as built: outside.
  const c = MODELS.cube().finish();
  using q = new Oracle(await init(), c.buffer);
  assert.equal(q.shellSide(0, 0, 1e-3).side, 'outside');
});

/**
 * A cone's point: the cone from its apex (0, 0, -1), a pole with no vertex there, up to the circle of radius 1 at z
 * = 0, closed by the disc there.
 */
function conePoint(): BrepData {
  const b = new BrepBuilder();
  const O: [number, number, number] = [0, 0, 0], Z: [number, number, number] = [0, 0, 1];
  const X: [number, number, number] = [1, 0, 0];
  const cone = b.addSurface({ kind: 'cone', radius: 1, semiAngle: Math.PI / 4,
    position: { origin: O, axis: Z, xDir: X } });
  const plane = b.addSurface({ kind: 'plane', position: { origin: O, axis: Z, xDir: X } });
  const p = b.addVertex({ point: [1, 0, 0] });
  const circle = b.addCurve({ kind: 'circle', radius: 1, position: { origin: O, axis: Z, xDir: X } });
  const e = b.addEdge({ curve: circle, start: p, end: p, sameSense: true, range: [0, 2 * Math.PI] });
  const side = b.addFace({ surface: cone, sameSense: true, loops: [{ kind: 'edge', bound: 'outer', coedges: [
    { edge: e, orientation: 'reversed' }] }] });
  const top = b.addFace({ surface: plane, sameSense: true, loops: [{ kind: 'edge', bound: 'outer', coedges: [
    { edge: e, orientation: 'forward' }] }] });
  const shell = b.addShell({ kind: 'closed', faces: [{ face: side, sense: true }, { face: top, sense: true }] });
  b.addItem({ kind: 'body', ref: b.addBody({ kind: 'solid', members: [{ ref: shell, sense: true }] }) });
  return b.finish();
}

/**
 * A barrel: a revolution about z of the parabola r = 2 - z^2 / 2 (its parameter unbounded) between its circles at z
 * = +/-1 (radius 1.5), closed by the discs there; its band bulges to radius 2 at z = 0, outside its circles' box.
 */
function barrel(): BrepData {
  const b = new BrepBuilder();
  const O: [number, number, number] = [0, 0, 0], Z: [number, number, number] = [0, 0, 1];
  const X: [number, number, number] = [1, 0, 0];
  // (Part 42's parabola: origin + f (t^2 x + 2 t y), here (2 - t^2 / 2, 0, t).)
  const parabola = b.addCurve({ kind: 'parabola', focalDist: 0.5, position: { origin: [2, 0, 0], axis: [0, 1, 0],
    xDir: [-1, 0, 0] } });
  const band = b.addSurface({ kind: 'revolution', curve: parabola, axisOrigin: O, axisDirection: Z });
  const ring = (z: number) => {
    const p = b.addVertex({ point: [1.5, 0, z] });
    const c = b.addCurve({ kind: 'circle', radius: 1.5, position: { origin: [0, 0, z], axis: Z, xDir: X } });
    return b.addEdge({ curve: c, start: p, end: p, sameSense: true, range: [0, 2 * Math.PI] });
  };
  const top = ring(1), bottom = ring(-1);
  const disc = (z: number, edge: number, up: boolean) => b.addFace({ surface: b.addSurface({ kind: 'plane',
    position: { origin: [0, 0, z], axis: up ? Z : [0, 0, -1], xDir: X } }), sameSense: true, loops: [{ kind: 'edge',
    bound: 'outer', coedges: [{ edge, orientation: up ? 'forward' : 'reversed' }] }] });
  const side = b.addFace({ surface: band, sameSense: true, loops: [
    { kind: 'edge', bound: 'outer', coedges: [{ edge: top, orientation: 'reversed' }] },
    { kind: 'edge', bound: 'outer', coedges: [{ edge: bottom, orientation: 'forward' }] }] });
  const faces = [side, disc(1, top, true), disc(-1, bottom, false)];
  const shell = b.addShell({ kind: 'closed', faces: faces.map((face) => ({ face, sense: true })) });
  b.addItem({ kind: 'body', ref: b.addBody({ kind: 'solid', members: [{ ref: shell, sense: true }] }) });
  return b.finish();
}

test('a revolution bulging past its boundary\'s box (its domain unbounded): a ray meeting the bulge counted', { skip },
  async () => {
    const d = barrel();
    using o = new Oracle(await init(), d.buffer);
    // (Its band's boundary projected: it has no p-curves.)
    assert.deepEqual(o.face(0).flags, ['projectedBoundary']);
    // (The first ray, about (-0.81, -0.51, 0.28), from (-1.6, -0.5, 0) stays past x = -1.5, clear of the circles'
    // box, and leaves through the bulge.)
    for (const p of [[-1.6, -0.5, 0], [0, 1.8, 0], [1.3, -1.3, 0.1], [0, 0, 0]] as const) {
      assert.equal(o.classify(0, [...p]).side, 'inside', `${p}`);
    }
    assert.equal(o.classify(0, [0, 2.2, 0]).side, 'outside');
  });

/**
 * A ring solid between radii 1 and 2, 0.5 high (planes and cylinders), its top face's tolerance 0.01: that face's
 * point well inside is in at 0.01 and farther than 10 x that from both circles.
 */
function ring(tol = 0.01): BrepData {
  const b = new BrepBuilder();
  const Z: [number, number, number] = [0, 0, 1], X: [number, number, number] = [1, 0, 0];
  const circle = (r: number, z: number) => {
    const p = b.addVertex({ point: [r, 0, z] });
    const c = b.addCurve({ kind: 'circle', radius: r, position: { origin: [0, 0, z], axis: Z, xDir: X } });
    return b.addEdge({ curve: c, start: p, end: p, sameSense: true, range: [0, 2 * Math.PI] });
  };
  const t1 = circle(1, 0.5), t2 = circle(2, 0.5), b1 = circle(1, 0), b2 = circle(2, 0);
  const plane = (z: number, up: boolean) => b.addSurface({ kind: 'plane', position: { origin: [0, 0, z],
    axis: up ? Z : [0, 0, -1], xDir: X } });
  const cylinder = (r: number) => b.addSurface({ kind: 'cylinder', radius: r, position: { origin: [0, 0, 0], axis: Z,
    xDir: X } });
  const loop = (edge: number, forward: boolean, bound: 'outer' | 'inner' = 'outer') => ({ kind: 'edge' as const,
    bound, coedges: [{ edge, orientation: forward ? 'forward' as const : 'reversed' as const }] });
  const faces = [
    b.addFace({ surface: plane(0.5, true), sameSense: true, tolerance: tol, loops: [loop(t2, true),
      loop(t1, false, 'inner')] }),
    b.addFace({ surface: plane(0, false), sameSense: true, loops: [loop(b2, false), loop(b1, true, 'inner')] }),
    b.addFace({ surface: cylinder(2), sameSense: true, loops: [loop(b2, true), loop(t2, false)] }),
    b.addFace({ surface: cylinder(1), sameSense: false, loops: [loop(b1, false), loop(t1, true)] })];
  const shell = b.addShell({ kind: 'closed', faces: faces.map((face) => ({ face, sense: true })) });
  b.addItem({ kind: 'body', ref: b.addBody({ kind: 'solid', members: [{ ref: shell, sense: true }] }) });
  return b.finish();
}

test('a point well inside a face: in at its tolerance, and clear of its boundary by 100, else 10, x it', { skip },
  async () => {
    // At 0.01 the ring 1 wide is all within 100 x the tolerance of its circles: 10 x; at 0.002, 100 x (0.2).
    for (const [tol, clear] of [[0.01, 0.1], [0.002, 0.2]] as const) {
      using o = new Oracle(await init(), ring(tol).buffer);
      const r = o.shellSide(0, 0, 1e-3);
      assert.equal(r.side, 'outside');
      const rho = Math.hypot(r.from[0], r.from[1]);
      assert.ok(rho >= 1 + clear && rho <= 2 - clear && Math.abs(r.from[2] - 0.5) < 1e-12, `${tol}: ${r.from}`);
    }
  });

test('a face narrower than 20 x its tolerance: its point in at the tolerance itself, for shellSide alone', { skip },
  async () => {
    // At 0.06 the ring 1 wide is all within 10 x the tolerance (0.6) of its circles: the point is one in at 0.06,
    // farther than that from both. Nesting takes points well inside only: the ring's top face gives it none.
    using o = new Oracle(await init(), ring(0.06).buffer);
    const r = o.shellSide(0, 0, 1e-3);
    assert.equal(r.side, 'outside');
    const rho = Math.hypot(r.from[0], r.from[1]);
    assert.ok(rho >= 1.06 && rho <= 1.94 && Math.abs(r.from[2] - 0.5) < 1e-12, `${r.from}`);
  });

test('a void narrower than 20 x the tolerance: its faces\' sides told, its nesting not (no point well inside)',
  { skip }, async () => {
    // At 0.06 (the part's uncertainty), the void's faces 0.5 across are within 10 x it of their edges throughout.
    // Moved into the material (an offset into the void, 0.6 at the least, would come out through its far face).
    const b = new BrepBuilder({ uncertainty: 0.06 });
    const outer = box(b, [4, 4, 4]), hole = box(b, [0.5, 0.5, 0.5], [1.75, 1.75, 1.75], 100, () => true);
    b.addItem({ kind: 'body', ref: b.addBody({ kind: 'solid', members: [{ ref: outer, sense: true },
      { ref: hole, sense: false }] }) });
    using o = new Oracle(await init(), b.finish().buffer);
    assert.equal(o.shellSide(1, 6, -1e-3).side, 'outside');
    assert.deepEqual(o.nesting(0), [-1, -2]);
  });

test('a narrow face whose loop has a gap wider than its tolerance: no point in at the tolerance alone', { skip },
  async () => {
    // A box 4 x 0.5 x 2 at 0.06: its bottom face within 10 x that of its edges throughout, its point one in at 0.06.
    // With the edge from (0, 0, 0) to (0, 0.5, 0) 0.1 short of its end (its line's magnitude 0.4), the face's loop
    // has a gap there: classified at 0.06 its points are invalidModel, so none is taken, though their sides say in.
    for (const short of [false, true]) {
      const b = new BrepBuilder({ uncertainty: 0.06 });
      const shell = box(b, [4, 0.5, 2]);
      b.addItem({ kind: 'body', ref: b.addBody({ kind: 'solid', members: [{ ref: shell, sense: true }] }) });
      const d = b.finish();
      if (short) d.pool.curveReal[d.curve.real[d.edge.curve[0]!]! + 6] = 0.4;
      using o = new Oracle(await init(), d.buffer);
      const r = o.shellSide(0, 0, -1e-3);
      assert.deepEqual([r.side, r.why ?? ''], short ? ['unknown', 'no point well inside the face'] : ['inside', ''],
        `${short}`);
    }
  });

test('a degenerate torus\'s face can\'t be counted: a ray meeting its surface set aside', { skip }, async () => {
  // Shells of one loopless face on a torus: a ring (3, 1), a spindle (1, 3) and a horn (2, 2). A point in the ring's
  // tube is inside; in the others no ray from a point within the surface's reach is usable, so it's unknown; a point
  // past the surface's box, its rays missing it, still outside.
  for (const [R, r] of [[3, 1], [1, 3], [2, 2]] as const) {
    const b = new BrepBuilder();
    const surface = b.addSurface({ kind: 'torus', position: { origin: [0, 0, 0], axis: [0, 0, 1], xDir: [1, 0, 0] },
      majorRadius: R, minorRadius: r });
    const face = b.addFace({ surface, sameSense: true, loops: [] });
    const shell = b.addShell({ kind: 'closed', faces: [{ face, sense: true }] });
    b.addItem({ kind: 'body', ref: b.addBody({ kind: 'solid', members: [{ ref: shell, sense: true }] }) });
    using o = new Oracle(await init(), b.finish().buffer);
    const c = o.classify(0, [R, 0, 0]);
    assert.deepEqual([c.side, c.why], R > r ? ['inside', ''] : ['unknown', 'no usable ray'], `${R}, ${r}`);
    assert.equal(o.classify(0, [R + r + 1, 0, 0]).side, 'outside', `${R}, ${r}`);
  }
});

test('the points off both sides of a face on the same side of the shell: neither told', { skip }, async () => {
  // A box 2 across with a square 0.2 across at z = 1 inside it, in its shell (its rays miscounted, as a face
  // classified in where it isn't would have them): both points off the square are inside the box.
  const b = new BrepBuilder();
  const shell = box(b, [2, 2, 2]);
  const at = [[0.9, 0.9], [1.1, 0.9], [1.1, 1.1], [0.9, 1.1]] as const;
  const vs = at.map(([x, y]) => b.addVertex({ point: [x, y, 1] }));
  const edges = at.map(([x, y], i) => {
    const [x2, y2] = at[(i + 1) % 4]!, len = Math.hypot(x2 - x, y2 - y);
    const curve = b.addCurve({ kind: 'line', point: [x, y, 1], direction: [(x2 - x) / len, (y2 - y) / len, 0],
      magnitude: len });
    return b.addEdge({ curve, start: vs[i]!, end: vs[(i + 1) % 4]!, sameSense: true, range: [0, 1] });
  });
  const plane = b.addSurface({ kind: 'plane', position: { origin: [0, 0, 1], axis: [0, 0, 1], xDir: [1, 0, 0] } });
  const square = b.addFace({ surface: plane, sameSense: true, id: 999, loops: [{ kind: 'edge', bound: 'outer',
    sense: true, coedges: edges.map((edge) => ({ edge, orientation: 'forward' as const })) }] });
  // (box() closes its shell; the square added to it.)
  (b as unknown as { shells: { faces: { face: number; sense: boolean }[] }[] }).shells[shell]!.faces
    .push({ face: square, sense: true });
  b.addItem({ kind: 'body', ref: b.addBody({ kind: 'solid', members: [{ ref: shell, sense: true }] }) });
  const d = b.finish();
  using o = new Oracle(await init(), d.buffer);
  const f = Array.from(d.face.id).indexOf(999);
  for (const eps of [0.3, -0.05]) {
    const r = o.shellSide(0, f, eps);
    const why = 'the points off both sides of the face on the same side of the shell';
    assert.deepEqual([r.side, r.why], ['unknown', why], `${eps}`);
  }
  assert.equal(o.shellSide(0, Array.from(d.face.id).indexOf(21), 0.3).side, 'outside');
});

test('a cone reaching its apex as a pole: a ray meeting it below its circle\'s box still counted', { skip },
  async () => {
    const d = conePoint();
    using o = new Oracle(await init(), d.buffer);
    // (The model as meant: the lateral area pi r s, unflagged.)
    const m = o.face(0);
    assert.deepEqual(m.flags, []);
    assert.ok(Math.abs(m.area.value - Math.PI * Math.SQRT2) < 1e-9, `${m.area.value}`);
    // Near the apex, every ray leaves through the cone below z = 0.
    for (const z of [-0.8, -0.5, -0.2]) assert.equal(o.classify(0, [0, 0, z]).side, 'inside', `z ${z}`);
    assert.equal(o.classify(0, [0, 0, -1.2]).side, 'outside');
    assert.equal(o.classify(0, [0.5, 0, -0.8]).side, 'outside');
    assert.equal(o.shellSide(0, 1, 1e-3).side, 'outside');
  });

test('a thin wall: an offset deeper than the wall halved until it stays inside', { skip }, async () => {
  // A box 0.004 thick: moved 0.01 into the material from its top or bottom, the point would come out of the other
  // face; the offset is halved (to 0.0025) so it doesn't.
  const b = new BrepBuilder();
  const shell = box(b, [1, 1, 0.004]);
  b.addItem({ kind: 'body', ref: b.addBody({ kind: 'solid', members: [{ ref: shell, sense: true }] }) });
  const d = b.finish();
  using ss = new RayShellSide(await init());
  for (const f of shellFaces(d)[0]!) {
    const r = ss.side(d, 0, f, -0.01);
    assert.equal(r.side, 'inside', `face ${f}: ${r.why}`);
    assert.ok(Math.abs(r.evidence!.eps) < 0.004 || f > 1, `face ${f}'s offset ${r.evidence!.eps}`);
  }
});

test('three shells nested: a lump inside a void inside the outer shell', { skip }, async () => {
  const b = new BrepBuilder();
  const outer = box(b, [10, 10, 10]), hole = box(b, [6, 6, 6], [2, 2, 2], 100);
  const lump = box(b, [2, 2, 2], [4, 4, 4], 200);
  b.addItem({ kind: 'body', ref: b.addBody({ kind: 'solid', members: [{ ref: outer, sense: true },
    { ref: hole, sense: false }, { ref: lump, sense: true }] }) });
  using o = new Oracle(await init(), b.finish().buffer);
  assert.deepEqual(o.nesting(0), [-1, 0, 1]);
});

test('nesting by the body\'s members, not the shell table\'s rows: the void\'s shell built first', { skip },
  async () => {
  const b = new BrepBuilder();
  const hole = box(b, [1, 1, 1], [1, 1, 1], 100), outer = box(b, [4, 4, 4]);
  b.addItem({ kind: 'body', ref: b.addBody({ kind: 'solid', members: [{ ref: outer, sense: true },
    { ref: hole, sense: false }] }) });
  using o = new Oracle(await init(), b.finish().buffer);
  assert.deepEqual(o.nesting(0), [-1, 0]);
});
