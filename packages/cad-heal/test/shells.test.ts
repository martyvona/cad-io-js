// orientShells: a solid's closed shell facing the wrong way turned in the model (by its exact signed volume and point
// classification), said, recorded in the analysis, and turned back when healing again puts the source back; a face
// whose loops run against its sense flipped where its neighbours agree with the loops.
import assert from 'node:assert/strict';
import test from 'node:test';
import { type BrepData, BrepBuilder, openAnalysis, openBrep } from 'cad-brep';
import { init as initOracle, shellVolumes } from 'cad-oracle';
import { box } from '../../cad-brep/test/models.ts';
import { healPart } from '../src/index.ts';
import { faceSenses, loopWinding, shellVerdicts, turnShells } from '../src/fix/shells.ts';
import { Geometry, init as initGeom } from 'cad-geom';

const geom = await initGeom(), oracle = await initOracle();

/** A 4 mm box with a 1 mm void (shell rows 0 and 1), each used with the sense given (the void false: facing in). */
function model(outerSense = true, voidSense = false): BrepData {
  const b = new BrepBuilder();
  const outer = box(b, [4, 4, 4]), inner = box(b, [1, 1, 1], [1, 1, 1], 1000);
  b.addItem({ kind: 'body', ref: b.addBody({ kind: 'solid', members: [{ ref: outer, sense: outerSense },
    { ref: inner, sense: voidSense }], id: 500 }) });
  return b.finish();
}
const volumes = (d: BrepData) => shellVolumes(oracle, d).map((s) => Math.round(s.volume * 1e9) / 1e9);
const same = (x: BrepData, y: BrepData) => Buffer.from(x.buffer).equals(Buffer.from(y.buffer));

test('a solid as built facing out: nothing turned; its shells\' volumes and facing recorded', async () => {
  const d = model();
  assert.deepEqual(volumes(d), [64, -1]);
  const h = await healPart(d, {}, geom);
  assert.ok(!h.diagnostics.some((x) => x.message.startsWith('orientShells')), JSON.stringify(h.diagnostics));
  assert.deepEqual(volumes(h.model), [64, -1]);
  const a = openAnalysis(new Uint8Array(h.analysis!.buffer));
  assert.deepEqual([...a.shell.turned], [0, 0]);
  assert.deepEqual([...a.shell.facing], [1, 2]);
  // (Found by the volume and point classification both.)
  assert.deepEqual([...a.shell.facingFrom], [3, 3]);
  assert.ok(Math.abs(a.shell.volume[0]! - 64) < 1e-9 && a.shell.volume[1]! >= 0);
});

test('a void facing into the material, an outer shell facing in, both: turned, said, recorded', async () => {
  for (const [outerSense, voidSense, rows] of [[true, true, [1]], [false, false, [0]], [false, true, [0, 1]]] as
    const) {
    const d = model(outerSense, voidSense);
    const h = await healPart(d, {}, geom);
    assert.ok(h.changed);
    assert.deepEqual(volumes(h.model), [64, -1], `${outerSense} ${voidSense}`);
    const said = h.diagnostics.filter((x) => x.message.startsWith('orientShells'));
    assert.equal(said.length, 1, JSON.stringify(h.diagnostics));
    assert.equal(said[0]!.severity, 'warning');
    assert.match(said[0]!.message, new RegExp(`^orientShells: ${rows.length} shells? of solids facing the wrong `
      + 'way turned \\(row \\d: by its exact volume and point classification, volume'));
    const a = openAnalysis(new Uint8Array(h.analysis!.buffer));
    assert.deepEqual([...a.shell.turned], [0, 1].map((s) => (rows as readonly number[]).includes(s) ? 1 : 0));
    // Healing again with the same options: the same model; with orientShells off: the source back, byte for byte.
    const again = await healPart(h.model, {}, geom, undefined, h.analysis);
    assert.equal(again.model, h.model);
    const off = await healPart(h.model, { fixes: { orientShells: false } }, geom, undefined, h.analysis);
    assert.ok(same(off.model, (await healPart(d, { fixes: { orientShells: false } }, geom)).model));
    assert.deepEqual(volumes(off.model), volumes(d));
    // With healing off: the source.
    assert.ok(same((await healPart(h.model, { heal: false }, geom, undefined, h.analysis)).model, d));
  }
});

