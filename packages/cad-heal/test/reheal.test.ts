import assert from 'node:assert/strict';
import test from 'node:test';
import { analysisFor, analysisRowCount, type BrepAnalysis, type BrepData, CURVE_KIND, rowCount } from 'cad-brep';
import { init } from 'cad-geom';
import type { Scene } from 'cad-scene';
import { ModelEdit } from '../src/edit.ts';
import { compactCurves, fixesMask, HEAL_FIXES, HEAL_VERSION, healPart, healScene, type HealOptions } from
  '../src/index.ts';
import { bsplineCylinder, cylinderSide, line2, strayPole } from './models.ts';

const module = await init();
const TWO_PI = 2 * Math.PI;

// Models on which each fix acts (and some on which several do), and option sets that heal them differently.
const MODELS: Record<string, () => BrepData> = {
  // pcurveReplace: the bottom circle's p-curve off by half a unit in v.
  replaced: () => cylinderSide({ bottom: { pcurve: line2([0, 0.5], [1, 0]), range: [0, TWO_PI] } }).finish(),
  // pcurveReparam: the bottom's p-curve by a fraction of the turn.
  reparam: () => cylinderSide({ bottom: { pcurve: line2([0, 0], [1, 0], TWO_PI), range: [0, 1] } }).finish(),
  // pcurveMissingOnFreeForm: a B-spline cylinder's circles bare.
  bare: () => bsplineCylinder(line2([1, 0], [0, 1])).finish(),
  // edgeTolerance's trace: the bottom circle 0.05 off its B-spline, bare.
  traced: () => bsplineCylinder(line2([1, 0], [0, 1]), undefined, 2.05).finish(),
  // pcurveMissingOnPlane, pcurveEnds and vertexTolerance: a disk under a side whose bottom circle and vertex are off
  // it, its seam's p-curves at x = 2.
  disk: () => cylinderSide({}, 1e-6, 0, undefined, 2.05, undefined, true).finish(),
};
const SETS: Record<string, HealOptions> = {
  defaults: {},
  allOn: { fixes: { pcurveMissingOnPlane: true, pcurveMissingOnElementary: true, pcurveMissingOnFreeForm: true } },
  freeForm: { fixes: { pcurveMissingOnFreeForm: true } },
  elementary: { fixes: { pcurveMissingOnElementary: true } },
  onPlane: { fixes: { pcurveMissingOnPlane: true } },
  coarse: { fixes: { pcurveMissingOnFreeForm: true }, pcurveFitTolerance: 0.01 },
  fine: { fixes: { pcurveMissingOnFreeForm: true }, pcurveFitTolerance: 1e-5 },
  fewer: { fixes: { pcurveReplace: false, pcurveReparam: false, vertexTolerance: false } },
  tolerancesOff: { fixes: { edgeTolerance: false, vertexTolerance: false, pcurveEnds: false } },
};

const bytes = (x: { buffer: ArrayBuffer }) => new Uint8Array(x.buffer);
const said = (r: { diagnostics: { message: string }[] }) => r.diagnostics.map((d) => d.message);

/** The curve rows from `from` on that no coedge references (healing's rows nothing uses). */
function unreferenced(m: BrepData, from: number): number[] {
  const used = new Set(m.coedge.pcurve);
  return Array.from({ length: rowCount(m, 'curve') - from }, (_, i) => from + i).filter((k) => !used.has(k));
}

/** healPart on a healed result, with its analysis. */
const again = (h: { model: BrepData; analysis?: BrepAnalysis }, o: HealOptions) =>
  healPart(h.model, o, module, undefined, h.analysis);

