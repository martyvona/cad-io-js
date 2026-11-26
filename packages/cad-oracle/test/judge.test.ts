// areaOracle (the judging area oracle tess-workers' workers set) and shellVolumes (shells' exact orientation).
import assert from 'node:assert/strict';
import test from 'node:test';
import { BrepBuilder } from 'cad-brep';
import { box, cube, withVoid } from '../../cad-brep/test/models.ts';
import { bsplineCylinder, line2 } from '../../cad-heal/test/models.ts';
import { areaOracle, init, JUDGE_PROJECT, JUDGE_REL_TOL, JUDGE_RELATIVE, Oracle, shellVolumes } from '../src/index.ts';

const module = await init();

test('judging\'s level (JUDGE_RELATIVE, 1e-2) apart from the oracle\'s verdicts\' and healing\'s (1e-3)', async () => {
  // A cylinder's side (area 20 pi) whose bottom circle is d = 0.014 off it: its boundary's bound about d (4 pi + 10),
  // 5e-3 of the area: judged (within 1e-2), but not trusted at 1e-3, so the shell's volume isn't known by it.
  const { cylinderSide } = await import('../../cad-heal/test/models.ts');
  assert.equal(JUDGE_RELATIVE, 1e-2);
  const d = cylinderSide({ bottom: {} }, 1e-6, 0, undefined, 2.014).finish();
  const f = areaOracle(module).areas(d).get(9);
  assert.ok(f && f.error > 1e-3 * f.area && f.error <= 1e-2 * f.area, JSON.stringify(f));
  assert.equal(areaOracle(module, { relative: 1e-3 }).areas(d).size, 0);
  d.body.kind[0] = 1;
  d.shell.kind[0] = 1;
  const [shell] = shellVolumes(module, d);
  assert.deepEqual([shell!.known, shell!.why], [false, 'face row 0\'s area isn\'t trusted']);
});

test('areaOracle: the faces trusted at JUDGE_RELATIVE by id, with their errors; faces sharing an id left out', () => {
  // The B-spline cylinder's circles have no p-curves: by default not projected, so the face isn't judged.
  const d = bsplineCylinder(line2([1, 0], [0, 1])).finish();
  assert.equal(JUDGE_PROJECT, false);
  assert.equal(areaOracle(module).areas(d).size, 0);
  const a = areaOracle(module, { project: true }).areas(d);
  assert.deepEqual([...a.keys()], [9]);
  const f = a.get(9)!;
  assert.ok(Math.abs(f.area - 20 * Math.PI) <= 1e-6 * 20 * Math.PI && f.error > 0
    && f.error <= JUDGE_RELATIVE * f.area, JSON.stringify(f));
  assert.ok(Math.abs(f.perimeter - (8 * Math.PI + 10)) <= 1e-6 * f.perimeter, `${f.perimeter}`);
  // Its error the area's own, at judging's quadrature tolerance.
  { using o = new Oracle(module, d.buffer, { relTol: JUDGE_REL_TOL }); assert.equal(f.error, o.face(0).area.error); }
  // Without projections: no area for the face (its circles have no p-curve to follow).
  { using o = new Oracle(module, d.buffer, { projectMissing: false }); assert.notEqual(o.face(0).area.status, 'ok'); }
  // Stricter than its error (its projected circles' bound): left out.
  assert.equal(areaOracle(module, { relative: 1e-9, project: true }).areas(d).size, 0);
  // A cube's six faces; two of them given one id: both left out.
  const c = cube().finish();
  assert.equal(areaOracle(module).areas(c).size, 6);
  c.face.id[1] = c.face.id[0]!;
  assert.deepEqual([...areaOracle(module).areas(c).keys()].length, 4);
});

test('shellVolumes: a solid\'s shells\' signed volumes, the sign known; a void facing in or out by its sign', () => {
  const [one] = shellVolumes(module, cube().finish());
  assert.ok(Math.abs(one!.volume - 1) < 1e-12 && one!.known && one!.side === 'unknown', JSON.stringify(one));
  assert.deepEqual(shellVolumes(module, withVoid().finish()).map((s) => [s.shell, Math.round(s.volume * 1e9) / 1e9,
    s.known]), [[0, 64, true], [1, -1, true]]);
  for (const [sense, v] of [[false, -1], [true, 1]] as const) {
    const b = new BrepBuilder();
    const outer = box(b, [4, 4, 4]), inner = box(b, [1, 1, 1], [1, 1, 1], 1000);
    b.addItem({ kind: 'body', ref: b.addBody({ kind: 'solid', members: [{ ref: outer, sense: true },
      { ref: inner, sense }] }) });
    assert.equal(Math.round(shellVolumes(module, b.finish())[1]!.volume * 1e9) / 1e9, v);
  }
  // An open sheet isn't a solid: nothing.
  assert.deepEqual(shellVolumes(module, bsplineCylinder(line2([1, 0], [0, 1])).finish()), []);
});

test('shellVolumes: unknown where the shell isn\'t closed or a face\'s area isn\'t trusted; a ShellSide asked', () => {
  // The cube with a face's loops dropped (an open shell, its kind open): not summed.
  const d = cube().finish();
  d.shell.kind[0] = 2;
  const [open] = shellVolumes(module, d);
  assert.deepEqual([open!.known, open!.why, open!.volume], [false, 'the shell isn\'t closed', NaN]);
  // A face whose area isn't trusted within 1e-3 (the B-spline cylinder's circles projected at a tolerance of 0.5, so
  // its boundary's bound is past it), in a shell taken as a closed solid's: not summed.
  const c = bsplineCylinder(line2([1, 0], [0, 1])).finish();
  c.edge.tolerance.fill(0.5);
  c.body.kind[0] = 1;
  c.shell.kind[0] = 1;
  const [cyl] = shellVolumes(module, c);
  assert.deepEqual([cyl!.known, cyl!.why, cyl!.volume], [false, 'face row 0\'s area isn\'t trusted', NaN]);
  // A ShellSide's answer, for the shell's first face with loops, at eps.
  const asked: [number, number, number][] = [];
  const [s] = shellVolumes(module, cube().finish(), { eps: 0.5, sides: { side: (_m, shell, face, eps) => (asked.push(
    [shell, face, eps]), { side: 'outside', why: 'ray +x: 1 hit' }) } });
  assert.deepEqual(asked, [[0, 0, 0.5]]);
  assert.deepEqual([s!.side, s!.sideWhy], ['outside', 'ray +x: 1 hit']);
});