test('the analysis\'s coedge rows follow a turned shell\'s: healing again with other options as healing the source '
  + 'with them', async () => {
  // The void facing in, healed with p-curves made on its planes (their provenance and the source's none per row):
  // healed again with the defaults, the same as the source healed with the defaults.
  const d = model(true, true);
  const h = await healPart(d, { fixes: { pcurveMissingOnPlane: true } }, geom);
  const a = openAnalysis(new Uint8Array(h.analysis!.buffer));
  assert.ok([...a.coedge.pcurveFrom].some((x) => x === 3), 'p-curves made');
  const again = await healPart(h.model, {}, geom, undefined, h.analysis);
  const direct = await healPart(d, {}, geom);
  assert.ok(same(again.model, direct.model));
  assert.ok(Buffer.from(again.analysis!.buffer).equals(Buffer.from(direct.analysis!.buffer)));
});

test('the analysis\'s coedge rows follow a turned shell\'s where the source gave some p-curves and not others',
  async () => {
  // The void facing in, its planes' p-curves made (pcurveMissingOnPlane, no turning), then every other use's dropped:
  // a source with p-curves given on some uses of the turned faces' loops and not on others.
  const made = (await healPart(model(true, true), { fixes: { pcurveMissingOnPlane: true, orientShells: false } },
    geom)).model;
  const src = openBrep(new Uint8Array(made.buffer.slice(0)));
  for (let c = 0; c < src.coedge.pcurve.length; c += 2) {
    src.coedge.pcurve[c] = -1, src.coedge.range[2 * c] = NaN, src.coedge.range[2 * c + 1] = NaN;
  }
  const h = await healPart(src, { fixes: { pcurveReplace: false } }, geom);
  const ha = openAnalysis(new Uint8Array(h.analysis!.buffer));
  assert.ok(ha.shell.turned[1] === 1);
  // Each healed row's provenance its own: given exactly where its p-curve is the source's (healing made none here),
  // and the source's p-curve recorded in its row.
  for (let c = 0; c < h.model.coedge.pcurve.length; c++) {
    assert.equal(ha.coedge.pcurveFrom[c] === 1, h.model.coedge.pcurve[c]! >= 0, `row ${c}`);
    assert.equal(ha.coedge.givenPcurve[c], h.model.coedge.pcurve[c], `row ${c}`);
  }
  for (const opts of [{}, { fixes: { orientShells: false } }, { fixes: { pcurveMissingOnPlane: true } }]) {
    const again = await healPart(h.model, opts, geom, undefined, h.analysis);
    const direct = await healPart(src, opts, geom);
    assert.ok(same(again.model, direct.model), JSON.stringify(opts));
    assert.ok(Buffer.from(again.analysis!.buffer).equals(Buffer.from(direct.analysis!.buffer)), JSON.stringify(opts));
  }
});

test('a face turned whole and a shell turned in one part: the analysis\'s rows follow both', async () => {
  // The void facing in, with p-curves on every other use (as above), and an outer face's loop reversed in place.
  const made = (await healPart(model(true, true), { fixes: { pcurveMissingOnPlane: true, orientShells: false } },
    geom)).model;
  const src = openBrep(new Uint8Array(made.buffer.slice(0)));
  for (let c = 0; c < src.coedge.pcurve.length; c += 2) {
    src.coedge.pcurve[c] = -1, src.coedge.range[2 * c] = NaN, src.coedge.range[2 * c + 1] = NaN;
  }
  const f = src.faceUse.face[src.shell.first[0]!]!, l = src.face.firstLoop[f]!, a = src.loop.first[l]!;
  const n = src.loop.count[l]!;
  for (const col of [src.coedge.edge, src.coedge.orientation, src.coedge.pcurve, src.coedge.id]) {
    col.set(Array.from(col.subarray(a, a + n)).reverse(), a);
  }
  const r = Array.from(src.coedge.range.subarray(2 * a, 2 * (a + n)));
  for (let i = 0; i < n; i++) src.coedge.range.set(r.slice(2 * (n - 1 - i), 2 * (n - i)), 2 * (a + i));
  for (let c = a; c < a + n; c++) src.coedge.orientation[c] = 1 - src.coedge.orientation[c]!;
  src.shell.kind[0] = 2;
  const h = await healPart(src, { fixes: { pcurveReplace: false } }, geom);
  const ha = openAnalysis(new Uint8Array(h.analysis!.buffer));
  assert.ok(ha.face.turned[f]! & 2 && ha.shell.turned[1] === 1, 'both turned');
  for (let c = 0; c < h.model.coedge.pcurve.length; c++) {
    assert.equal(ha.coedge.pcurveFrom[c] === 1, h.model.coedge.pcurve[c]! >= 0, `row ${c}`);
    assert.equal(ha.coedge.givenPcurve[c], h.model.coedge.pcurve[c], `row ${c}`);
  }
  const off = await healPart(h.model, { fixes: { orientShells: false } }, geom, undefined, h.analysis);
  assert.ok(same(off.model, (await healPart(src, { fixes: { orientShells: false } }, geom)).model));
});