for (const [name, make] of Object.entries(MODELS)) {
  test(`${name}: healing a healed model with other options gives what healing the source with them does, byte for `
    + 'byte, model and analysis, and says the same; with the same options, nothing changed or said', async () => {
    const m = make(), once: Record<string, Awaited<ReturnType<typeof healPart>>> = {};
    for (const [k, o] of Object.entries(SETS)) once[k] = await healPart(m, o, module);
    // The fixture acts: some sets change it, and not all alike.
    assert.ok(Object.values(once).some((h) => h.changed), 'some set changes it');
    assert.ok(new Set(Object.values(once).map((h) => bytes(h.model).join())).size > 1, 'the sets heal it differently');
    for (const [A, a] of Object.entries(once)) {
      for (const [B, b] of Object.entries(once)) {
        const twice = await again(a, SETS[B]!), what = `h(h(m, ${A}), ${B})`;
        if (A === B) {
          assert.equal(twice.model, a.model, `${what}: the model given back`);
          assert.equal(twice.analysis, a.analysis, `${what}: its analysis given back`);
          assert.equal(twice.changed, false, what);
          assert.deepEqual(twice.diagnostics, [], `${what}: nothing said`);
          continue;
        }
        assert.deepEqual(bytes(twice.model), bytes(b.model), `${what}: the model is h(m, ${B})'s`);
        assert.deepEqual(bytes(twice.analysis!), bytes(b.analysis!), `${what}: the analysis is h(m, ${B})'s`);
        assert.deepEqual(said(twice), said(b), `${what}: says what h(m, ${B}) does`);
        assert.equal(twice.changed, bytes(twice.model).join() !== bytes(a.model).join(), `${what}: changed`);
        assert.deepEqual(unreferenced(twice.model, rowCount(m, 'curve')), [], `${what}: no unreferenced rows`);
      }
    }
  });
}

test('a model healed again and again with options in turn is no larger than healing its source with the last',
  async () => {
  for (const [name, make] of Object.entries(MODELS)) {
    const m = make(), order = Object.keys(SETS);
    let h = await healPart(m, SETS[order[0]!]!, module);
    for (let i = 1; i < 3 * order.length; i++) {
      h = await again(h, SETS[order[i % order.length]!]!);
      assert.deepEqual(unreferenced(h.model, rowCount(m, 'curve')), [], `${name}, heal ${i}`);
    }
    const last = await healPart(m, SETS[order[(3 * order.length - 1) % order.length]!]!, module);
    assert.equal(h.model.buffer.byteLength, last.model.buffer.byteLength, name);
    assert.deepEqual(bytes(h.model), bytes(last.model), name);
  }
});

test('the source\'s p-curve a fix replaced stays in the healed model, the analysis\'s givenPcurve, so live',
  async () => {
  const m = MODELS.replaced!(), r = await healPart(m, {}, module);
  const a = await analysisFor(r.model, r.analysis!);
  assert.notEqual(r.model.coedge.pcurve[0], m.coedge.pcurve[0], 'replaced');
  assert.equal(a.coedge.givenPcurve[0], m.coedge.pcurve[0]);
  assert.deepEqual([...a.coedge.givenPcurve], [...m.coedge.pcurve]);
  assert.deepEqual([...a.coedge.givenRange], [...m.coedge.range]);
  assert.deepEqual([...a.edge.givenRange], [...m.edge.range]);
  assert.equal(rowCount(r.model, 'curve'), rowCount(m, 'curve') + 1, 'the source\'s rows and the replacement');
  assert.deepEqual([a.healing.fixes[0], a.healing.version[0], a.healing.sourceCurves[0]],
    [fixesMask(HEAL_FIXES.filter((f) => !f.startsWith('pcurveMissing'))), HEAL_VERSION, rowCount(m, 'curve')]);
});

