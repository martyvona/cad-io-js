// CadioTessellator on cad-brep's test models through the WebAssembly module (build.sh module; skipped where it isn't
// built): the result's shape as cad-scene's other backends give it, closed where the model is (cad-scene's
// openEdges), faces cad-geom can't mesh reported, positions minus the origin, normals finite and unit, the same bytes
// twice in one instance and in fresh ones.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { openEdges, oracleMeasures, type TessellationProgress, type TessellationResult } from 'cad-scene';
import { MODELS } from '../../cad-brep/test/models.ts';
import { CadioTessellator, INSERTED_HEAD, INSERTED_KINDS, progressReporter, VERSION } from '../src/index.ts';
import { affineFeetOff, bentApex, bsplineApexHole, bsplineDome, bumpPatch, cap, fold, halfCap, knotAtEnd, loopless,
  luneOnSeam, luneQuarter, meridianHemisphere, seamByInversion, seamFlipped, torusOuterHalf, uFold }
  from '../native/test/models.ts';

const dist = path.join(import.meta.dirname, '..', 'dist', 'tess_cadio.wasm');
const skip = fs.existsSync(dist) ? false : 'tess-cadio\'s module not built (run packages/tess-cadio/build.sh module)';
const pkg = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '..', 'package.json'), 'utf8')) as
  { version: string; license: string };

async function tessellator(): Promise<CadioTessellator> {
  const t = new CadioTessellator();
  await t.init();
  return t;
}
const req = (name: keyof typeof MODELS, extra: object = {}) => ({ format: 'cad-brep' as const,
  data: new Uint8Array(MODELS[name]().finish().buffer), linearDeflection: 0.01, angularDeflection: 0.26,
  edges: true, ...extra });
/** Each face range's triangles' area, by its id. */
function areas(r: TessellationResult): Map<number | null, number> {
  const out = new Map<number | null, number>(), p = r.positions;
  for (const f of r.faces) {
    let a = 0;
    for (let t = f.start; t < f.start + f.count; t += 3) {
      const [i, j, k] = [r.indices[t]! * 3, r.indices[t + 1]! * 3, r.indices[t + 2]! * 3];
      const u = [p[j]! - p[i]!, p[j + 1]! - p[i + 1]!, p[j + 2]! - p[i + 2]!];
      const v = [p[k]! - p[i]!, p[k + 1]! - p[i + 1]!, p[k + 2]! - p[i + 2]!];
      a += 0.5 * Math.hypot(u[1]! * v[2]! - u[2]! * v[1]!, u[2]! * v[0]! - u[0]! * v[2]!,
        u[0]! * v[1]! - u[1]! * v[0]!);
    }
    out.set(f.entityId, (out.get(f.entityId) ?? 0) + a);
  }
  return out;
}
const bytes = (r: TessellationResult) => JSON.stringify([Array.from(r.positions), Array.from(r.normals ?? []),
  Array.from(r.indices), r.faces, r.edges, Array.from(r.edgePositions ?? []), r.diagnostics]);