test('loops: a face wound against its neighbours turned whole, then its sense to its loops\'; a face disputed by a '
  + 'neighbour left', async () => {
  const { cube } = await import('../../cad-brep/test/models.ts');
  // The cube with face row 0's loop reversed in place (its uses' order and orientations), its sense as it was: every
  // edge it shares used the same way by a neighbour, and its loops against its sense.
  const reversed = () => {
    const d = openBrep(new Uint8Array(cube().finish().buffer.slice(0)));
    const l = d.face.firstLoop[0]!, a = d.loop.first[l]!, n = d.loop.count[l]!;
    for (const col of [d.coedge.edge, d.coedge.orientation, d.coedge.pcurve, d.coedge.id]) {
      col.set(Array.from(col.subarray(a, a + n)).reverse(), a);
    }
    for (let c = a; c < a + n; c++) d.coedge.orientation[c] = 1 - d.coedge.orientation[c]!;
    // (Its shell open by its topology now, as an import makes it.)
    d.shell.kind[0] = 2;
    return d;
  };
  const d = reversed();
  // The faces step alone: the face's neighbours dispute its loops, so it's left.
  assert.deepEqual(faceSenses(d, (f) => f === 0), { inClosed: [], inSheets: [], alone: [], disputed: [0],
    refused: [], unconfirmed: [] });
  // Healing: the face turned whole (the loops step), which leaves its loops against its sense, so then flipped
  // back (the faces step): the cube as it was, facing out; recorded as turned whole.
  const h = await healPart(d, {}, geom);
  const said = h.diagnostics.map((x) => x.message);
  assert.ok(said.some((m) => m.startsWith('orientShells: 1 face of 1 shell turned to agree with their shells\' other '
    + 'faces')), JSON.stringify(said));
  assert.ok(same(h.model, cube().finish()), 'the cube as built');
  assert.deepEqual(volumes(h.model), [1]);
  const a = openAnalysis(new Uint8Array(h.analysis!.buffer));
  assert.deepEqual([...a.face.turned].slice(0, 2), [3, 0]);
  // Healing again with orientShells off: the damaged source back.
  const off = await healPart(h.model, { fixes: { orientShells: false } }, geom, undefined, h.analysis);
  assert.ok(same(off.model, (await healPart(reversed(), { fixes: { orientShells: false } }, geom)).model));
});

test('turnShells: its own inverse; each turned face\'s sense flipped, its loops reversed and their uses flipped',
  () => {
  const d = model(true, true), t = turnShells(d, [1]);
  assert.ok(same(turnShells(t.model, [1]).model, d));
  assert.ok(!same(t.model, d));
  for (let c = 0; c < t.perm.length; c++) assert.equal(t.perm[t.perm[c]!], c);
  const f = d.faceUse.face[d.shell.first[1]!]!, l = d.face.firstLoop[f]!, a = d.loop.first[l]!, n = d.loop.count[l]!;
  assert.equal(t.model.face.sameSense[f], d.face.sameSense[f] ? 0 : 1);
  for (let i = 0; i < n; i++) {
    assert.equal(t.model.coedge.edge[a + i], d.coedge.edge[a + n - 1 - i]);
    assert.equal(t.model.coedge.orientation[a + i], 1 - d.coedge.orientation[a + n - 1 - i]!);
  }
  // The outer shell's faces untouched.
  const g = d.faceUse.face[d.shell.first[0]!]!;
  assert.equal(t.model.face.sameSense[g], d.face.sameSense[g]);
});