test('strayPole\'s moved poles stay moved when healed again, with it off or on, said as kept; all else as healing '
  + 'the source', async () => {
  const m = strayPole().finish(), off = { fixes: { strayPole: false } }, other = { fixes: { pcurveReplace: false } };
  const a = await healPart(m, {}, module), b = await healPart(m, off, module), twice = await again(a, off);
  const n = (await analysisFor(a.model, a.analysis!)).healing.strayPoles[0]!;
  assert.ok(n > 0 && said(a).some((x) => x.startsWith(`strayPole: ${n} poles`)), 'moved, counted');
  assert.notDeepEqual([...twice.model.pool.curveReal], [...b.model.pool.curveReal], 'the poles as a left them');
  assert.deepEqual([...twice.model.pool.curveReal], [...a.model.pool.curveReal]);
  assert.deepEqual([...twice.model.coedge.pcurve], [...b.model.coedge.pcurve]);
  const t = await analysisFor(twice.model, twice.analysis!);
  assert.deepEqual([...t.edge.givenTolerance], [...m.edge.tolerance], 'grown from the source\'s tolerances');
  assert.equal(t.healing.strayPoles[0], n, 'still counted');
  const keptSaid = `strayPole: ${n} stray poles moved by an earlier healing kept`;
  assert.deepEqual(said(twice).filter((x) => x.startsWith('strayPole')), [keptSaid], 'said as kept, off');
  // strayPole on again (another fix off): the model and analysis as healing the source, the poles said as kept.
  const on = await again(a, other), direct = await healPart(m, other, module);
  assert.deepEqual(bytes(on.model), bytes(direct.model));
  assert.deepEqual(bytes(on.analysis!), bytes(direct.analysis!));
  assert.deepEqual(said(on).filter((x) => x.startsWith('strayPole')), [keptSaid], 'said as kept, on');
  assert.deepEqual(said(on).filter((x) => !x.startsWith('strayPole')),
    said(direct).filter((x) => !x.startsWith('strayPole')), 'the rest said as healing the source');
  // The same options again: given back, nothing said.
  assert.deepEqual(said(await again(twice, off)), []);
});

test('a healed model healed again by another HEAL_VERSION, or with an analysis not saying it was healed: healed again '
  + 'from the source\'s values, or as a source', async () => {
  const m = MODELS.traced!(), h = await healPart(m, {}, module);
  // Another version's healing row: not taken as healed by these options.
  const old = new Uint8Array(h.analysis!.buffer.slice(0));
  const { openAnalysis } = await import('cad-brep');
  const a = openAnalysis(old);
  a.healing.version[0] = HEAL_VERSION + 1;
  const r = await healPart(h.model, {}, module, undefined, a);
  assert.deepEqual(bytes(r.model), bytes(h.model), 'the same model');
  assert.deepEqual(said(r), said(h), 'healed again, so said again');
});

test('an analysis of another model is the caller\'s bug: a throw', async () => {
  const h = await healPart(MODELS.traced!(), {}, module);
  await assert.rejects(healPart(MODELS.bare!(), {}, module, undefined, h.analysis), /an analysis of another model/);
});

test('healScene heals a healed scene again from its parts\' analyses: as healing the source with the options',
  async () => {
  const m = MODELS.bare!(), scene = { parts: [{ brep: { model: m, format: 'step' }, sources: [] }], diagnostics: [] };
  await healScene(scene as unknown as Scene, SETS.freeForm!, module);
  assert.notEqual(scene.parts[0]!.brep.model, m, 'p-curves made');
  await healScene(scene as unknown as Scene, SETS.defaults!, module);
  assert.deepEqual(bytes(scene.parts[0]!.brep.model), bytes(m), 'bare again: the source');
});

test('healing off on a healed model: the source as it was, but for moved poles (said kept), an analysis of the '
  + 'healing row alone; healing it again as healing the source', async () => {
  for (const [name, make] of Object.entries(MODELS)) {
    const m = make(), a = await healPart(m, {}, module), off = await again(a, { heal: false });
    assert.deepEqual(bytes(off.model), bytes(m), `${name}: the source`);
    assert.equal(off.changed, a.changed, `${name}: changed where healing had changed it`);
    const t = await analysisFor(off.model, off.analysis!);
    assert.deepEqual([analysisRowCount(t, 'healing'), t.healing.fixes[0], analysisRowCount(t, 'coedge')], [1, 0, 0]);
    assert.deepEqual(said(off), [], `${name}: nothing said`);
    const back = await again(off, SETS.allOn!), direct = await healPart(m, SETS.allOn!, module);
    assert.deepEqual(bytes(back.model), bytes(direct.model), `${name}: healed again`);
    assert.deepEqual(bytes(back.analysis!), bytes(direct.analysis!), `${name}: its analysis`);
    assert.deepEqual(said(back), said(direct), name);
    const offAgain = await again(off, { heal: false });
    assert.equal(offAgain.model, off.model, `${name}: off again, given back`);
    assert.deepEqual(said(offAgain), []);
  }
  const m = strayPole().finish(), a = await healPart(m, {}, module), off = await again(a, { heal: false });
  assert.deepEqual([...off.model.pool.curveReal], [...a.model.pool.curveReal], 'the poles kept');
  assert.match(said(off).join(), /^strayPole: \d+ stray poles moved by an earlier healing kept$/);
  assert.match(said(await again(off, {})).join('\n'), /^strayPole: \d+ stray poles moved by an earlier healing kept/,
    'healed again: still said');
  // A model never healed, healing off, its analysis none: as it is.
  assert.equal((await healPart(m, { heal: false }, module)).model, m);
});