test('info: the workspace version and the module\'s hash, AGPL-3.0-only, cad-brep only', { skip }, async () => {
  assert.equal(VERSION, pkg.version);
  const t = await tessellator();
  assert.match(t.info.version, new RegExp(`^${pkg.version.replace(/\./g, '\\.')}, wasm [0-9a-f]{12}$`));
  assert.equal(t.info.license, 'AGPL-3.0-only');
  assert.equal(t.info.license, pkg.license);
  assert.deepEqual(t.info.formats, ['cad-brep']);
  await assert.rejects(t.tessellate({ ...req('cube'), format: 'step' }), /isn't taken/);
});

test('closed models: every face meshed to its area, no open edge, every edge shared at its dihedral', { skip },
  async () => {
  const t = await tessellator();
  // (reversedUses: faces built inside out and used reversed, their sense false.)
  for (const name of ['cube', 'withVoid', 'reversedUses'] as const) {
    const d = MODELS[name]().finish();
    const r = await t.tessellate(req(name));
    assert.deepEqual(r.diagnostics, [], name);
    assert.ok(r.faces.length > 0 && r.faces.every((f) => f.count > 0), name);
    assert.equal(r.faces.reduce((n, f) => n + f.count, 0), r.indices.length);
    const { open, unjudged } = openEdges(d, r);
    assert.deepEqual(open, [], name);
    assert.deepEqual(unjudged, [], name);
    assert.ok(r.edges!.length > 0 && r.edges!.every((e) => e.kind === 'shared'), name);
    for (const e of r.edges!) assert.ok(Math.abs(e.dihedral! - Math.PI / 2) < 1e-6, `${name}: ${e.dihedral}`);
    // Each face's triangles' area its own, by cad-scene's area oracle (planes: exact).
    const got = areas(r);
    for (const o of oracleMeasures(d)) assert.ok(Math.abs(got.get(o.entityId)! - o.area) < 1e-6 * o.area, name);
  }
});

test('a fold of two planes, one built facing down with its sense false: both up, the dihedral 45 degrees', { skip },
  async () => {
    const t = await tessellator();
    const r = await t.tessellate({ ...req('cube'), data: new Uint8Array(fold().finish().buffer) });
    assert.deepEqual(r.diagnostics, []);
    const shared = r.edges!.filter((e) => e.kind === 'shared');
    assert.equal(shared.length, 1);
    assert.ok(Math.abs(shared[0]!.dihedral! - Math.PI / 4) < 1e-6, String(shared[0]!.dihedral));
    // Both faces' normals up (+z component), as their senses say.
    for (let i = 2; i < r.normals!.length; i += 3) assert.ok(r.normals![i]! > 0.5);
  });

test('a model without ids: faces and edges with null entityIds, still meshed', { skip }, async () => {
  const t = await tessellator();
  const r = await t.tessellate(req('withoutIds'));
  assert.ok(r.faces.some((f) => f.entityId === null && f.count > 0));
  assert.ok(r.faces.some((f) => f.entityId !== null && f.count > 0));
  assert.ok(r.edges!.some((e) => e.entityId === null));
  assert.ok(!r.faces.some((f) => f.entityId === 0) && !r.edges!.some((e) => e.entityId === 0));
});

test('the seam cylinder: its seam a seam; a sphere\'s faces: the whole one (no loops) and the hemisphere meshed',
  { skip },
  async () => {
    const t = await tessellator();
    const c = await t.tessellate(req('seamCylinder'));
    assert.deepEqual(c.diagnostics, []);
    const kinds = c.edges!.map((e) => e.kind).sort();
    assert.deepEqual(kinds, ['free', 'free', 'seam']);
    const s = await t.tessellate(req('spheres'));
    assert.equal(s.faces.length, 2);
    assert.ok(s.faces[0]!.count > 0);
    assert.ok(s.faces[1]!.count > 0);
    assert.ok(!s.diagnostics.some((x) => x.severity === 'error'), JSON.stringify(s.diagnostics));
    for (const r of [c, s]) {
      for (let i = 0; i < r.normals!.length; i += 3) {
        const n = Math.hypot(r.normals![i]!, r.normals![i + 1]!, r.normals![i + 2]!);
        assert.ok(Math.abs(n - 1) < 1e-6, `normal ${i / 3}: ${n}`);
      }
    }
  });

test('triangles still refused counted, those in a pole\'s fan apart: none at poles made as fans; ' +
  'a lune\'s, unfanned; a cylinder\'s',
  { skip }, async () => {
    const t = await tessellator();
    const re = /^(\d+) faces meshed with triangles their criteria still refuse: (\d+) triangles, (\d+) of them slivers/;
    const refused = async (model: { finish(): { buffer: ArrayBuffer } }, l: number, a: number) => {
      const r = await t.tessellate({ ...req('cube'), data: new Uint8Array(model.finish().buffer),
        linearDeflection: l, angularDeflection: a });
      return r.diagnostics.map((x) => re.exec(x.message)).find((m) => m);
    };
    // Faces through, round or at their poles, at settings that refused triangles in poles' fans before they were
    // made as fans: none there now.
    for (const [name, model] of [['halfCap', halfCap], ['luneQuarter', luneQuarter],
      ['meridianHemisphere', meridianHemisphere], ['cap', cap]] as const) {
      for (const [l, a] of [[0.01, 0.05], [0.001, 0.05], [0.001, 0.1]] as const) {
        const c = await refused(model(), l, a);
        assert.equal(c?.[3] ?? '0', '0', `${name} at ${l}, ${a}: ${c?.[2]} refused, ${c?.[3]} at a pole`);
      }
    }
    // luneOnSeam, with no p-curves, by inversion left its seam's side unsettled (no fan made on a guess); projected,
    // the side is the rule's (seamUseTakesTwin): settled, fanned, none refused at its poles, no unsettled seam.
    const r = await t.tessellate({ ...req('cube'), data: new Uint8Array(luneOnSeam().finish().buffer),
      linearDeflection: 0.01, angularDeflection: 0.05 });
    const l = r.diagnostics.map((x) => re.exec(x.message)).find((m) => m);
    assert.equal(l?.[3] ?? '0', '0', `${l?.[2]} refused, ${l?.[3]} at a pole`);
    assert.ok(!r.diagnostics.some((x) => /seam whose side/.test(x.message)));
    // By inversion (projection off), luneOnSeam's seam side is unsettled, no fan made: its pole's refused triangles,
    // the mesher's own, counted as at the pole (at 0.02 rad: at 0.05 its uses traced sample by sample leave none).
    const inverting = new CadioTessellator();
    await inverting.init({ projectMissingPcurves: false });
    const ri = await inverting.tessellate({ ...req('cube'), data: new Uint8Array(luneOnSeam().finish().buffer),
      linearDeflection: 0.01, angularDeflection: 0.02 });
    const li = ri.diagnostics.map((x) => re.exec(x.message)).find((m) => m);
    assert.ok(li, JSON.stringify(ri.diagnostics));
    assert.ok(Number(li[3]) >= 1 && Number(li[3]) <= Number(li[2]), `${li[2]} refused, ${li[3]} at a pole`);
    assert.ok(ri.diagnostics.some((x) => /seam whose side in \(u, v\) their neighbours didn't settle/.test(x.message)));
    // bsplineApexHole's at 1e-3 mm and 0.1 rad: refused, none in a pole's fan (kept: past the deflection, the
    // default would fail the face, maxDeviationFactor).
    const keeping = new CadioTessellator();
    await keeping.init({ maxDeviationFactor: 0 });
    const ro = await keeping.tessellate({ ...req('cube'), data: new Uint8Array(bsplineApexHole().finish().buffer),
      linearDeflection: 1e-3, angularDeflection: 0.1 });
    const o = ro.diagnostics.map((x) => re.exec(x.message)).find((m) => m);
    assert.ok(o);
    assert.ok(Number(o[2]) >= 1);
    assert.equal(o[3], '0');
  });

test('init({maxDeviationFactor}): a face left farther from its surface than that x the deflection fails; 0 never',
  { skip }, async () => {
    // bsplineApexHole at 1e-3 mm and 0.1 rad keeps refused triangles: a factor of 1e-6 fails its face (the failed
    // faces' diagnostic, no triangles for it), 0 keeps it as meshed.
    const data = new Uint8Array(bsplineApexHole().finish().buffer);
    const run = async (factor: number) => {
      const t = new CadioTessellator();
      await t.init({ maxDeviationFactor: factor });
      return t.tessellate({ ...req('cube'), data, linearDeflection: 1e-3, angularDeflection: 0.1 });
    };
    const strict = await run(1e-6), never = await run(0);
    const failed = (r: TessellationResult) => r.diagnostics.some((x) => /faces failed to mesh/.test(x.message));
    assert.ok(failed(strict), JSON.stringify(strict.diagnostics));
    assert.ok(!failed(never), JSON.stringify(never.diagnostics));
    assert.ok(strict.indices.length < never.indices.length);
  });

test('init({maxPointsPerFace}): a face that reaches it fails, said as capped, not as an unsettled seam', { skip },
  async () => {
  const t = new CadioTessellator();
  await t.init({ maxPointsPerFace: 20, maxDeviationFactor: 0 });
  const r = await t.tessellate({ ...req('spheres'), linearDeflection: 1e-3 });
  assert.ok(r.diagnostics.some((x) => /^\d+ faces failed with refinement stopped at their point cap$/.test(x.message)),
    JSON.stringify(r.diagnostics));
  assert.ok(r.diagnostics.some((x) => x.severity === 'error' && /faces failed to mesh/.test(x.message)));
  assert.ok(!r.diagnostics.some((x) => /seam whose side/.test(x.message)));
  const u = new CadioTessellator();
  await u.init();
  const ru = await u.tessellate({ ...req('spheres'), linearDeflection: 1e-3 });
  assert.ok(!ru.diagnostics.some((x) => /point cap/.test(x.message)));
});

test('init({minAngle}): the mesher\'s target smallest angle, 10 degrees by default, more triangles at 0.5 rad',
  { skip }, async () => {
  const count = async (minAngle?: number) => {
    const t = new CadioTessellator();
    await t.init(minAngle === undefined ? {} : { minAngle });
    return (await t.tessellate({ ...req('spheres'), linearDeflection: 0.01 })).indices.length / 3;
  };
  const [none, byDefault, tenDegrees, shaped] = [await count(0), await count(), await count(Math.PI / 18),
    await count(0.5)];
  assert.equal(byDefault, tenDegrees);
  assert.notEqual(byDefault, none);
  assert.ok(shaped > byDefault && shaped > none, `${none}, ${byDefault}, ${shaped}`);
});

test('refinement blocked by a pole ring\'s fixed segment, said with the face and its rounds: bentApex at 0.01; ' +
  'not at 0.05', { skip }, async () => {
  // (At 0.35 rad: at the 10-degree default bentApex at 0.05 asks a ring segment split once too.)
  const t = new CadioTessellator();
  await t.init({ maxDeviationFactor: 0, minAngle: 0.35 });
  const re = /^1 faces with refinement blocked by a fixed ring segment: #\d+ \((\d+) rounds\)$/;
  const blocked = async (d: number) => {
    const r = await t.tessellate({ ...req('cube'), data: new Uint8Array(bentApex().finish().buffer),
      linearDeflection: d });
    return r.diagnostics.map((x) => re.exec(x.message)).find((m) => m)?.[1];
  };
  assert.ok(Number(await blocked(0.01)) >= 2);
  assert.equal(await blocked(0.05), undefined);
});

test('faces with deviations sampled, said: a B-spline dome\'s at its pole; a torus\'s inner half (bounded by its ' +
  'derivatives where its closed form fails), a sphere\'s, a B-spline\'s without a pole not',
  { skip }, async () => {
    const t = await tessellator();
    const re = /^(\d+) faces meshed with their deviation from the surface sampled, not bounded/;
    const sampled = async (data: Uint8Array) => {
      const r = await t.tessellate({ ...req('cube'), data });
      return r.diagnostics.map((x) => re.exec(x.message)).find((m) => m)?.[1];
    };
    assert.equal(await sampled(new Uint8Array(torusOuterHalf().finish().buffer)), undefined);
    assert.equal(await sampled(new Uint8Array(bsplineDome().finish().buffer)), '1');
    assert.equal(await sampled(new Uint8Array(bumpPatch().finish().buffer)), undefined);
    assert.equal(await sampled(new Uint8Array(MODELS.seamCylinder().finish().buffer)), undefined);
    assert.equal(await sampled(new Uint8Array(MODELS.spheres().finish().buffer)), undefined);
  });

test('faces failed to mesh, each by status and cause: a plane with no loops (no natural extent); its sphere meshed',
  { skip }, async () => {
    const t = await tessellator();
    const r = await t.tessellate({ ...req('cube'), data: new Uint8Array(loopless().finish().buffer) });
    assert.equal(r.faces.length, 2);
    assert.equal(r.faces[0]!.count, 0);
    assert.ok(r.faces[1]!.count > 0);
    const m = r.diagnostics.find((x) => x.message.startsWith('faces failed to mesh, by cause: '));
    assert.ok(m, JSON.stringify(r.diagnostics));
    const want = 'faces failed to mesh, by cause: unsupported: no edge loops, and its surface\'s natural extent '
      + 'doesn\'t close (a whole plane, cylinder or cone) 1 (#';
    assert.ok(m.message.startsWith(want), m.message);
  });

test('progress: each face as it starts, throttled to one report per 100 ms; a real part reports its faces', { skip },
  async () => {
    // The reporter's rate, by a clock of its own: of reports at 0, 50, 99, 100, 150 and 250 ms, those at 0, 100, 250.
    let clock = 0;
    const got: TessellationProgress[] = [];
    const report = progressReporter((p) => got.push(p), 100, () => clock);
    for (const [t, row] of [[0, 0], [50, 1], [99, 2], [100, 3], [150, 4], [250, 5]] as const) {
      clock = t;
      report(3, row + 10, row, 0, row, 6);
    }
    assert.deepEqual(got.map((p) => p.row), [0, 3, 5]);
    assert.equal(got[1]!.message, 'face #13 (row 3), first pass, 3 of 6 faces done');
    assert.deepEqual({ ...got[2], message: undefined }, { message: undefined, faceId: 15, row: 5, round: 0,
      facesDone: 5, facesTotal: 6 });
    report(3, 0, 7, 2, 1, 4);
    clock = 400;
    report(3, 0, 7, 2, 1, 4);
    assert.equal(got.at(-1)!.message, 'a face with no id (row 7), split round 2, 1 of 4 faces done');
    clock = 600;
    report(1, 0, -1, 0, 5, 40);
    assert.deepEqual(got.at(-1), { message: 'sampling edges: an edge, 5 of 40 edges and uses done', round: 0 });
    clock = 800;
    report(1, 21, 3, 0, 30, 40);
    assert.deepEqual(got.at(-1), { message: 'sampling edges: a use on face #21 (row 3), 30 of 40 edges and uses done',
      faceId: 21, row: 3, round: 0 });
    // The deviation check after the rounds (part.h's PartProgress::deviation), its face and the faces checked so far.
    clock = 1000;
    report(5, 21, 3, 2, 3, 6);
    assert.deepEqual(got.at(-1), { message: 'checking meshes\' deviation: face #21 (row 3), 3 of 6 faces done',
      faceId: 21, row: 3, round: 2, facesDone: 3, facesTotal: 6 });
    // Across a real part (the cube's 6 faces, quick: the first report only), its first phase on its first face.
    const t = await tessellator();
    const seen: TessellationProgress[] = [];
    const r = await t.tessellate(req('cube'), (p) => seen.push(p));
    assert.ok(r.indices.length > 0);
    assert.ok(seen.length >= 1);
    assert.match(seen[0]!.message, /^making surfaces: face #\d+ \(row 0\), 0 of 6 done$/);
    assert.equal(seen[0]!.faceId, r.faces[0]!.entityId);
  });

test('the origin subtracted in double precision; without edges, none', { skip }, async () => {
  const t = await tessellator();
  const a = await t.tessellate(req('cube'));
  const b = await t.tessellate(req('cube', { origin: [0.5, -1, 2], edges: false }));
  assert.equal(b.edges, undefined);
  assert.deepEqual(b.origin, [0.5, -1, 2]);
  assert.equal(a.positions.length, b.positions.length);
  const o = [0.5, -1, 2];
  for (let i = 0; i < a.positions.length; i++) {
    assert.ok(Math.abs(b.positions[i]! - (a.positions[i]! - o[i % 3]!)) <= 1e-6, `coordinate ${i}`);
  }
});

test('the same part gives the same bytes: twice in one instance, and in a fresh one', { skip }, async () => {
  const t = await tessellator(), u = await tessellator();
  for (const name of ['cube', 'seamCylinder', 'spheres'] as const) {
    const a = bytes(await t.tessellate(req(name))), b = bytes(await t.tessellate(req(name)));
    const c = bytes(await u.tessellate(req(name)));
    assert.equal(a, b, name);
    assert.equal(a, c, name);
  }
});

test('bytes that aren\'t a model: an error, no triangles', { skip }, async () => {
  const t = await tessellator();
  const r = await t.tessellate({ ...req('cube'), data: new Uint8Array(64) });
  assert.equal(r.indices.length, 0);
  assert.match(r.diagnostics[0]!.message, /not a cad-brep model/);
});

test('a loop against its face\'s sense (a projected seam use\'s side contradicting it): meshed, reported with its id',
  { skip }, async () => {
  const t = await tessellator();
  const run = async (model: { finish(): { buffer: ArrayBuffer } }) => t.tessellate({ ...req('cube'),
    data: new Uint8Array(model.finish().buffer) });
  const flipped = await run(seamFlipped());
  assert.ok(flipped.indices.length > 0);
  const d = flipped.diagnostics.find((x) => /loop against the face's sense/.test(x.message));
  assert.ok(d, JSON.stringify(flipped.diagnostics));
  assert.match(d.message, /^1 faces .*: faces \d+$/);
  const valid = await run(seamByInversion());
  assert.ok(!valid.diagnostics.some((x) => /loop against the face's sense/.test(x.message)));
});

test('uses traced sample by sample: a local step that fell back on the global search said, with its edge and why',
  { skip }, async () => {
  // uFoldFar, projection off: its loop's middle 3 mm off its arm, past the tolerance and the spacing, so the samples
  // after its vertex fall back; uFold's 0.07 stays local, nothing said.
  const t = new CadioTessellator();
  await t.init({ projectMissingPcurves: false });
  const said = async (model: { finish(): { buffer: ArrayBuffer } }) => {
    const r = await t.tessellate({ ...req('cube'), data: new Uint8Array(model.finish().buffer), linearDeflection: 0.1,
      angularDeflection: 0.26 });
    return r.diagnostics.find((x) => /fell back on the global search/.test(x.message));
  };
  assert.equal(await said(uFold()), undefined);
  const d = await said(uFold(-3));
  assert.ok(d);
  assert.equal(d.severity, 'info');
  assert.match(d.message, /^\d+ samples of uses traced sample by sample fell back on the global search \(\d+ traced /);
  assert.match(d.message, /edge \d+ at [\d.e-]+ \([\d.e-]+ off\): the local foot farther from the surface/);
});

test('uses without p-curves counted by how they were sampled, said where one fell back to the edge\'s tolerance',
  { skip }, async () => {
  const t = await tessellator();
  const counts = async (l: number) => {
    const r = await t.tessellate({ ...req('cube'), data: new Uint8Array(affineFeetOff().finish().buffer),
      linearDeflection: l, angularDeflection: 0.26 });
    const re = /^(\d+) uses without p-curves: (\d+) projected .*, (\d+) at the edge's .*, (\d+) by/;
    const m = r.diagnostics.map((x) => re.exec(x.message)).find((x) => x);
    return m?.slice(1).map(Number);
  };
  // At 0.05 every use within 2.5e-3 of its feet (the side 1.5e-3 to 2.1e-3 off): nothing said; at 1e-3, the side
  // only at its tolerance (5e-5 under its gap), said.
  assert.equal(await counts(0.05), undefined);
  const c = await counts(1e-3);
  assert.ok(c);
  const [n, within, atTol, inverted] = c as [number, number, number, number];
  assert.deepEqual([n, inverted], [4, 0]);
  assert.ok(atTol >= 1 && within + atTol === 4, `${within}, ${atTol}`);
});

test('init({countInsertions}): the points inserted by what queued them, said; the mesh the same; off by default',
  { skip }, async () => {
    const run = async (on: boolean | undefined, data: Uint8Array) => {
      const t = new CadioTessellator();
      await t.init(on === undefined ? {} : { countInsertions: on });
      return t.tessellate({ ...req('cube'), data, edges: false });
    };
    const counts = (r: TessellationResult) => {
      const d = r.diagnostics.filter((x) => x.message.startsWith(INSERTED_HEAD));
      if (!d.length) return undefined;
      assert.equal(d.length, 1);
      assert.equal(d[0]!.severity, 'info');
      const parts = d[0]!.message.slice(INSERTED_HEAD.length).split(', ');
      assert.deepEqual(parts.map((x) => x.slice(0, x.lastIndexOf(' '))), INSERTED_KINDS);
      return new Map(parts.map((x) => [x.slice(0, x.lastIndexOf(' ')), Number(x.slice(x.lastIndexOf(' ') + 1))]));
    };
    // Independently: a face's vertices off its boundary in its triangles (no seam, pole or split boundary on these).
    const interior = (r: TessellationResult) => {
      let n = 0;
      for (const f of r.faces) {
        const used = new Set<number>(), side = new Map<string, number>();
        for (let k = f.start; k < f.start + f.count; k += 3) {
          for (let c = 0; c < 3; c++) {
            const a = r.indices[k + c]!, b = r.indices[k + (c + 1) % 3]!;
            used.add(a);
            const key = a < b ? `${a},${b}` : `${b},${a}`;
            side.set(key, (side.get(key) ?? 0) + 1);
          }
        }
        const boundary = new Set([...side].filter(([, m]) => m === 1).flatMap(([k]) => k.split(',').map(Number)));
        n += [...used].filter((v) => !boundary.has(v)).length;
      }
      return n;
    };
    const sum = (c: Map<string, number>) => [...c.values()].reduce((a, b) => a + b, 0);
    for (const [name, data] of [['bumpPatch', bumpPatch()], ['knotAtEnd', knotAtEnd()]] as const) {
      const bytesOf = new Uint8Array(data.finish().buffer);
      const on = await run(true, bytesOf), off = await run(false, bytesOf), dflt = await run(undefined, bytesOf);
      const c = counts(on);
      assert.ok(c, name);
      assert.equal(sum(c), interior(on), name);
      assert.ok(sum(c) > 0, name);
      // (A B-spline has no closed form.)
      assert.equal(c.get('deviation in closed form'), 0, name);
      assert.equal(counts(off), undefined), assert.equal(counts(dflt), undefined);
      const strip = (r: TessellationResult) => ({ ...r, diagnostics: r.diagnostics.filter((x) =>
        !x.message.startsWith(INSERTED_HEAD)) });
      assert.equal(bytes(strip(on)), bytes(off), name);
    }
    // A sphere's deviation is in closed form: some by it, none sampled or bounded.
    const sp = counts(await run(true, new Uint8Array(MODELS.spheres().finish().buffer)))!;
    assert.ok(sp.get('deviation in closed form')! > 0);
    assert.equal(sp.get('deviation sampled'), 0), assert.equal(sp.get('deviation bounded'), 0);
  });