test('nesting: a lump inside a void faces out (two shells hold it), a void in; by depth, not by position', async () => {
  // A 6 mm box, a 4 mm void in it facing into the void, a 1 mm lump in the void: as built, nothing turned.
  const build = (lumpSense: boolean) => {
    const b = new BrepBuilder();
    const outer = box(b, [6, 6, 6]), hole = box(b, [4, 4, 4], [1, 1, 1], 1000), lump = box(b, [1, 1, 1], [2.5, 2.5,
      2.5], 2000);
    b.addItem({ kind: 'body', ref: b.addBody({ kind: 'solid', members: [{ ref: outer, sense: true },
      { ref: hole, sense: false }, { ref: lump, sense: lumpSense }] }) });
    return b.finish();
  };
  const right = build(true);
  assert.deepEqual(volumes(right), [216, -64, 1]);
  const h = await healPart(right, {}, geom);
  assert.deepEqual(volumes(h.model), [216, -64, 1]);
  assert.ok(!h.diagnostics.some((x) => x.message.startsWith('orientShells')), JSON.stringify(h.diagnostics));
  // The lump built facing in (as a void would): turned to face out.
  const wrong = build(false), w = await healPart(wrong, {}, geom);
  assert.deepEqual(volumes(wrong), [216, -64, -1]);
  assert.deepEqual(volumes(w.model), [216, -64, 1]);
});

test('faces: a face whose loops run against its sense flipped where its neighbours agree; alone, left with a note',
  async () => {
  const { cube } = await import('../../cad-brep/test/models.ts');
  // The cube with face row 0's sense flipped (its loops as they were, agreeing with its neighbours').
  const d = cube().finish();
  d.face.sameSense[0] = d.face.sameSense[0] ? 0 : 1;
  const h = await healPart(d, {}, geom);
  const said = h.diagnostics.filter((x) => x.message.includes('sense flipped'));
  assert.equal(said.length, 1, JSON.stringify(h.diagnostics));
  assert.match(said[0]!.message,
    /^orientShells: 1 face's sense flipped to their loops' .*1 in closed shells, 0 in sheets/);
  assert.equal(h.model.face.sameSense[0], cube().finish().face.sameSense[0]);
  assert.deepEqual(volumes(h.model), [1]);
  const a = openAnalysis(new Uint8Array(h.analysis!.buffer));
  assert.deepEqual([...a.face.turned], [1, 0, 0, 0, 0, 0]);
  // Healing again with orientShells off: the source back.
  const off = await healPart(h.model, { fixes: { orientShells: false } }, geom, undefined, h.analysis);
  assert.ok(same(off.model, (await healPart(d, { fixes: { orientShells: false } }, geom)).model));
  // One face on its own (a sheet of one unit square, counter-clockwise about +z), its sense against its loop (its
  // plane's normal +z, the face's sense false): no neighbour to tell, so left, noted.
  const b = new BrepBuilder();
  const surface = b.addSurface({ kind: 'plane', position: { origin: [0, 0, 0], axis: [0, 0, 1], xDir: [1, 0, 0] } });
  const P = [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0]], V = P.map((point) => b.addVertex({ point }));
  const edges = P.map((p, i) => {
    const q = P[(i + 1) % 4]!;
    const curve = b.addCurve({ kind: 'line', point: p, direction: q.map((x, k) => x - p[k]!), magnitude: 1 });
    return b.addEdge({ curve, start: V[i]!, end: V[(i + 1) % 4]!, sameSense: true });
  });
  const face = b.addFace({ surface, sameSense: false, loops: [{ kind: 'edge', bound: 'outer', sense: true,
    coedges: edges.map((edge) => ({ edge, orientation: 'forward' as const })) }], id: 77 });
  b.addItem({ kind: 'body', ref: b.addBody({ kind: 'sheet', members: [{ ref: b.addShell({ kind: 'open',
    faces: [{ face, sense: true }] }), sense: true }] }) });
  const lone = await healPart(b.finish(), {}, geom);
  assert.ok(!lone.diagnostics.some((x) => x.message.includes('sense flipped')), JSON.stringify(lone.diagnostics));
  assert.ok(lone.diagnostics.some((x) => x.severity === 'info' && x.message.startsWith('orientShells: 1 face whose '
    + 'loops run against their sense left as built (no neighbour to tell which is right): #77')),
    JSON.stringify(lone.diagnostics));
});