test('healScene with healing off puts back the parts healed before, the others as they are', async () => {
  const healed = MODELS.bare!(), plain = MODELS.replaced!();
  const scene = { parts: [{ brep: { model: healed, format: 'step' }, sources: [] },
    { brep: { model: plain, format: 'step' }, sources: [] }], diagnostics: [] };
  await healScene({ ...scene, parts: [scene.parts[0]!] } as unknown as Scene, SETS.allOn!, module);
  assert.notEqual(scene.parts[0]!.brep.model, healed);
  await healScene(scene as unknown as Scene, { heal: false }, module);
  assert.deepEqual(bytes(scene.parts[0]!.brep.model), bytes(healed), 'the healed part its source');
  assert.equal(scene.parts[1]!.brep.model, plain, 'the other as it was');
});

test('compactCurves: healing\'s rows nothing references dropped, the rest renumbered with their pool data, a '
  + 'trimmed curve\'s basis too; the source\'s rows kept whatever references them', () => {
  const m = cylinderSide().finish(), n = rowCount(m, 'curve'), e = new ModelEdit(m);
  const dead = e.addCurve2({ kind: CURVE_KIND.polyline, reals: [9, 9, 8, 8], ints: [2] });
  const basis = e.addCurve2({ kind: CURVE_KIND.polyline, reals: [0, 0.25, 1, 0.25], ints: [2] });
  const trimmed = e.addCurve2({ kind: CURVE_KIND.trimmed, reals: [0, TWO_PI, NaN, NaN, NaN, NaN],
    ints: [basis, 1, 1] });
  e.set('coedge', 'pcurve', 0, trimmed);
  // The source's first p-curve no longer referenced by a coedge: kept (its row is the source's).
  const was = m.coedge.pcurve[0]!, x = compactCurves(e.finish(), n);
  assert.equal(dead, n);
  assert.equal(rowCount(x, 'curve'), n + 2);
  assert.equal(x.coedge.pcurve[0], n + 1, 'the trimmed curve renumbered');
  assert.equal(x.pool.curveInt[x.curve.int[n + 1]!], n, 'its basis renumbered');
  assert.deepEqual([...x.pool.curveReal.subarray(x.curve.real[n]!, x.curve.real[n]! + 4)], [0, 0.25, 1, 0.25]);
  assert.equal(x.pool.curveInt[x.curve.int[n]!], 2, 'the basis\'s ints');
  assert.deepEqual([...x.pool.curveReal.subarray(x.curve.real[n + 1]!)], [0, TWO_PI, NaN, NaN, NaN, NaN],
    'the trimmed curve\'s reals, the dropped row\'s gone');
  assert.deepEqual([...x.pool.curveInt.subarray(x.curve.int[n + 1]!)], [n, 1, 1], 'its ints');
  assert.equal(x.pool.curveInt.length, m.pool.curveInt.length + 4);
  assert.equal(x.curve.kind[was], m.curve.kind[was], 'the source\'s row kept');
  assert.deepEqual([...x.pool.curveReal.subarray(0, m.pool.curveReal.length)], [...m.pool.curveReal]);
  assert.equal(compactCurves(x, n), x, 'nothing more to drop: the model itself');
  assert.equal(compactCurves(m, n), m, 'no rows of healing\'s');
});