test('a void the volume alone says faces the wrong way: turned, with a warning that the volume decided alone', () => {
  // The void facing into the material (volume +1, inside the outer shell): with point classification unable to tell,
  // turned by the volume, said; with it answering as the volume does, turned by both.
  const d = model(true, true);
  const unsure = { side: () => ({ side: 'unknown' as const, why: 'no offset clear of the shell\'s other faces' }) };
  const alone = shellVerdicts(d, oracle, unsure as never);
  assert.deepEqual(alone.verdicts.map((v) => [v.wrong, v.by]), [[false, 'volume'], [true, 'volume']]);
  assert.ok(alone.diagnostics.some((x) => x.severity === 'warning'
    && /^orientShells: shell row 1 oriented by its exact /.test(x.message) && x.message.includes('no offset clear')),
  JSON.stringify(alone.diagnostics));
  const sure = { side: () => ({ side: 'outside' as const }) };
  const turned = shellVerdicts(d, oracle, sure as never);
  assert.deepEqual(turned.verdicts.map((v) => [v.wrong, v.by]), [[false, 'both'], [true, 'both']]);
  // The outer shell built facing in: by the volume alone, turned likewise.
  const outer = shellVerdicts(model(false, false), oracle, unsure as never);
  assert.deepEqual(outer.verdicts.map((v) => [v.wrong, v.by]), [[true, 'volume'], [false, 'volume']]);
});

test('loopWinding: the loops\' 3D winding about the face\'s normal, either sense, on planes and periodic faces; '
  + 'the faces step flips only what it confirms', async () => {
  const { cube } = await import('../../cad-brep/test/models.ts');
  const { seamCylinder } = await import('../../cad-brep/test/models.ts');
  const windings = (d: BrepData) => {
    using g = new Geometry(geom, new Uint8Array(d.buffer));
    return Array.from({ length: d.face.id.length }, (_, f) => loopWinding(g, d, f));
  };
  const flipped = (d: BrepData, faces: number[]) => {
    const m = openBrep(new Uint8Array(d.buffer.slice(0)));
    for (const f of faces) m.face.sameSense[f] = m.face.sameSense[f] ? 0 : 1;
    return m;
  };
  // The cube: every face with its sense; each one's sense flipped (its loops then against it), -1.
  const c = cube().finish();
  assert.deepEqual(windings(c), [1, 1, 1, 1, 1, 1]);
  assert.deepEqual(windings(flipped(c, [0, 1, 2, 3, 4, 5])), [-1, -1, -1, -1, -1, -1]);
  // A square with a round hole (the point not in the hole, where the loops wind 0), and a quarter of a cylinder
  // across its seam (the parity's period folded): told either sense.
  const ring = holed();
  assert.deepEqual([windings(ring), windings(flipped(ring, [0]))], [[1], [-1]]);
  const quarter = seamQuarter();
  assert.deepEqual([windings(quarter), windings(flipped(quarter, [0]))], [[1], [-1]]);
  // The same quarter, its top's p-curve given a period below the others' (the pieces jump a period): folded, told.
  const jump = seamQuarter(true);
  assert.deepEqual([windings(jump), windings(flipped(jump, [0]))], [[1], [-1]]);
  // A cone's part, apex to base, past half way round, its loop closed along the apex's pole line (its travel round
  // past half a period): told.
  const half = halfCone();
  assert.deepEqual([windings(half), windings(flipped(half, [0]))], [[1], [-1]]);
  // A cylinder's side, a band round it: seen edge-on from any point of it, so not told, either sense.
  const y = seamCylinder().finish();
  assert.deepEqual([windings(y), windings(flipped(y, [0]))], [[undefined], [undefined]]);
  // A cylinder face whose one loop runs round it once (along the bottom half way, up, along the top's other half,
  // down: Checking_Fixture_Clamping #5594's #8400): it bounds no face, so not told, either sense.
  const r = roundOnce();
  assert.deepEqual([windings(r), windings(flipped(r, [0]))], [[undefined], [undefined]]);
  // A torus band from its outer equator up to its top circle, round the axis: closed both ways, a band and its
  // complement are both bands, so not told, either sense.
  const t = torusBand();
  assert.deepEqual([windings(t), windings(flipped(t, [0]))], [[undefined], [undefined]]);
  // A ball less the cap beyond a flat (its sphere face's one loop a hole, running against the face's sense rightly):
  // not told; its flat (a plane) told.
  const { ballWithFlat } = await import('../../tess-cadio/native/test/models.ts');
  assert.deepEqual(windings(ballWithFlat().finish()), [undefined, 1]);
  // The faces step: a face the flag says is against its sense, its neighbours agreeing, isn't flipped where the
  // winding refuses or can't tell.
  const all = () => true;
  assert.deepEqual(faceSenses(c, (f) => f === 0, () => false), { inClosed: [], inSheets: [], alone: [], disputed: [],
    refused: [0], unconfirmed: [] });
  assert.deepEqual(faceSenses(c, (f) => f === 0, () => undefined), { inClosed: [], inSheets: [], alone: [],
    disputed: [], refused: [], unconfirmed: [0] });
  assert.deepEqual(faceSenses(c, (f) => f === 0, all).inClosed, [0]);
  // Healing a cylinder's side beside its bottom disk, the side's sense flipped: the flag says its loops run against
  // it and the disk agrees with them, but the side is seen edge-on, so it's left, noted.
  const { cylinderSide } = await import('./models.ts');
  const side = openBrep(new Uint8Array(cylinderSide({}, 1e-6, 0, undefined, 2, undefined, true).finish().buffer
    .slice(0)));
  side.face.sameSense[0] = 0;
  const hs = await healPart(side, {}, geom);
  assert.deepEqual(hs.diagnostics.map((x) => `${x.severity} ${x.message}`), ['info orientShells: 1 face whose loops\' '
    + 'signed sum runs against their sense left as built (their winding in 3D can\'t confirm it): #9']);
  assert.equal(hs.model.face.sameSense[0], 0);
  // Healing a cube whose face the flag would wrongly call against its sense: nothing flipped (the winding refuses).
  const h = await healPart(c, {}, geom);
  assert.ok(!h.diagnostics.some((x) => x.message.includes('sense flipped')), JSON.stringify(h.diagnostics));
});

/** A torus band (major radius 5, minor 1, about z) from its outer equator (v = 0) to its top circle (v = pi / 2). */
function torusBand(): BrepData {
  const b = new BrepBuilder();
  const axis = { origin: [0, 0, 0], axis: [0, 0, 1], xDir: [1, 0, 0] };
  const bottom = b.addCurve({ kind: 'circle', position: axis, radius: 6 });
  const top = b.addCurve({ kind: 'circle', position: { ...axis, origin: [0, 0, 1] }, radius: 5 });
  const seam = b.addCurve({ kind: 'circle', position: { origin: [5, 0, 0], axis: [0, -1, 0], xDir: [1, 0, 0] },
    radius: 1 });
  const v0 = b.addVertex({ point: [6, 0, 0] }), v1 = b.addVertex({ point: [5, 0, 1] });
  const eBottom = b.addEdge({ curve: bottom, start: v0, end: v0, sameSense: true, range: [0, 2 * Math.PI] });
  const eTop = b.addEdge({ curve: top, start: v1, end: v1, sameSense: true, range: [0, 2 * Math.PI] });
  const eSeam = b.addEdge({ curve: seam, start: v0, end: v1, sameSense: true, range: [0, Math.PI / 2] });
  const torus = b.addSurface({ kind: 'torus', position: axis, majorRadius: 5, minorRadius: 1 } as never);
  const face = b.addFace({ surface: torus, sameSense: true, loops: [{ kind: 'edge', bound: 'outer', sense: true,
    coedges: [{ edge: eBottom, orientation: 'forward' }, { edge: eSeam, orientation: 'forward' },
      { edge: eTop, orientation: 'reversed' }, { edge: eSeam, orientation: 'reversed' }] }], id: 9 });
  b.addItem({ kind: 'body', ref: b.addBody({ kind: 'sheet', members: [{ ref: b.addShell({ kind: 'open',
    faces: [{ face, sense: true }] }), sense: true }] }) });
  return b.finish();
}

/** A cylinder (radius 2 about z) face of one loop that runs round it once: z = 0 from 0 to pi, up, z = 5 on to 2 pi. */
function roundOnce(): BrepData {
  const b = new BrepBuilder();
  const axis = { origin: [0, 0, 0], axis: [0, 0, 1], xDir: [1, 0, 0] };
  const bottom = b.addCurve({ kind: 'circle', position: axis, radius: 2 });
  const top = b.addCurve({ kind: 'circle', position: { ...axis, origin: [0, 0, 5] }, radius: 2 });
  const at0 = b.addCurve({ kind: 'line', point: [2, 0, 0], direction: [0, 0, 1], magnitude: 1 });
  const atPi = b.addCurve({ kind: 'line', point: [-2, 0, 0], direction: [0, 0, 1], magnitude: 1 });
  const [b0, bPi, t0, tPi] = [[2, 0, 0], [-2, 0, 0], [2, 0, 5], [-2, 0, 5]].map((point) => b.addVertex({ point }));
  const eBottom = b.addEdge({ curve: bottom, start: b0!, end: bPi!, sameSense: true, range: [0, Math.PI] });
  const eUp = b.addEdge({ curve: atPi, start: bPi!, end: tPi!, sameSense: true, range: [0, 5] });
  const eTop = b.addEdge({ curve: top, start: tPi!, end: t0!, sameSense: true, range: [Math.PI, 2 * Math.PI] });
  const eDown = b.addEdge({ curve: at0, start: b0!, end: t0!, sameSense: true, range: [0, 5] });
  const cylinder = b.addSurface({ kind: 'cylinder', position: axis, radius: 2 });
  const face = b.addFace({ surface: cylinder, sameSense: true, loops: [{ kind: 'edge', bound: 'outer', sense: true,
    coedges: [{ edge: eBottom, orientation: 'forward' }, { edge: eUp, orientation: 'forward' },
      { edge: eTop, orientation: 'forward' }, { edge: eDown, orientation: 'reversed' }] }], id: 9 });
  b.addItem({ kind: 'body', ref: b.addBody({ kind: 'sheet', members: [{ ref: b.addShell({ kind: 'open',
    faces: [{ face, sense: true }] }), sense: true }] }) });
  return b.finish();
}

/** The square [-2, 2]^2 in z = 0 (normal +z), a hole of radius 1 at its centre. */
function holed(): BrepData {
  const b = new BrepBuilder();
  const axis = { origin: [0, 0, 0], axis: [0, 0, 1], xDir: [1, 0, 0] };
  const P = [[-2, -2, 0], [2, -2, 0], [2, 2, 0], [-2, 2, 0]], V = P.map((point) => b.addVertex({ point }));
  const sides = P.map((p, i) => {
    const q = P[(i + 1) % 4]!;
    const curve = b.addCurve({ kind: 'line', point: p, direction: q.map((x, k) => (x - p[k]!) / 4), magnitude: 1 });
    return b.addEdge({ curve, start: V[i]!, end: V[(i + 1) % 4]!, sameSense: true, range: [0, 4] });
  });
  const v = b.addVertex({ point: [1, 0, 0] });
  const hole = b.addEdge({ curve: b.addCurve({ kind: 'circle', position: axis, radius: 1 }), start: v, end: v,
    sameSense: true, range: [0, 2 * Math.PI] });
  const face = b.addFace({ surface: b.addSurface({ kind: 'plane', position: axis }), sameSense: true, loops: [
    { kind: 'edge', bound: 'outer', sense: true,
      coedges: sides.map((edge) => ({ edge, orientation: 'forward' as const })) },
    { kind: 'edge', bound: 'inner', sense: true, coedges: [{ edge: hole, orientation: 'reversed' }] }] });
  b.addItem({ kind: 'body', ref: b.addBody({ kind: 'sheet', members: [{ ref: b.addShell({ kind: 'open',
    faces: [{ face, sense: true }] }), sense: true }] }) });
  return b.finish();
}

/**
 * A quarter of a cylinder (radius 2 about z, z from 0 to 5) from -pi / 4 to pi / 4, across its seam at u = 0; `jump`
 * gives p-curves, the bottom's and the sides' at u from 7 pi / 4 to 9 pi / 4, the top's a period below.
 */
function seamQuarter(jump = false): BrepData {
  const b = new BrepBuilder();
  const axis = { origin: [0, 0, 0], axis: [0, 0, 1], xDir: [1, 0, 0] };
  const c = Math.SQRT2;
  const bottom = b.addCurve({ kind: 'circle', position: axis, radius: 2 });
  const top = b.addCurve({ kind: 'circle', position: { ...axis, origin: [0, 0, 5] }, radius: 2 });
  const [b0, b1, t0, t1] = [[c, -c, 0], [c, c, 0], [c, -c, 5], [c, c, 5]].map((point) => b.addVertex({ point }));
  const line = (p: number[]) => b.addCurve({ kind: 'line', point: p, direction: [0, 0, 1], magnitude: 1 });
  const eBottom = b.addEdge({ curve: bottom, start: b0!, end: b1!, sameSense: true,
    range: [7 * Math.PI / 4, 9 * Math.PI / 4] });
  const eTop = b.addEdge({ curve: top, start: t0!, end: t1!, sameSense: true,
    range: [7 * Math.PI / 4, 9 * Math.PI / 4] });
  const eRight = b.addEdge({ curve: line([c, c, 0]), start: b1!, end: t1!, sameSense: true, range: [0, 5] });
  const eLeft = b.addEdge({ curve: line([c, -c, 0]), start: b0!, end: t0!, sameSense: true, range: [0, 5] });
  const l2 = (point: number[], direction: number[]) => jump ? b.addCurve({ kind: 'line', point, direction,
    magnitude: 1 }) : undefined;
  const P = Math.PI;
  const face = b.addFace({ surface: b.addSurface({ kind: 'cylinder', position: axis, radius: 2 }), sameSense: true,
    loops: [{ kind: 'edge', bound: 'outer', sense: true, coedges: [
      { edge: eBottom, orientation: 'forward', pcurve: l2([0, 0], [1, 0]) },
      { edge: eRight, orientation: 'forward', pcurve: l2([9 * P / 4, 0], [0, 1]) },
      { edge: eTop, orientation: 'reversed', pcurve: l2([-2 * P, 5], [1, 0]) },
      { edge: eLeft, orientation: 'reversed', pcurve: l2([7 * P / 4, 0], [0, 1]) }] }] });
  b.addItem({ kind: 'body', ref: b.addBody({ kind: 'sheet', members: [{ ref: b.addShell({ kind: 'open',
    faces: [{ face, sense: true }] }), sense: true }] }) });
  return b.finish();
}

/** A cone (apex (0, 0, -1), base the unit circle in z = 0) from u = 0 to 1.1 pi: two generators and the base. */
function halfCone(): BrepData {
  const b = new BrepBuilder(), a = 1.1 * Math.PI;
  const axis = { origin: [0, 0, 0], axis: [0, 0, 1], xDir: [1, 0, 0] };
  const apex = b.addVertex({ point: [0, 0, -1] }), v0 = b.addVertex({ point: [1, 0, 0] });
  const vPi = b.addVertex({ point: [Math.cos(a), Math.sin(a), 0] });
  const generator = (u: number, end: number) => b.addEdge({ curve: b.addCurve({ kind: 'line', point: [0, 0, -1],
    direction: [Math.cos(u) * Math.SQRT1_2, Math.sin(u) * Math.SQRT1_2, Math.SQRT1_2], magnitude: 1 }), start: apex,
    end, sameSense: true, range: [0, Math.SQRT2] });
  const g0 = generator(0, v0), gPi = generator(a, vPi);
  const base = b.addEdge({ curve: b.addCurve({ kind: 'circle', position: axis, radius: 1 }), start: v0, end: vPi,
    sameSense: true, range: [0, a] });
  const face = b.addFace({ surface: b.addSurface({ kind: 'cone', position: axis, radius: 1, semiAngle: Math.PI / 4 }),
    sameSense: true, loops: [{ kind: 'edge', bound: 'outer', sense: true, coedges: [
      { edge: gPi, orientation: 'forward' }, { edge: base, orientation: 'reversed' },
      { edge: g0, orientation: 'reversed' }] }] });
  b.addItem({ kind: 'body', ref: b.addBody({ kind: 'sheet', members: [{ ref: b.addShell({ kind: 'open',
    faces: [{ face, sense: true }] }), sense: true }] }) });
  return b.finish();
}
